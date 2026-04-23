// lib/learner.js — autonomous learning loop (three scheduled jobs).
//
// The fourth learner signal (real-time confidence flag on low-quality
// routings) lives in lib/claude.js, because it's a classify-time decision,
// not a scheduled job. This file handles the three that are scheduled:
//
//   1. Pattern analysis      — Sunday 23:00 UTC
//      Reads the last 30 days of routing decisions + corrections and asks
//      Claude Sonnet to propose a fresh set of refinement rules. The current
//      rules file is archived first, then overwritten.
//
//   2. Weekly digest         — Monday 08:00 UTC
//      Posts a short performance summary into the internal channel so the
//      team can see the bot's accuracy without opening a dashboard.
//
//   3. Monthly expertise check — First Monday 07:00 UTC
//      Cross-references GitHub activity (last 30 days) against each team
//      member's handles description. When someone has clearly taken over an
//      area (3× or more activity vs. the currently-listed owner), the bot
//      posts a proposal into the internal channel — it never auto-edits
//      config.js. A human reviewer applies the change.
//
// Scheduling is explicit and idempotent. Every 60 seconds a tick function
// computes, for each job, the most recent UTC wall-clock fire time that is
// earlier than "now." If the persisted last_run_at is older than that target,
// the job runs and records the new last_run_at. This means:
//   - Reboots never cause drift (the check is against wall time, not uptime).
//   - A missed fire (bot was down) catches up on the next tick.
//   - A job is never double-fired — last_run_at is the guard.
//
// LEARNER_DISABLED=true in the environment skips every tick. Useful for
// draining a problem week without redeploying.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import db, {
  getLastRun, setLastRun,
  getWeeklyMetrics, getCorrectionsSince,
  pruneOldRows,
} from './sqlite.js';
import { postMessage } from './slack.js';
import { reloadLearnedRules } from './claude.js';
import { TEAM, ASSISTANT_CHANNEL_ID } from '../config.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RULES_PATH = process.env.BREEZ_ROUTING_RULES_PATH
  || path.join(process.cwd(), 'data', 'routing_rules.json');
const RULES_ARCHIVE_DIR = path.join(path.dirname(RULES_PATH), 'routing_rules.archive');

const TICK_INTERVAL_MS = 60_000;

let tickTimer = null;
let stopping = false;

// ─── Job schedules (UTC) ──────────────────────────────────────────────────

/**
 * Most-recent UTC fire for "every Sunday at 23:00". Returns null if now is
 * before the very first possible fire (never happens in practice).
 */
function lastSundayAt(hourUtc, now = new Date()) {
  // Sunday = 0 in getUTCDay()
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    hourUtc, 0, 0, 0,
  ));
  const dayOffset = (d.getUTCDay()); // 0 on Sunday
  // Step back to Sunday
  d.setUTCDate(d.getUTCDate() - dayOffset);
  // If that Sunday @ hourUtc is still in the future (shouldn't happen but be safe), back another week
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

function lastMondayAt(hourUtc, now = new Date()) {
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    hourUtc, 0, 0, 0,
  ));
  // Monday = 1; if today isn't Monday, step back to the previous Monday
  const dayOffset = ((d.getUTCDay() + 6) % 7); // 0 on Monday
  d.setUTCDate(d.getUTCDate() - dayOffset);
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

const JOBS = [
  {
    name: 'pattern_analysis',
    description: 'Sunday 23:00 UTC — propose routing rule refinements',
    lastFireTime: now => lastSundayAt(23, now),
    run: runPatternAnalysis,
  },
  {
    name: 'weekly_digest',
    description: 'Monday 08:00 UTC — post performance digest',
    lastFireTime: now => lastMondayAt(8, now),
    run: runWeeklyDigest,
  },
];

// ─── Tick loop ────────────────────────────────────────────────────────────

