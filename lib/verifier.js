// lib/verifier.js — escalate uncertain classifications to the team for a
// reaction-based verification, inside #partners-assistant (no new surface).
//
// Philosophy:
//   - Most cards route automatically. A small fraction hit a trigger (low
//     confidence, close alternative, OOO of the suggested person, or unknown
//     partner) — the bot appends a verifier block to the card, @-mentions Roy
//     (who has the full org overview), and offers 2-3 numbered reaction
//     options.
//   - First reaction wins. Roy, Jesse, anyone on the team — whoever's watching
//     and knows the answer resolves it. No DM, no new channel.
//   - A reply in thread with a name flows through Lane B's existing
//     parseTeamIntent → THIS_CARD_OVERRIDE path, so a free-text answer works
//     too without duplicating logic.
//   - Every resolution writes a correction to routing_log AND a rule entry to
//     routing_rules.json tagged `source: "verifier"` and `verified_by: <name>`.
//     The learner upweights `verified_by: Roy` in pattern analysis because
//     Roy's org view makes his call higher-trust than an inferred correction.
//
// What's NOT in this file:
//   - Slack I/O (posting the card, polling reactions). Index.js does that.
//   - Reaction listener. Index.js's app.event('reaction_added') dispatches to
//     verifier.resolveFromReaction() when the message has a verifier row.
//   - Monday gap digest. lib/learner.js owns that job.

import fs from 'node:fs';
import path from 'node:path';
import { TEAM, TEAM_ID_BY_NAME } from '../config.js';
import {
  recordVerifierPending, resolveVerifier, isKnownPartner,
  countVerifierPast24h, applyCorrection, getActiveOOOBlock,
} from './sqlite.js';
import { reloadLearnedRules } from './claude.js';

const RULES_PATH = process.env.BREEZ_ROUTING_RULES_PATH
  || path.join(process.cwd(), 'data', 'routing_rules.json');

// Hard ceiling on verifier escalations per day. Overflow is dropped — card
// posts with its best guess and a silent `unverified` banner — so Roy and the
// team never see a spam burst even during a noisy incident.
const DAILY_ESCALATION_CAP = Number(process.env.VERIFIER_DAILY_CAP || 5);

// Low-confidence threshold on Haiku's numeric confidence. Haiku is asked to
// emit a 0-1 score; anything below this triggers escalation.
const LOW_CONF_THRESHOLD = 0.6;

// Number emojis used as reaction options. Three is plenty — more is decision
// fatigue and most cards only need primary/alternative/other.
const NUMBER_EMOJIS = ['one', 'two', 'three'];

// ─── Trigger evaluation ──────────────────────────────────────────────────

/**
 * Inspect the classification + environment and decide if this card should
 * escalate to a verifier block. Returns:
 *   { escalate: false }  — post the card normally
 *   { escalate: true, reason, options, roleHint } — append verifier block
 *
 * Trigger priority (first match wins):
 *   1. 'ooo'              — suggested person is currently OOO
 *   2. 'low_conf'         — numeric confidence < 0.6 OR lowConfidence flag
 *   3. 'close_alt'        — alternativePerson within 0.15 of primary
 *   4. 'unknown_partner'  — partner has no routing history in last 90 days
 */
