// lib/team_signals.js — dispatches parsed intents (from lib/intent_parser.js)
// to the right persistence layer, returning an ack spec the Slack layer
// renders as a reaction + optional thread reply.
//
// Design invariants:
//   - Every dispatch returns { reaction, threadText | null, action }.
//   - reaction is one of: 'white_check_mark' | 'thinking_face' | 'eyes' | 'warning'
//   - threadText is null for silent acks (ACK), a short confirm line for ✅,
//     a question with options for 🤔 or ⚠️.
//   - No direct Slack calls here. The caller in index.js handles Slack I/O.
//
// "Decided-first-wins" for clarifications is handled outside this file — the
// dispatcher treats every call as a fresh decision. Later overrides come back
// in through Lane A as new intent messages, which overwrite prior state.

import fs from 'node:fs';
import path from 'node:path';
import { TEAM, TEAM_ID_BY_NAME } from '../config.js';
import {
  setTeamAvailability, clearTeamAvailability,
  recordSummaryCorrection,
  addIgnoredSender, removeIgnoredSender,
  applyCorrection, getRoutingById,
} from './sqlite.js';
import { reloadLearnedRules } from './claude.js';

const RULES_PATH = process.env.BREEZ_ROUTING_RULES_PATH
  || path.join(process.cwd(), 'data', 'routing_rules.json');

// ─── Rules-file helpers ───────────────────────────────────────────────────

function loadRulesFile() {
  try {
    if (!fs.existsSync(RULES_PATH)) return { generated_at: null, source: 'team-proposed', rules: [], team_proposed: [] };
    const raw = fs.readFileSync(RULES_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      generated_at: data.generated_at || null,
      source: data.source || 'pattern_analysis',
      notes: data.notes || '',
      rules: Array.isArray(data.rules) ? data.rules : [],
      team_proposed: Array.isArray(data.team_proposed) ? data.team_proposed : [],
    };
  } catch (err) {
    console.error('[team_signals] loadRulesFile error:', err.message);
    return { generated_at: null, source: 'team-proposed', rules: [], team_proposed: [] };
  }
}

