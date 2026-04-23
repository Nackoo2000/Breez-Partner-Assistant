// lib/sqlite.js — SQLite-backed store for all bot state.
//
// Design notes:
// - One file, one process, one writer. better-sqlite3 is fully synchronous,
//   which is exactly what we want: Node's event loop serialises calls, so a
//   transaction is inherently atomic and there are no concurrent writers to
//   fight over. WAL mode lets readers (e.g. the learner jobs) run alongside.
// - All functions return plain values (no Promises) for speed, but are wrapped
//   in async signatures so callers can use them uniformly with awaited code.
// - Cooldown logic is implemented inline via a single SQLite transaction —
//   the transaction IS the atomic claim, no RPC needed.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.BREEZ_DB_PATH
  || path.join(process.cwd(), 'data', 'breez-bot.db');

// Make sure the data directory exists before opening the DB.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ─── Schema ────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_context (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      TEXT    NOT NULL,
    sender_name  TEXT    NOT NULL,
    is_team      INTEGER NOT NULL DEFAULT 0,
    message_text TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_telegram_context_chat_created
    ON telegram_context(chat_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS slack_cooldowns (
    channel_id TEXT NOT NULL,
    person     TEXT NOT NULL,
    posted_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, person)
  );

  CREATE TABLE IF NOT EXISTS routing_log (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    channel_id            TEXT    NOT NULL,
    partner_name          TEXT,
    suggested_person      TEXT    NOT NULL,
    actual_responder      TEXT,
    responded_at          TEXT,
    summary               TEXT,
    partner_message_link  TEXT,
    slack_message_ts      TEXT,
    corrected_person      TEXT,
    correction_reason     TEXT,
    corrected_by          TEXT,
    roy_mentioned_person  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_routing_log_channel_created
    ON routing_log(channel_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_routing_log_created
    ON routing_log(created_at DESC);

  -- Learner bookkeeping: one row per scheduled job, tracks last successful run
  -- so a reboot doesn't cause a double-fire or a skip.
  CREATE TABLE IF NOT EXISTS learner_runs (
    job_name    TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL
  );

  -- Generic key-value scratch. Used by the dead-man switch to persist the
  -- currently-scheduled Slack alert ID across restarts so we can cancel it
  -- on clean boot rather than firing a false-positive alert.
  CREATE TABLE IF NOT EXISTS bot_state (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ─── Lane A + B self-learning tables ────────────────────────────────────
  -- team_availability: OOO / PTO / focus windows per team member. Injected
  -- into the classifier's volatile user turn so Haiku skips OOO people.
  CREATE TABLE IF NOT EXISTS team_availability (
    user_id     TEXT PRIMARY KEY,   -- Slack user ID
    name        TEXT NOT NULL,      -- resolved team name at time of write
    ooo_from    TEXT,               -- ISO date/datetime, NULL = unavailable immediately
    ooo_until   TEXT,               -- ISO date/datetime, NULL = available
    note        TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by  TEXT NOT NULL
  );

  -- summary_corrections: team member said "the summary on card X was wrong".
  -- Reviewed weekly, feeds into summary-prompt tweaks (manual for now).
  CREATE TABLE IF NOT EXISTS summary_corrections (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    routing_log_id    INTEGER,
    original_summary  TEXT,
    corrected_summary TEXT,
    corrected_by      TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ignored_senders: partner-channel senders (Slack or Telegram) whose
  -- messages should be skipped pre-classifier. Team flags these via Lane A:
  -- "@breez-bot ignore messages from @bob-tester".
  CREATE TABLE IF NOT EXISTS ignored_senders (
    sender_id TEXT PRIMARY KEY,       -- slack 'U…' or telegram numeric ID
    platform  TEXT NOT NULL,          -- 'slack' | 'telegram'
    reason    TEXT,
    added_by  TEXT NOT NULL,
    added_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- team_interactions: audit log for every Lane A/B message the bot received.
  -- One row per team→bot message, including parse outcome and what the bot
  -- ended up doing. Feeds weekly digest "what did the team ask of me" column
  -- and is the corpus for auditing the intent parser itself.
  CREATE TABLE IF NOT EXISTS team_interactions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    user_id            TEXT NOT NULL,
    user_name          TEXT,
    lane               TEXT NOT NULL,          -- 'A' = app_mention, 'B' = thread reply
    raw_text           TEXT NOT NULL,
    thread_ts          TEXT,                   -- message the bot reacted to
    parent_ts          TEXT,                   -- for Lane B, the routing card ts
    parsed_intent      TEXT,
    parsed_confidence  REAL,
    parsed_payload     TEXT,                   -- JSON blob
    action_taken       TEXT,                   -- short description
    reaction_used      TEXT                    -- 'check' / 'thinking' / 'eyes' / 'warning'
  );
  CREATE INDEX IF NOT EXISTS idx_team_interactions_created
    ON team_interactions(created_at DESC);

  -- verifier_pending: cards where the classifier hit a trigger condition and
  -- the bot appended a verifier block asking for a team confirmation. Rows are
  -- written when the card is posted, updated when a reaction resolves them.
  -- Unresolved rows older than the timeout window are picked up by the
  -- Monday gap digest.
  CREATE TABLE IF NOT EXISTS verifier_pending (
    routing_id        INTEGER PRIMARY KEY,        -- links 1:1 with routing_log.id
    channel_id        TEXT NOT NULL,
    message_ts        TEXT NOT NULL,              -- top-level card ts
    trigger_reason    TEXT NOT NULL,              -- 'low_conf' | 'close_alt' | 'ooo' | 'unknown_partner'
    options_json      TEXT NOT NULL,              -- [{emoji, person, rationale}, ...]
    partner_name      TEXT,
    posted_at         TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at       TEXT,
    resolved_by_id    TEXT,                        -- Slack user ID of first reactor
    resolved_by_name  TEXT,
    resolved_person   TEXT                         -- team name chosen
  );
  CREATE INDEX IF NOT EXISTS idx_verifier_pending_posted
    ON verifier_pending(posted_at DESC);
`);

// ─── In-place migrations ──────────────────────────────────────────────────
// Add columns to existing tables without requiring a DB recreate. SQLite's
// ALTER TABLE ADD COLUMN is safe for NULLable columns and runs in O(1) on the
// table schema (no row rewrite). Wrapped in try/catch because repeated boots
// would error "duplicate column name" otherwise.
(function runMigrations() {
  try {
    const cols = db.prepare(`PRAGMA table_info(team_availability)`).all();
    if (!cols.some(c => c.name === 'ooo_from')) {
      db.exec(`ALTER TABLE team_availability ADD COLUMN ooo_from TEXT`);
      console.log('[sqlite] migration: added team_availability.ooo_from');
    }
  } catch (err) {
    console.warn('[sqlite] team_availability ooo_from migration skipped:', err.message);
  }
})();

export default db;

// ─── Telegram context ──────────────────────────────────────────────────────

const CONTEXT_LIMIT = 20;

const stmtInsertTelegram = db.prepare(`
  INSERT INTO telegram_context (chat_id, sender_name, is_team, message_text)
  VALUES (?, ?, ?, ?)
`);

const stmtTrimTelegram = db.prepare(`
  DELETE FROM telegram_context
   WHERE chat_id = ?
     AND id NOT IN (
       SELECT id FROM telegram_context
        WHERE chat_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
     )
`);

const stmtFetchTelegramContext = db.prepare(`
  SELECT sender_name, is_team, message_text
    FROM telegram_context
   WHERE chat_id = ?
   ORDER BY created_at DESC, id DESC
   LIMIT ?
`);

export async function storeTelegramMessage({ chatId, senderName, isTeam, messageText }) {
  try {
    const tx = db.transaction(() => {
      stmtInsertTelegram.run(String(chatId), senderName, isTeam ? 1 : 0, messageText);
      stmtTrimTelegram.run(String(chatId), String(chatId), CONTEXT_LIMIT);
    });
    tx();
  } catch (err) {
    console.error(`[sqlite] storeTelegramMessage failed for chat ${chatId}:`, err.message);
  }
}

export async function getTelegramContext(chatId) {
  try {
    const rows = stmtFetchTelegramContext.all(String(chatId), CONTEXT_LIMIT);
    if (!rows.length) return '';
    return rows
      .reverse()
      .map(r => {
        const label = r.is_team ? `Team (${r.sender_name})` : r.sender_name;
        return `[${label}]: ${String(r.message_text).slice(0, 500)}`;
      })
      .join('\n');
  } catch (err) {
    console.error(`[sqlite] getTelegramContext failed for chat ${chatId}:`, err.message);
    return '';
  }
}

// ─── Cooldown (atomic per (channel, person) ─────────────────────────────────
//
// Semantics match the old Postgres RPC: returns true if we "claim" the slot
// (either because nothing exists or because the last post for this
// (channel, person) is older than COOLDOWN_MINUTES), false otherwise.
// Fails open on error — a DB hiccup should never silently drop messages.

const COOLDOWN_MINUTES = 5;

const stmtCooldownSelect = db.prepare(`
  SELECT posted_at FROM slack_cooldowns
   WHERE channel_id = ? AND person = ?
`);

const stmtCooldownUpsert = db.prepare(`
  INSERT INTO slack_cooldowns (channel_id, person, posted_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(channel_id, person)
  DO UPDATE SET posted_at = excluded.posted_at
`);

export async function tryClaimCooldown(channelId, person) {
  try {
    return db.transaction(() => {
      const row = stmtCooldownSelect.get(String(channelId), person);
      if (row) {
        const ageSec = (Date.now() - Date.parse(row.posted_at + 'Z')) / 1000;
        if (ageSec < COOLDOWN_MINUTES * 60) return false;
      }
      stmtCooldownUpsert.run(String(channelId), person);
      return true;
    })();
  } catch (err) {
    console.error('[sqlite] tryClaimCooldown error — failing open:', err.message);
    return true;
  }
}

// ─── Routing log ───────────────────────────────────────────────────────────

const stmtInsertRouting = db.prepare(`
  INSERT INTO routing_log (channel_id, partner_name, suggested_person, summary, partner_message_link)
  VALUES (?, ?, ?, ?, ?)
`);

const stmtUpdateMessageTs = db.prepare(`
  UPDATE routing_log SET slack_message_ts = ? WHERE id = ?
`);

const stmtGetRoutingById = db.prepare(`
  SELECT id, partner_name, suggested_person, summary, partner_message_link, slack_message_ts
    FROM routing_log
   WHERE id = ?
`);

const stmtLatestInChannelSince = db.prepare(`
  SELECT id, roy_mentioned_person, actual_responder
    FROM routing_log
   WHERE channel_id = ? AND created_at >= ?
   ORDER BY created_at DESC, id DESC
   LIMIT 1
`);

const stmtUpdateRoyMention = db.prepare(`
  UPDATE routing_log SET roy_mentioned_person = ? WHERE id = ? AND roy_mentioned_person IS NULL
`);

const stmtUpdateCorrection = db.prepare(`
  UPDATE routing_log
     SET corrected_person  = ?,
         correction_reason = ?,
         corrected_by      = ?
   WHERE id = ?
`);

const stmtUpdateResponse = db.prepare(`
  UPDATE routing_log
     SET actual_responder = ?,
         responded_at     = datetime('now')
   WHERE id = ? AND actual_responder IS NULL
`);

const stmtRoutingStatsSince = db.prepare(`
  SELECT suggested_person, actual_responder, corrected_person, roy_mentioned_person
    FROM routing_log
   WHERE created_at >= ?
`);

function isoMinusMs(ms) {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

export async function logRouting({ channelId, partnerName, suggestedPerson, summary, partnerMessageLink }) {
  try {
    const info = stmtInsertRouting.run(
      String(channelId),
      partnerName,
      suggestedPerson,
      summary ? String(summary).slice(0, 200) : null,
      partnerMessageLink || null,
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    console.error('[sqlite] logRouting error:', err.message);
    return null;
  }
}

export async function storeMessageTs(routingId, ts) {
  if (!routingId || !ts) return;
  try {
    stmtUpdateMessageTs.run(ts, routingId);
  } catch (err) {
    console.error('[sqlite] storeMessageTs error:', err.message);
  }
}

export async function getRoutingById(id) {
  try {
    return stmtGetRoutingById.get(id) || null;
  } catch (err) {
    console.error('[sqlite] getRoutingById error:', err.message);
    return null;
  }
}

export async function recordRoyMention({ channelId, mentionedPerson }) {
  try {
    const since = isoMinusMs(24 * 60 * 60 * 1000);
    const latest = stmtLatestInChannelSince.get(String(channelId), since);
    if (!latest || latest.roy_mentioned_person) return;
    stmtUpdateRoyMention.run(mentionedPerson, latest.id);
  } catch (err) {
    console.error('[sqlite] recordRoyMention error:', err.message);
  }
}

export async function applyCorrection({ routingId, correctedPerson, reason, correctedBy }) {
  try {
    stmtUpdateCorrection.run(correctedPerson, reason || null, correctedBy, routingId);
  } catch (err) {
    console.error('[sqlite] applyCorrection error:', err.message);
  }
}

export async function recordResponse({ channelId, actualPerson }) {
  try {
    const since = isoMinusMs(24 * 60 * 60 * 1000);
    const latest = stmtLatestInChannelSince.get(String(channelId), since);
    if (!latest || latest.actual_responder) return;
    stmtUpdateResponse.run(actualPerson, latest.id);
  } catch (err) {
    console.error('[sqlite] recordResponse error:', err.message);
  }
}

export async function getRoutingStats() {
  try {
    const since = isoMinusMs(30 * 24 * 60 * 60 * 1000);
    const rows = stmtRoutingStatsSince.all(since);
    const resolved = rows.filter(r => r.corrected_person || r.roy_mentioned_person || r.actual_responder);
    if (resolved.length < 10) return null;

    const stats = {};
    for (const row of resolved) {
      const trueResponder = row.corrected_person || row.roy_mentioned_person || row.actual_responder;
      const sp = row.suggested_person;
      if (!stats[sp]) stats[sp] = { correct: 0, total: 0, redirected: {} };
      stats[sp].total++;
      if (sp === trueResponder) {
        stats[sp].correct++;
      } else {
        stats[sp].redirected[trueResponder] = (stats[sp].redirected[trueResponder] || 0) + 1;
      }
    }

    const lines = [];
    for (const [person, s] of Object.entries(stats)) {
      if (s.total < 3) continue;
      const pct = Math.round((s.correct / s.total) * 100);
      const topRedirect = Object.entries(s.redirected).sort((a, b) => b[1] - a[1])[0];
      let line = `- ${person}: ${pct}% accurate (${s.total} cases)`;
      if (pct < 70 && topRedirect && topRedirect[1] >= 2) {
        line += ` — often ${topRedirect[0]} actually responds instead`;
      }
      lines.push(line);
    }

    if (!lines.length) return null;

    return [
      'LIVE ROUTING ACCURACY (last 30 days — who actually responded vs. who bot suggested):',
      ...lines,
      'Adjust your suggestions when patterns show consistent mismatches.',
    ].join('\n');
  } catch (err) {
    console.error('[sqlite] getRoutingStats error:', err.message);
    return null;
  }
}

// ─── Learner bookkeeping ───────────────────────────────────────────────────

const stmtGetLastRun = db.prepare(`SELECT last_run_at FROM learner_runs WHERE job_name = ?`);
const stmtSetLastRun = db.prepare(`
  INSERT INTO learner_runs (job_name, last_run_at) VALUES (?, ?)
  ON CONFLICT(job_name) DO UPDATE SET last_run_at = excluded.last_run_at
`);

export function getLastRun(jobName) {
  const row = stmtGetLastRun.get(jobName);
  return row?.last_run_at ? new Date(row.last_run_at) : null;
}

export function setLastRun(jobName, date = new Date()) {
  stmtSetLastRun.run(jobName, date.toISOString());
}

// ─── Generic key-value (bot_state) ─────────────────────────────────────────
// Used by lib/deadman.js to persist the scheduled alert ID across restarts.

const stmtGetKV = db.prepare(`SELECT value FROM bot_state WHERE key = ?`);
const stmtSetKV = db.prepare(`
  INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
const stmtDeleteKV = db.prepare(`DELETE FROM bot_state WHERE key = ?`);

export function getKV(key) {
  try { return stmtGetKV.get(key)?.value ?? null; }
  catch (err) { console.error('[sqlite] getKV error:', err.message); return null; }
}

export function setKV(key, value) {
  try { stmtSetKV.run(key, value == null ? null : String(value)); }
  catch (err) { console.error('[sqlite] setKV error:', err.message); }
}

export function deleteKV(key) {
  try { stmtDeleteKV.run(key); }
  catch (err) { console.error('[sqlite] deleteKV error:', err.message); }
}

// ─── Team availability (OOO) ───────────────────────────────────────────────

const stmtUpsertAvailability = db.prepare(`
  INSERT INTO team_availability (user_id, name, ooo_from, ooo_until, note, updated_at, updated_by)
  VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
  ON CONFLICT(user_id) DO UPDATE SET
    name = excluded.name,
    ooo_from = excluded.ooo_from,
    ooo_until = excluded.ooo_until,
    note = excluded.note,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
`);
const stmtClearAvailability = db.prepare(`DELETE FROM team_availability WHERE user_id = ?`);
// "Currently OOO" = end date hasn't passed AND (start date is NULL or already began).
// This lets announcements like "Ross on vacation from 27 Apr to 8 May" sit dormant
// in the table until the start date, so partners can still route to Ross up to the 26th.
const stmtActiveOOO = db.prepare(`
  SELECT name, ooo_from, ooo_until, note FROM team_availability
   WHERE ooo_until IS NOT NULL AND ooo_until > datetime('now')
     AND (ooo_from IS NULL OR ooo_from <= datetime('now'))
`);

export async function setTeamAvailability({ userId, name, oooFrom, oooUntil, note, updatedBy }) {
  try {
    stmtUpsertAvailability.run(userId, name, oooFrom || null, oooUntil || null, note || null, updatedBy);
  } catch (err) {
    console.error('[sqlite] setTeamAvailability error:', err.message);
  }
}

export async function clearTeamAvailability(userId) {
  try { stmtClearAvailability.run(userId); }
  catch (err) { console.error('[sqlite] clearTeamAvailability error:', err.message); }
}

/**
 * Returns a short text block describing currently-OOO team members, suitable
 * for injection into the classifier's volatile user turn. Returns '' if
 * nobody is OOO.
 */
export function getActiveOOOBlock() {
  try {
    const rows = stmtActiveOOO.all();
    if (!rows.length) return '';
    const lines = rows.map(r => {
      const until = r.ooo_until?.replace('T', ' ').slice(0, 16) || 'unknown';
      const from = r.ooo_from?.replace('T', ' ').slice(0, 10);
      const windowStr = from ? `${from} through ${until.slice(0, 10)}` : `through ${until}`;
      const notePart = r.note ? ` (${String(r.note).slice(0, 60)})` : '';
      return `- ${r.name} OOO ${windowStr}${notePart}`;
    });
    return `TEAM AVAILABILITY (do not route to anyone on this list):\n${lines.join('\n')}`;
  } catch (err) {
    console.error('[sqlite] getActiveOOOBlock error:', err.message);
    return '';
  }
}

// ─── Summary corrections ──────────────────────────────────────────────────

const stmtInsertSummaryCorrection = db.prepare(`
  INSERT INTO summary_corrections (routing_log_id, original_summary, corrected_summary, corrected_by)
  VALUES (?, ?, ?, ?)
`);

export async function recordSummaryCorrection({ routingLogId, originalSummary, correctedSummary, correctedBy }) {
  try {
    stmtInsertSummaryCorrection.run(
      routingLogId || null,
      originalSummary || null,
      correctedSummary || null,
      correctedBy,
    );
  } catch (err) {
    console.error('[sqlite] recordSummaryCorrection error:', err.message);
  }
}

// ─── Ignored senders (noise filter) ───────────────────────────────────────

const stmtUpsertIgnored = db.prepare(`
  INSERT INTO ignored_senders (sender_id, platform, reason, added_by)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(sender_id) DO UPDATE SET
    platform = excluded.platform,
    reason = excluded.reason,
    added_by = excluded.added_by,
    added_at = datetime('now')
`);
const stmtDeleteIgnored = db.prepare(`DELETE FROM ignored_senders WHERE sender_id = ?`);
const stmtIsIgnored = db.prepare(`SELECT 1 FROM ignored_senders WHERE sender_id = ?`);

export async function addIgnoredSender({ senderId, platform, reason, addedBy }) {
  try { stmtUpsertIgnored.run(senderId, platform, reason || null, addedBy); }
  catch (err) { console.error('[sqlite] addIgnoredSender error:', err.message); }
}

export async function removeIgnoredSender(senderId) {
  try { stmtDeleteIgnored.run(senderId); }
  catch (err) { console.error('[sqlite] removeIgnoredSender error:', err.message); }
}

export function isIgnoredSender(senderId) {
  try { return !!stmtIsIgnored.get(senderId); }
  catch { return false; }
}

// ─── Team interactions audit log (Lane A + B) ─────────────────────────────

const stmtInsertInteraction = db.prepare(`
  INSERT INTO team_interactions
    (user_id, user_name, lane, raw_text, thread_ts, parent_ts,
     parsed_intent, parsed_confidence, parsed_payload, action_taken, reaction_used)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export async function logTeamInteraction({
  userId, userName, lane, rawText, threadTs, parentTs,
  parsedIntent, parsedConfidence, parsedPayload, actionTaken, reactionUsed,
}) {
  try {
    stmtInsertInteraction.run(
      userId,
      userName || null,
      lane,
      String(rawText || '').slice(0, 2000),
      threadTs || null,
      parentTs || null,
      parsedIntent || null,
      typeof parsedConfidence === 'number' ? parsedConfidence : null,
      parsedPayload ? JSON.stringify(parsedPayload).slice(0, 4000) : null,
      actionTaken || null,
      reactionUsed || null,
    );
    return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  } catch (err) {
    console.error('[sqlite] logTeamInteraction error:', err.message);
    return null;
  }
}

// ─── Bot routing card lookup (for Lane B thread detection) ────────────────

const stmtRoutingByMessageTs = db.prepare(`
  SELECT id, partner_name, suggested_person, summary, channel_id
    FROM routing_log
   WHERE slack_message_ts = ?
   LIMIT 1
`);

export function getRoutingByMessageTs(ts) {
  try { return stmtRoutingByMessageTs.get(ts) || null; }
  catch { return null; }
}

// ─── Correction volume (for event-driven learner trigger) ─────────────────
//
// Returns how many corrections have landed since the last pattern_analysis
// run. Used by the event-driven trigger to decide whether enough new signal
// exists to justify an incremental learner run.
const stmtCorrectionsSince = db.prepare(`
  SELECT COUNT(*) AS n,
         COUNT(DISTINCT partner_name) AS partners,
         MAX(CASE WHEN partner_name IS NOT NULL THEN (
           SELECT COUNT(*) FROM routing_log rl2
            WHERE rl2.partner_name = routing_log.partner_name
              AND rl2.corrected_person IS NOT NULL
              AND rl2.created_at >= ?
         ) ELSE 0 END) AS max_per_partner
    FROM routing_log
   WHERE corrected_person IS NOT NULL
     AND created_at >= ?
`);

export function getCorrectionsSince(sinceIso) {
  try {
    const row = stmtCorrectionsSince.get(sinceIso, sinceIso);
    return { n: row?.n || 0, partners: row?.partners || 0, maxPerPartner: row?.max_per_partner || 0 };
  } catch (err) {
    console.error('[sqlite] getCorrectionsSince error:', err.message);
    return { n: 0, partners: 0, maxPerPartner: 0 };
  }
}

// ─── Weekly digest metrics (latency + unanswered) ─────────────────────────

const stmtWeeklyMetrics = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN actual_responder IS NOT NULL OR corrected_person IS NOT NULL
              OR roy_mentioned_person IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
    SUM(CASE WHEN responded_at IS NOT NULL THEN 1 ELSE 0 END) AS answered,
    SUM(CASE WHEN responded_at IS NULL AND created_at < datetime('now', '-1 day') THEN 1 ELSE 0 END) AS stale_unanswered
  FROM routing_log
   WHERE created_at >= ?
`);

const stmtLatencyRows = db.prepare(`
  SELECT actual_responder,
         (julianday(responded_at) - julianday(created_at)) * 86400.0 AS latency_sec
    FROM routing_log
   WHERE created_at >= ?
     AND responded_at IS NOT NULL
     AND actual_responder IS NOT NULL
`);

export function getWeeklyMetrics(sinceIso) {
  try {
    const row = stmtWeeklyMetrics.get(sinceIso) || {};
    const latencyRows = stmtLatencyRows.all(sinceIso);

    // median response time, overall + per person
    const allLat = latencyRows.map(r => r.latency_sec).filter(n => Number.isFinite(n));
    const overallMedianSec = median(allLat);

    const byPerson = {};
    for (const r of latencyRows) {
      if (!byPerson[r.actual_responder]) byPerson[r.actual_responder] = [];
      byPerson[r.actual_responder].push(r.latency_sec);
    }
    const perPersonMedianSec = Object.fromEntries(
      Object.entries(byPerson).map(([p, arr]) => [p, median(arr)]),
    );

    return {
      total: row.total || 0,
      resolved: row.resolved || 0,
      answered: row.answered || 0,
      staleUnanswered: row.stale_unanswered || 0,
      overallMedianSec,
      perPersonMedianSec,
    };
  } catch (err) {
    console.error('[sqlite] getWeeklyMetrics error:', err.message);
    return { total: 0, resolved: 0, answered: 0, staleUnanswered: 0, overallMedianSec: null, perPersonMedianSec: {} };
  }
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Known-partner lookup (for verifier unknown_partner trigger) ─────────

const stmtKnownPartnerCount = db.prepare(`
  SELECT COUNT(*) AS n FROM routing_log
   WHERE partner_name = ? AND created_at >= datetime('now', '-90 days')
`);

export function isKnownPartner(name) {
  if (!name) return false;
  try { return (stmtKnownPartnerCount.get(name)?.n || 0) >= 1; }
  catch { return true; }  // fail open — don't escalate on a DB error
}

// ─── Verifier pending cards ────────────────────────────────────────────────

const stmtInsertVerifier = db.prepare(`
  INSERT INTO verifier_pending
    (routing_id, channel_id, message_ts, trigger_reason, options_json, partner_name)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(routing_id) DO UPDATE SET
    channel_id = excluded.channel_id,
    message_ts = excluded.message_ts,
    trigger_reason = excluded.trigger_reason,
    options_json = excluded.options_json,
    partner_name = excluded.partner_name,
    posted_at = datetime('now'),
    resolved_at = NULL,
    resolved_by_id = NULL,
    resolved_by_name = NULL,
    resolved_person = NULL
`);
const stmtGetVerifierByMessageTs = db.prepare(`
  SELECT routing_id, channel_id, message_ts, trigger_reason, options_json, partner_name,
         posted_at, resolved_at, resolved_by_id, resolved_by_name, resolved_person
    FROM verifier_pending
   WHERE message_ts = ?
`);
const stmtResolveVerifier = db.prepare(`
  UPDATE verifier_pending
     SET resolved_at = datetime('now'),
         resolved_by_id = ?,
         resolved_by_name = ?,
         resolved_person = ?
   WHERE routing_id = ? AND resolved_at IS NULL
`);
const stmtUnresolvedVerifier = db.prepare(`
  SELECT routing_id, channel_id, message_ts, trigger_reason, options_json, partner_name, posted_at
    FROM verifier_pending
   WHERE resolved_at IS NULL AND posted_at >= ?
   ORDER BY posted_at DESC
`);
const stmtVerifierWithinToday = db.prepare(`
  SELECT COUNT(*) AS n FROM verifier_pending
   WHERE posted_at >= datetime('now', '-24 hours')
`);

export function recordVerifierPending({ routingId, channelId, messageTs, triggerReason, options, partnerName }) {
  try {
    stmtInsertVerifier.run(
      routingId, String(channelId), String(messageTs),
      String(triggerReason),
      JSON.stringify(options || []),
      partnerName || null,
    );
  } catch (err) {
    console.error('[sqlite] recordVerifierPending error:', err.message);
  }
}

export function getVerifierByMessageTs(ts) {
  try {
    const row = stmtGetVerifierByMessageTs.get(ts);
    if (!row) return null;
    let options = [];
    try { options = JSON.parse(row.options_json || '[]'); } catch { options = []; }
    return { ...row, options };
  } catch { return null; }
}

export function resolveVerifier({ routingId, resolvedById, resolvedByName, resolvedPerson }) {
  try {
    const info = stmtResolveVerifier.run(
      resolvedById || null,
      resolvedByName || null,
      resolvedPerson || null,
      routingId,
    );
    return info.changes > 0;
  } catch (err) {
    console.error('[sqlite] resolveVerifier error:', err.message);
    return false;
  }
}

export function getUnresolvedVerifier(sinceIso) {
  try {
    return stmtUnresolvedVerifier.all(sinceIso).map(r => {
      let options = [];
      try { options = JSON.parse(r.options_json || '[]'); } catch { options = []; }
      return { ...r, options };
    });
  } catch (err) {
    console.error('[sqlite] getUnresolvedVerifier error:', err.message);
    return [];
  }
}

export function countVerifierPast24h() {
  try { return stmtVerifierWithinToday.get()?.n || 0; }
  catch { return 0; }
}

// ─── Retention ─────────────────────────────────────────────────────────────
// Called weekly from the learner's Monday pattern-analysis job, after the
// digest has already consumed the data. Keeps the DB small so classifier
// memory-retrieval queries stay fast. 180 days is long enough that a quarterly
// review still has history to look at.

export function pruneOldRows(days = 180) {
  const cutoff = `-${days} days`;
  let routingDeleted = 0;
  let verifierDeleted = 0;
  try {
    routingDeleted = db.prepare(
      `DELETE FROM routing_log WHERE created_at < datetime('now', ?)`
    ).run(cutoff).changes;
  } catch (err) {
    console.error('[sqlite] pruneOldRows routing_log failed:', err.message);
  }
  try {
    verifierDeleted = db.prepare(
      `DELETE FROM verifier_pending WHERE posted_at < datetime('now', ?)`
    ).run(cutoff).changes;
  } catch (err) {
    console.error('[sqlite] pruneOldRows verifier_pending failed:', err.message);
  }
  return { routingDeleted, verifierDeleted };
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────

export function closeDb() {
  try { db.close(); } catch { /* already closed */ }
}