export function evaluateTriggers({ classification, partnerName }) {
  const {
    suggestedPerson,
    alternativePerson,
    confidence,
    lowConfidence,
  } = classification || {};

  if (!suggestedPerson) return { escalate: false };

  // Block all escalation above the daily cap — overflow routes normally
  if (countVerifierPast24h() >= DAILY_ESCALATION_CAP) {
    return { escalate: false, reason: 'daily_cap' };
  }

  // Trigger 1: suggested person is OOO
  const oooBlock = getActiveOOOBlock();
  const isSuggestedOOO = oooBlock && oooBlock.includes(suggestedPerson);
  if (isSuggestedOOO) {
    // Known cover → silent reroute, no escalation needed
    if (alternativePerson && alternativePerson !== suggestedPerson && TEAM_ID_BY_NAME[alternativePerson]) {
      return { escalate: false, reroute: alternativePerson, rerouteReason: 'ooo' };
    }
    // No known cover → ask Roy
    return {
      escalate: true,
      reason: 'ooo',
      options: [{ emoji: 'one', person: null, rationale: 'reply in thread with a name' }],
    };
  }

  // Trigger 2: low confidence
  const numericLow = typeof confidence === 'number' && confidence < LOW_CONF_THRESHOLD;
  if (numericLow || lowConfidence === true) {
    const options = buildOptionsForLowConf({ suggestedPerson, alternativePerson });
    if (options.length >= 2) {
      return { escalate: true, reason: 'low_conf', options };
    }
  }

  // Trigger 3: close alternative exists
  if (alternativePerson && alternativePerson !== suggestedPerson && TEAM_ID_BY_NAME[alternativePerson]) {
    return {
      escalate: true,
      reason: 'close_alt',
      options: [
        { emoji: 'one', person: suggestedPerson, rationale: 'my best guess' },
        { emoji: 'two', person: alternativePerson, rationale: 'close alternative' },
        { emoji: 'three', person: null, rationale: 'someone else (thread reply)' },
      ],
    };
  }

  // Trigger 4: unknown partner (never seen before in routing_log)
  if (partnerName && !isKnownPartner(partnerName)) {
    return {
      escalate: true,
      reason: 'unknown_partner',
      options: [
        { emoji: 'one', person: suggestedPerson, rationale: 'my best guess' },
        { emoji: 'two', person: null, rationale: 'someone else (thread reply)' },
      ],
    };
  }

  return { escalate: false };
}


function buildOptionsForLowConf({ suggestedPerson, alternativePerson }) {
  const opts = [{ emoji: 'one', person: suggestedPerson, rationale: 'my best guess' }];
  if (alternativePerson && alternativePerson !== suggestedPerson && TEAM_ID_BY_NAME[alternativePerson]) {
    opts.push({ emoji: 'two', person: alternativePerson, rationale: 'alternative Haiku considered' });
  }
  opts.push({
    emoji: opts.length === 1 ? 'two' : 'three',
    person: null,
    rationale: 'someone else (thread reply with name)',
  });
  return opts;
}

// ─── Verifier Slack block builder ─────────────────────────────────────────

/**
 * Build the Slack Block Kit fragments to append to a routing card. The caller
 * in index.js concatenates these onto the standard card blocks before posting.
 *
 * The @-mention always targets Roy (config TEAM role 'Roy') — the primary
 * verifier — but Slack reactions are channel-wide, so anyone on the team who
 * sees it first can resolve it.
 */
export function buildVerifierBlocks({ reason, options }) {
  const royId = TEAM_ID_BY_NAME['Roy'];
  const royMention = royId ? `<@${royId}>` : 'Roy';

  const reasonLine = {
    low_conf:        `:mag: Not confident on this routing — team, can you confirm?`,
    close_alt:       `:mag: Two close candidates — which one?`,
    ooo:             `:palm_tree: Suggested owner is OOO and no cover identified — ${royMention}, who should take this?`,
    unknown_partner: `:wave: New partner — who owns this?`,
  }[reason] || `:mag: Needs verification.`;

  const optionLines = options.map(opt => {
    const emojiStr = `:${opt.emoji}:`;
    const who = opt.person ? `*${opt.person}*` : '_someone else_';
    return `${emojiStr} ${who} — ${opt.rationale}`;
  });

  return [
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: reasonLine }],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: optionLines.join('\n') + '\n\n_First reaction wins. Or reply in thread with a name to pick anyone else._',
      },
    },
  ];
}

/**
 * Emojis to pre-seed as reactions on the posted card, so Roy can click one
 * instead of typing. Index.js calls addReaction for each in sequence.
 */
export function seedReactionEmojis(options) {
  return options.map(o => o.emoji);
}

// ─── Record + resolve ────────────────────────────────────────────────────

/**
 * Persist a pending verifier row right after the card is posted.
 */
export function recordPending({ routingId, channelId, messageTs, reason, options, partnerName }) {
  recordVerifierPending({
    routingId, channelId, messageTs,
    triggerReason: reason,
    options,
    partnerName,
  });
}