function saveRulesFile(data) {
  try {
    fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
    fs.writeFileSync(RULES_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[team_signals] saveRulesFile error:', err.message);
    return false;
  }
}

function appendTeamRule(ruleText, addedBy) {
  const data = loadRulesFile();
  // Dedup on normalised text
  const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  const already = [...(data.rules || []), ...(data.team_proposed || [])].some(r => {
    const t = typeof r === 'string' ? r : r?.text;
    return t && norm(t) === norm(ruleText);
  });
  if (already) return { added: false };

  const entry = { text: ruleText, added_by: addedBy, added_at: new Date().toISOString() };
  data.team_proposed = [...(data.team_proposed || []), entry];
  // Also append to `rules` so the classifier picks it up on next reload.
  data.rules = [...(data.rules || []), ruleText];
  data.generated_at = new Date().toISOString();
  saveRulesFile(data);
  return { added: true };
}

// ─── Intent → ack spec ────────────────────────────────────────────────────

/**
 * Resolve a free-text person reference to a canonical team name (or null).
 * Handles exact-case, lower-case, and nicknames by checking config.TEAM names.
 */
function resolvePerson(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const lower = ref.trim().toLowerCase();
  for (const name of Object.keys(TEAM_ID_BY_NAME)) {
    if (name.toLowerCase() === lower) return name;
  }
  return null;
}

function nameToUserId(name) {
  return name ? (TEAM_ID_BY_NAME[name] || null) : null;
}

/**
 * Dispatch a parsed intent. Returns:
 *   { reaction, threadText, action }
 * where `action` is a short string for audit logging.
 */
export async function dispatchIntent({ parsed, senderName, senderUserId, lane, cardContext }) {
  const { intent, payload, confidence } = parsed;

  switch (intent) {
    case 'ROUTING_RULE': return handleRoutingRule(payload, senderName);
    case 'AVAILABILITY': return handleAvailability(payload, senderName, senderUserId);
    case 'SUMMARY_FEEDBACK': return handleSummaryFeedback(payload, senderName, cardContext);
    case 'INQUIRY_FLIP': return handleInquiryFlip(payload, cardContext);
    case 'NOISE_FILTER': return handleNoiseFilter(payload, senderName);
    case 'THIS_CARD_OVERRIDE': return handleThisCardOverride(payload, senderName, cardContext);
    case 'ACK': return { reaction: 'eyes', threadText: null, action: 'ack' };
    case 'UNCLEAR':
    default:
      return handleUnclear(payload, confidence, lane);
  }
}

function handleRoutingRule(payload, senderName) {
  const rule = String(payload?.rule_text || '').trim();
  if (!rule) {
    return {
      reaction: 'thinking_face',
      threadText: "I couldn't pull a clear rule out of that. Could you phrase it like \"when X, route to Y\"?",
      action: 'routing_rule_empty',
    };
  }
  const { added } = appendTeamRule(rule, senderName);
  try { reloadLearnedRules(); } catch {}
  if (!added) {
    return {
      reaction: 'eyes',
      threadText: `I already have a rule matching that. No change.`,
      action: 'routing_rule_duplicate',
    };
  }
  return {
    reaction: 'white_check_mark',
    threadText: `Saved rule: _${rule}_. It takes effect on the next classification.`,
    action: 'routing_rule_added',
  };
}

function handleAvailability(payload, senderName, senderUserId) {
  // Resolve the person: explicit payload.person wins, else infer from sender ("I'm out…")
  let name = resolvePerson(payload?.person);
  let userId = nameToUserId(name);
  if (!name) {
    // Fall back to the sender themselves if they're on the team
    const senderName0 = senderName;
    name = resolvePerson(senderName0);
    userId = name ? nameToUserId(name) : senderUserId;
  }
  if (!name || !userId) {
    return {
      reaction: 'thinking_face',
      threadText: "I couldn't tell who this availability is about. Include a name, e.g. \"Jesse is out until Thursday\".",
      action: 'availability_no_person',
    };
  }

  const clear = payload?.clear === true;
  if (clear) {
    clearTeamAvailability(userId).catch(() => {});
    return {
      reaction: 'white_check_mark',
      threadText: `Marked ${name} as available again.`,
      action: 'availability_cleared',
    };
  }

  const oooFrom = payload?.ooo_from && /^\d{4}-\d{2}-\d{2}/.test(String(payload.ooo_from))
    ? String(payload.ooo_from).slice(0, 10)
    : null;
  const oooUntil = payload?.ooo_until && /^\d{4}-\d{2}-\d{2}/.test(String(payload.ooo_until))
    ? String(payload.ooo_until).slice(0, 10)
    : null;
  const note = payload?.note ? String(payload.note).slice(0, 200) : null;

  setTeamAvailability({
    userId, name,
    oooFrom,
    oooUntil,
    note,
    updatedBy: senderName,
  }).catch(() => {});

  // Human-readable window for the confirm message. Today-or-earlier start dates
  // are elided so "out until Thursday" doesn't awkwardly echo the start date back.
  const todayIso = new Date().toISOString().slice(0, 10);
  const startsLater = oooFrom && oooFrom > todayIso;
  let windowStr = '';
  if (startsLater && oooUntil)  windowStr = ` from ${oooFrom} through ${oooUntil}`;
  else if (oooUntil)            windowStr = ` through ${oooUntil}`;
  else if (startsLater)         windowStr = ` starting ${oooFrom}`;

  return {
    reaction: 'white_check_mark',
    threadText: `Saved — ${name} OOO${windowStr}${note ? ` (${note})` : ''}. I'll skip them for routing during that window.`,
    action: oooUntil ? 'availability_set_with_date' : 'availability_set_open_ended',
  };
}

function handleSummaryFeedback(payload, senderName, cardContext) {
  if (!cardContext) {
    return {
      reaction: 'thinking_face',
      threadText: "I only accept summary corrections as a thread reply on the card you're correcting. Reply in that card's thread next time.",
      action: 'summary_feedback_no_card',
    };
  }
  const corrected = String(payload?.corrected_summary || '').trim();
  recordSummaryCorrection({
    routingLogId: cardContext.id,
    originalSummary: cardContext.summary,
    correctedSummary: corrected || null,
    correctedBy: senderName,
  }).catch(() => {});
  return {
    reaction: 'white_check_mark',
    threadText: corrected
      ? `Noted — saved your corrected summary for weekly review.`
      : `Noted — flagged the summary on this card as wrong for weekly review.`,
    action: 'summary_feedback_saved',
  };
}

function handleInquiryFlip(payload, cardContext) {
  if (!cardContext) {
    return {
      reaction: 'thinking_face',
      threadText: "Reply to the specific routing card's thread to flip its inquiry state.",
      action: 'inquiry_flip_no_card',
    };
  }
  // We don't mutate routing_log.is_inquiry directly (no such column); instead
  // we log the flip as a correction with reason='not_an_inquiry' so the
  // learner sees it.
  const isInquiry = payload?.is_inquiry;
  applyCorrection({
    routingId: cardContext.id,
    correctedPerson: 'Ivan', // non-null value to flag this row; learner treats reason separately
    reason: isInquiry === false ? 'not_an_inquiry' : 'is_an_inquiry',
    correctedBy: 'intent_parser:INQUIRY_FLIP',
  }).catch(() => {});
  return {
    reaction: 'white_check_mark',
    threadText: isInquiry === false
      ? `Flagged this card as not-an-inquiry for the learner.`
      : `Flagged this card as a real inquiry.`,
    action: 'inquiry_flipped',
  };
}

function handleNoiseFilter(payload, senderName) {
  const senderRef = String(payload?.sender_ref || '').trim();
  const ignore = payload?.ignore !== false;  // default to ignore=true
  if (!senderRef) {
    return {
      reaction: 'thinking_face',
      threadText: "Which sender? Example: \"ignore messages from @bob-tester\".",
      action: 'noise_filter_no_ref',
    };
  }
  // Accept "<@Uxxxx>" slack mention OR raw ID OR tg:<numeric>
  const slackIdMatch = senderRef.match(/<@([UW][A-Z0-9]+)/) || senderRef.match(/\b([UW][A-Z0-9]{8,})\b/);
  const tgIdMatch = senderRef.match(/^tg:(\d+)$/) || senderRef.match(/^(\d{6,})$/);
  let senderId = null; let platform = null;
  if (slackIdMatch) { senderId = slackIdMatch[1]; platform = 'slack'; }
  else if (tgIdMatch) { senderId = tgIdMatch[1]; platform = 'telegram'; }

  if (!senderId) {
    return {
      reaction: 'thinking_face',
      threadText: "I need a Slack @-mention (like @bob-tester), a Slack user ID (Uxxxxx), or tg:<numeric-id>.",
      action: 'noise_filter_unresolved',
    };
  }

  if (ignore) {
    addIgnoredSender({ senderId, platform, reason: String(payload?.reason || '').slice(0, 200), addedBy: senderName }).catch(() => {});
    return {
      reaction: 'white_check_mark',
      threadText: `Ignoring messages from ${senderRef} (${platform}).`,
      action: 'noise_filter_added',
    };
  } else {
    removeIgnoredSender(senderId).catch(() => {});
    return {
      reaction: 'white_check_mark',
      threadText: `No longer ignoring ${senderRef}.`,
      action: 'noise_filter_removed',
    };
  }
}

async function handleThisCardOverride(payload, senderName, cardContext) {
  if (!cardContext) {
    return {
      reaction: 'thinking_face',
      threadText: "Reply inside the card's thread to override its routing.",
      action: 'override_no_card',
    };
  }
  // Self-claim: "taking this" — set actual_responder to sender
  if (payload?.claim_self) {
    await applyCorrection({
      routingId: cardContext.id,
      correctedPerson: senderName,
      reason: 'self-claim via thread reply',
      correctedBy: senderName,
    }).catch(() => {});
    return {
      reaction: 'white_check_mark',
      threadText: `Got it — ${senderName} claimed this card.`,
      action: 'override_self_claim',
    };
  }
  const person = resolvePerson(payload?.person);
  if (!person) {
    return {
      reaction: 'thinking_face',
      threadText: "Who should this go to? Include a team name, e.g. \"this is Daniel's\".",
      action: 'override_no_person',
    };
  }
  const reason = payload?.reason ? String(payload.reason).slice(0, 200) : 'Lane B thread correction';
  await applyCorrection({
    routingId: cardContext.id,
    correctedPerson: person,
    reason,
    correctedBy: senderName,
  }).catch(() => {});
  return {
    reaction: 'white_check_mark',
    threadText: `Reassigned to ${person}.`,
    action: 'override_reassigned',
  };
}

function handleUnclear(payload, confidence, lane = 'A') {
  // Lane B: message is probably internal team conversation — stay silent.
  if (lane === 'B') {
    return { reaction: 'thinking_face', threadText: null, action: 'unclear_silent' };
  }
  // Lane A: ask a follow-up so the sender knows we didn't understand.
  const options = Array.isArray(payload?.options) && payload.options.length
    ? payload.options.slice(0, 3)
    : [
        'add a routing rule?',
        'mark someone as OOO?',
        'just an observation with no action?',
      ];
  const bulletLines = options.map(o => `  • ${o}`).join('\n');
  return {
    reaction: 'thinking_face',
    threadText: `I'm not sure what to do with that (confidence ${(confidence * 100).toFixed(0)}%). Did you mean:\n${bulletLines}\nReply with the version you meant, or react :eyes: and I'll drop it.`,
    action: 'unclear',
  };
}