export function startLearner(slackClient) {
  if (process.env.LEARNER_DISABLED === 'true') {
    console.log('[learner] LEARNER_DISABLED=true — scheduler not started');
    return () => {};
  }
  stopping = false;

  const tick = async () => {
    if (stopping) return;
    const now = new Date();
    for (const job of JOBS) {
      if (stopping) break;
      try {
        const target = job.lastFireTime(now);
        const last = getLastRun(job.name);
        if (!last || last.getTime() < target.getTime()) {
          console.log(`[learner] running ${job.name} (target fire: ${target.toISOString()})`);
          await job.run(slackClient);
          setLastRun(job.name, now);
          console.log(`[learner] ${job.name} completed`);
        }
      } catch (err) {
        console.error(`[learner] ${job.name} error:`, err.message);
      }
    }
    if (!stopping) tickTimer = setTimeout(tick, TICK_INTERVAL_MS);
  };

  // Fire the first tick on next event loop turn (not inside startLearner itself)
  tickTimer = setTimeout(tick, 1_000);
  console.log('[learner] scheduler started');

  return () => {
    stopping = true;
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
  };
}

// ═══ Job 1: pattern analysis ═══════════════════════════════════════════════

async function runPatternAnalysis(slackClient) {
  const since = isoDaysAgo(30);
  const rows = db.prepare(`
    SELECT partner_name, suggested_person, actual_responder, corrected_person,
           roy_mentioned_person, correction_reason, summary, created_at
      FROM routing_log
     WHERE created_at >= ?
     ORDER BY created_at DESC
  `).all(since);

  // Keep only rows we can actually learn from
  const resolved = rows.filter(r => r.corrected_person || r.roy_mentioned_person || r.actual_responder);
  if (resolved.length < 10) {
    console.log(`[learner] pattern_analysis: only ${resolved.length} resolved rows — skipping (need ≥10)`);
    return;
  }

  const digest = resolved.map(r => {
    const actual = r.corrected_person || r.roy_mentioned_person || r.actual_responder;
    const reasonPart = r.correction_reason ? ` | reason: ${r.correction_reason}` : '';
    // Flag verifier-sourced corrections so Sonnet knows these are high-trust
    // (a human verifier explicitly clicked this answer, not just inferred).
    const verifierTag = (r.correction_reason && /^verifier:/.test(r.correction_reason))
      ? (r.corrected_by === 'Roy' ? ' [VERIFIED BY ROY — authoritative]' : ' [team-verified]')
      : '';
    return `- [${r.partner_name}] suggested: ${r.suggested_person} | actual: ${actual}${reasonPart}${verifierTag} | summary: ${r.summary || '(none)'}`;
  }).join('\n');

  const existingRules = readExistingRules();
  const existingBlock = existingRules.length
    ? `\n\nExisting refinements (you may replace or extend these):\n${existingRules.map(r => `- ${r}`).join('\n')}`
    : '';

  const prompt = `You analyse a Slack routing bot's recent decisions and propose short refinement rules to improve future routing.

Team members and their areas:
${Object.values(TEAM).map(m => `- ${m.name}: ${m.handles}`).join('\n')}

Last 30 days — what the bot suggested vs. who actually handled it (or who was manually reassigned to):

${digest}${existingBlock}

Propose up to 8 SHORT refinement rules, each one sentence, that capture clear mismatches. Examples of good rules:
- "When a LightningPay partner asks about failed payments, route to Daniel instead of Ross."
- "Reassign requests involving Solana bridging to Daniel even when the partner mentions the SDK."

Weight the evidence:
- Rows tagged [VERIFIED BY ROY — authoritative] are high-trust: one such row counts as strongly as ~3 regular corrections. Propose a rule backed by even a single Roy-verified row if the pattern is clear.
- Rows tagged [team-verified] are moderately high-trust: one counts as ~2 regular corrections.
- Regular rows (no tag) — require ≥ 2 clear data points before proposing a rule.

If the data doesn't justify any new rule, output an empty rules array.

Output strict JSON only, no other text:
{"rules": ["rule 1", "rule 2", ...], "notes": "1-2 sentence summary of what you observed"}`;

  let response;
  try {
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.error('[learner] pattern_analysis Claude error:', err.message);
    return;
  }

  const text = response.content[0]?.text || '{}';
  let parsed;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (err) {
    console.error('[learner] pattern_analysis parse error:', err.message);
    return;
  }

  const rules = Array.isArray(parsed.rules)
    ? parsed.rules.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim()).slice(0, 12)
    : [];
  const notes = typeof parsed.notes === 'string' ? parsed.notes.trim() : '';

  // Archive current rules file before overwriting so a bad week is recoverable
  archiveCurrentRules();

  const payload = {
    generated_at: new Date().toISOString(),
    source: `pattern_analysis over ${resolved.length} resolved routings (last 30 days)`,
    notes,
    rules,
  };
  fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
  fs.writeFileSync(RULES_PATH, JSON.stringify(payload, null, 2), 'utf8');

  // Hot-reload in-process — new rules take effect on the very next classify
  // without a pm2 restart or any socket disconnect. Failure here is non-fatal;
  // worst case is the new rules don't activate until the next boot, which is
  // exactly the old behavior.
  let reloadNote = 'applied live (hot-reload)';
  try {
    const r = reloadLearnedRules();
    if (!r.changed) reloadNote = 'no semantic change';
  } catch (err) {
    console.error('[learner] hot-reload failed:', err.message);
    reloadNote = 'hot-reload failed — will activate on next restart';
  }

  const diff = rules.length - existingRules.length;
  const diffStr = diff === 0 ? 'no change in count' : (diff > 0 ? `+${diff}` : String(diff));
  const summaryMsg = [
    `:brain: *Pattern analysis* — ${resolved.length} resolved routings analysed.`,
    notes ? `> ${notes}` : '',
    `*Rules:* ${rules.length} (${diffStr}). New rules file written; old file archived. ${reloadNote}.`,
  ].filter(Boolean).join('\n');
  await postMessage(slackClient, ASSISTANT_CHANNEL_ID, summaryMsg).catch(() => {});

  // Retention: now that the digest has consumed all resolved routings, drop
  // anything older than 180 days. Keeps the DB small so memory-retrieval stays
  // fast long-term. Failure here is non-fatal and logged inside pruneOldRows.
  try {
    const { routingDeleted, verifierDeleted } = pruneOldRows(180);
    if (routingDeleted || verifierDeleted) {
      console.log(`[learner] pruned ${routingDeleted} routing_log + ${verifierDeleted} verifier_pending rows older than 180 days`);
    }
  } catch (err) {
    console.error('[learner] prune failed:', err.message);
  }
}