/**
 * Called from the reaction_added handler when a number reaction lands on a
 * card that has a pending verifier row. Looks up which person the reaction
 * maps to, writes a correction, and appends a verifier-sourced rule to
 * routing_rules.json so the classifier picks up this learned decision.
 *
 * Returns:
 *   { resolved: true, person, action } — the reaction picked a person
 *   { resolved: false, reason } — reaction wasn't a valid option, card full, etc.
 */
export async function resolveFromReaction({
  pending, emoji, reactorId, reactorName, originalSuggestion,
}) {
  if (!pending || pending.resolved_at) {
    return { resolved: false, reason: 'already_resolved' };
  }

  const option = (pending.options || []).find(o => o.emoji === emoji);
  if (!option) return { resolved: false, reason: 'unknown_emoji' };

  // Option 3️⃣ with person=null means "someone else, I'll reply in thread" —
  // silent ack, no correction. The thread reply will flow through Lane B.
  if (!option.person) {
    resolveVerifier({
      routingId: pending.routing_id,
      resolvedById: reactorId,
      resolvedByName: reactorName,
      resolvedPerson: null,
    });
    return { resolved: true, person: null, action: 'pending_thread_reply' };
  }

  const chosen = option.person;
  const changed = chosen !== originalSuggestion;

  // Write a correction on the card iff the choice differs from the original.
  // If Roy confirms the original guess, no correction is needed — just log
  // the resolution so the card no longer shows as "unverified."
  if (changed) {
    await applyCorrection({
      routingId: pending.routing_id,
      correctedPerson: chosen,
      reason: `verifier:${pending.trigger_reason} by ${reactorName}`,
      correctedBy: reactorName,
    }).catch(() => {});
  }

  // Append a verifier-sourced rule entry (learned coverage / clarification).
  // The learner weights these higher, and weights Roy's even higher still.
  try {
    appendVerifierRule({
      partnerName: pending.partner_name,
      triggerReason: pending.trigger_reason,
      originalSuggestion,
      chosenPerson: chosen,
      verifiedBy: reactorName,
    });
    reloadLearnedRules();
  } catch (err) {
    console.warn('[verifier] rule append failed:', err.message);
  }

  resolveVerifier({
    routingId: pending.routing_id,
    resolvedById: reactorId,
    resolvedByName: reactorName,
    resolvedPerson: chosen,
  });

  return {
    resolved: true,
    person: chosen,
    action: changed ? 'verifier_corrected' : 'verifier_confirmed',
  };
}

/**
 * Append one entry to routing_rules.json under team_proposed, tagged with
 * verifier metadata. Also writes a plain-text version into rules[] so the
 * classifier picks it up automatically on reloadLearnedRules().
 */
function appendVerifierRule({ partnerName, triggerReason, originalSuggestion, chosenPerson, verifiedBy }) {
  let data;
  try {
    data = fs.existsSync(RULES_PATH)
      ? JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'))
      : { rules: [], team_proposed: [] };
  } catch {
    data = { rules: [], team_proposed: [] };
  }
  if (!Array.isArray(data.rules)) data.rules = [];
  if (!Array.isArray(data.team_proposed)) data.team_proposed = [];

  const partnerTag = partnerName ? `${partnerName}` : 'any partner';
  const ruleText = (triggerReason === 'ooo')
    ? `When suggested owner is OOO, ${partnerTag} cases can be routed to ${chosenPerson}.`
    : (originalSuggestion && originalSuggestion !== chosenPerson)
      ? `For ${partnerTag}, prefer ${chosenPerson} over ${originalSuggestion}.`
      : `Confirmed: ${chosenPerson} owns ${partnerTag} cases like this.`;

  // Dedup on normalized text — don't pollute rules with repeats of the same call
  const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  const already = data.rules.some(r => norm(r) === norm(ruleText));

  if (!already) data.rules.push(ruleText);
  data.team_proposed.push({
    text: ruleText,
    source: 'verifier',
    trigger_reason: triggerReason,
    partner: partnerName || null,
    original_suggestion: originalSuggestion || null,
    chosen_person: chosenPerson,
    verified_by: verifiedBy,
    added_at: new Date().toISOString(),
  });
  data.generated_at = new Date().toISOString();

  fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
  fs.writeFileSync(RULES_PATH, JSON.stringify(data, null, 2), 'utf8');
}