function readExistingRules() {
  try {
    if (!fs.existsSync(RULES_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    return Array.isArray(data?.rules) ? data.rules.filter(r => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

function archiveCurrentRules() {
  try {
    if (!fs.existsSync(RULES_PATH)) return;
    fs.mkdirSync(RULES_ARCHIVE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(RULES_ARCHIVE_DIR, `routing_rules.${ts}.json`);
    fs.copyFileSync(RULES_PATH, target);
  } catch (err) {
    console.warn('[learner] could not archive rules file:', err.message);
  }
}

// ═══ Job 2: weekly digest ═════════════════════════════════════════════════

async function runWeeklyDigest(slackClient) {
  const since = isoDaysAgo(7);
  const rows = db.prepare(`
    SELECT suggested_person, actual_responder, corrected_person, roy_mentioned_person
      FROM routing_log
     WHERE created_at >= ?
  `).all(since);

  const total = rows.length;
  if (total === 0) {
    await postMessage(slackClient, ASSISTANT_CHANNEL_ID,
      ':bar_chart: *Weekly digest* — no routings posted in the last 7 days.').catch(() => {});
    return;
  }

  const resolved = rows.filter(r => r.corrected_person || r.roy_mentioned_person || r.actual_responder);
  const corrected = rows.filter(r => r.corrected_person).length;

  let correct = 0;
  const redirectCounts = {};
  for (const r of resolved) {
    const actual = r.corrected_person || r.roy_mentioned_person || r.actual_responder;
    if (actual === r.suggested_person) correct++;
    else redirectCounts[`${r.suggested_person}→${actual}`] = (redirectCounts[`${r.suggested_person}→${actual}`] || 0) + 1;
  }

  const accuracy = resolved.length > 0 ? Math.round((correct / resolved.length) * 100) : null;
  const topMisroutes = Object.entries(redirectCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Latency + unanswered-rate metrics (DB-only, no API cost)
  const metrics = getWeeklyMetrics(since);
  const unansweredPct = metrics.total > 0
    ? Math.round((metrics.staleUnanswered / metrics.total) * 100)
    : 0;
  const fmtLatency = (sec) => {
    if (sec == null) return null;
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  };

  const lines = [
    ':bar_chart: *Weekly digest — last 7 days*',
    `• Total routings: *${total}*`,
    `• Resolved (we know who actually handled it): *${resolved.length}*`,
    `• Unanswered >24h: *${metrics.staleUnanswered}* (${unansweredPct}%)`,
    `• Manual reassigns: *${corrected}*`,
    accuracy !== null ? `• Routing accuracy: *${accuracy}%*` : '• Routing accuracy: _not enough data yet_',
    metrics.overallMedianSec != null
      ? `• Median response latency: *${fmtLatency(metrics.overallMedianSec)}*`
      : '• Median response latency: _no answered cards yet_',
  ];
  if (topMisroutes.length > 0) {
    lines.push('• Top misroutes:');
    for (const [pair, n] of topMisroutes) lines.push(`    — ${pair}: ${n}×`);
  }

  // Per-person latency (only people with ≥2 answered cards, to avoid noise)
  const perPersonEntries = Object.entries(metrics.perPersonMedianSec || {}).filter(([, s]) => s != null);
  if (perPersonEntries.length > 0) {
    lines.push('• Per-person median latency:');
    for (const [p, s] of perPersonEntries.sort((a, b) => a[1] - b[1])) {
      lines.push(`    — ${p}: ${fmtLatency(s)}`);
    }
  }

  await postMessage(slackClient, ASSISTANT_CHANNEL_ID, lines.join('\n')).catch(() => {});
}

// NOTE: The "gap digest" (surfaced unresolved verifier cards) and the monthly
// GitHub expertise check were removed intentionally. The bot learns primarily
// from what the team ACTUALLY does — actual_responder, roy_mentioned_person,
// and Reassign/Lane B corrections — all of which feed the Sunday pattern
// analysis. Verifier reactions are a bonus fast-path signal when someone
// clicks, but leaving cards unreacted is not a learning failure, so nagging
// about them was removed. If we ever want a GitHub activity view, run the
// /calibrate-routing-assignments skill manually.

// ─── Event-driven incremental trigger ─────────────────────────────────────
//
// Called whenever a correction lands (reassign modal submit OR Lane B
// THIS_CARD_OVERRIDE / INQUIRY_FLIP). Fires pattern_analysis off-schedule
// when signal has piled up faster than the weekly cadence can absorb.
//
// Fires when, since the last pattern_analysis run:
//   - ≥ 5 total corrections, OR
//   - ≥ 2 corrections on the same partner
//
// Debounced — won't run more often than once every 2 hours, so a burst of
// corrections in rapid succession doesn't trigger multiple runs.

let lastIncrementalRunAt = 0;
const MIN_INCREMENTAL_GAP_MS = 2 * 60 * 60 * 1000;  // 2h debounce

export async function maybeRunIncrementalLearner(slackClient) {
  if (process.env.LEARNER_DISABLED === 'true') return;
  if (Date.now() - lastIncrementalRunAt < MIN_INCREMENTAL_GAP_MS) return;

  const lastRun = getLastRun('pattern_analysis');
  const sinceIso = (lastRun || new Date(Date.now() - 7 * 24 * 3600 * 1000))
    .toISOString().replace('T', ' ').slice(0, 19);

  const { n, maxPerPartner } = getCorrectionsSince(sinceIso);
  const shouldRun = n >= 5 || maxPerPartner >= 2;
  if (!shouldRun) return;

  lastIncrementalRunAt = Date.now();
  console.log(`[learner] event-driven trigger firing — ${n} corrections since last run (max ${maxPerPartner} per partner)`);
  try {
    await runPatternAnalysis(slackClient);
    setLastRun('pattern_analysis', new Date());
  } catch (err) {
    console.error('[learner] incremental run failed:', err.message);
  }
}

// ─── Manual trigger (used by `npm run learner:run-now <name>`) ────────────
//
// Bypasses the scheduler's last_run_at guard on purpose — this is for ops to
// re-run a digest or pattern analysis out-of-band. Updates last_run_at so the
// scheduler doesn't immediately fire it again on its own tick.
export async function runJobByName(name, slackClient) {
  const job = JOBS.find(j => j.name === name);
  if (!job) {
    const valid = JOBS.map(j => j.name).join(', ');
    throw new Error(`unknown learner job '${name}'. Valid: ${valid}`);
  }
  console.log(`[learner] manual trigger: ${job.name}`);
  await job.run(slackClient);
  setLastRun(job.name, new Date());
  console.log(`[learner] ${job.name} completed`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
