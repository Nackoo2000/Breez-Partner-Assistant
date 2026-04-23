// index.js — single-process entrypoint for the Breez Partner Assistant bot.
//
// Responsibilities, in the order they start:
//   1. Load .env.local in development (pm2 injects env in production).
//   2. Open the SQLite DB (lib/sqlite.js does the schema migration at import).
//   3. Boot a Slack Bolt app in Socket Mode and wire up event/action/view handlers.
//   4. Start the Telegram long-polling loop.
//   5. Start the learner scheduler (pattern analysis, weekly digest, monthly expertise).
//   6. Kick off the 12-hour ops heartbeat DM.
//   7. Handle SIGINT/SIGTERM for clean pm2 restarts.

import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import {
  TEAM, TEAM_IDS, BOT_USER_ID, ASSISTANT_CHANNEL_ID, TEAM_ID_BY_NAME,
} from './config.js';
import {
  getChannelInfo, fetchChannelContext, postBlocks, buildNotificationBlocks,
  buildMessageLink, getUserName, openModal, updateMessage, sendDirectMessage,
  addReaction, postThreadReply,
} from './lib/slack.js';
import { analyzeMessage, reloadLearnedRules } from './lib/claude.js';
import {
  tryClaimCooldown, logRouting, recordResponse, storeMessageTs, recordRoyMention,
  getRoutingById, applyCorrection, getRoutingStats, closeDb,
  getRoutingByMessageTs, logTeamInteraction, isIgnoredSender,
  getVerifierByMessageTs,
} from './lib/sqlite.js';
import { startTelegramPolling } from './lib/telegram.js';
import { startLearner, maybeRunIncrementalLearner } from './lib/learner.js';
import { startDeadman } from './lib/deadman.js';
import { parseTeamIntent } from './lib/intent_parser.js';
import { dispatchIntent } from './lib/team_signals.js';
import {
  evaluateTriggers, buildVerifierBlocks, seedReactionEmojis,
  recordPending as recordVerifierPending, resolveFromReaction as resolveVerifierFromReaction,
} from './lib/verifier.js';
import { trackClassifierResult } from './lib/error_alert.js';

// ─── Required env vars ────────────────────────────────────────────────────

const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[boot] missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── Bolt app (Socket Mode) ───────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

const client = app.client;

// ── message event ─────────────────────────────────────────────────────────

const PASSTHROUGH_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

app.event('message', async ({ event }) => {
  try {
    if (event.subtype && !PASSTHROUGH_SUBTYPES.has(event.subtype)) return;
    if (!event.user) return;
    if (event.user === BOT_USER_ID) return;

    // ── Input hardening ──────────────────────────────────────────────────
    // Drop DMs and multi-person DMs silently. The bot is never allowed to
    // process a direct message — no AI call, no response. The only place
    // anyone can talk to the bot is #partners-assistant (handled separately,
    // not here). This is a hard boundary: even team members' DMs are dropped.
    // One audit line per drop so `pm2 logs breez-bot | grep "dropped"` can
    // answer "why didn't my DM do anything?" in two seconds. Content is
    // deliberately NOT logged.
    if (event.channel_type === 'im' || event.channel_type === 'mpim') {
      console.log(`[slack] dropped ${event.channel_type} from ${event.user}`);
      return;
    }

    // Team member posted in a partner channel → record response, skip analysis.
    // Team member posted in #partners-assistant AS A THREAD REPLY on a bot
    // routing card → Lane B dispatch.
    if (TEAM_IDS.has(event.user)) {
      if (event.channel !== ASSISTANT_CHANNEL_ID) {
        const teamName = TEAM[event.user]?.name;
        if (teamName) recordResponse({ channelId: event.channel, actualPerson: teamName }).catch(() => {});

        if (teamName === 'Roy') {
          const mentioned = parseSlackTeamMention(event.text || '', TEAM);
          if (mentioned) recordRoyMention({ channelId: event.channel, mentionedPerson: mentioned }).catch(() => {});
        }
        return;
      }

      // In #partners-assistant: only interested in thread replies on bot routing cards.
      // Top-level team chat, messages that aren't thread replies, and messages
      // in non-bot threads are ignored.
      const parentTs = event.thread_ts;
      if (!parentTs || parentTs === event.ts) return;

      const card = getRoutingByMessageTs(parentTs);
      if (!card) return;  // thread on something that isn't a bot routing card

      handleLaneB({ event, card }).catch(err => console.error('[laneB] error:', err.message));
      return;
    }

    if (event.channel === ASSISTANT_CHANNEL_ID) return;
    if (process.env.SYSTEM_PAUSED === 'true') return;

    // Noise filter — team flagged this sender via Lane A ("ignore @bob-tester")
    if (isIgnoredSender(event.user)) {
      console.log(`[slack] skipping ignored sender ${event.user} in ${event.channel}`);
      return;
    }

    // Strip bot @-mentions from partner messages before classification. Keeps
    // the classifier from ever seeing a "<@bot>" token in user data, and
    // removes any incentive for a partner to try to address the bot directly
    // from their own channel. The classifier is already prompt-hardened; this
    // is defense in depth.
    const messageText = stripBotMention(event.text);
    if (!messageText.trim()) return;
    if (isOnlyEmoji(messageText)) return;

    const { partnerName } = await getChannelInfo(client, event.channel);
    const senderName = await getUserName(client, event.user);

    const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
    const { context, threadParentFound } = await fetchChannelContext(client, event.channel, event.thread_ts || null);

    if (isThreadReply && !threadParentFound) {
      console.log(`[slack] ${partnerName}: thread parent not in recent history — skipping`);
      return;
    }

    const routingStats = await getRoutingStats();
    const analysis = await analyzeMessage({
      partnerName, context, newMessageText: messageText, senderName, routingStats,
    });
    // Non-blocking; only fires an alert if classifier errors cluster.
    trackClassifierResult(client, analysis).catch(() => {});

    if (!analysis.isInquiry) {
      console.log(`[slack] ${partnerName}: not an inquiry — skipping`);
      return;
    }

    const rawLink = buildMessageLink(event.channel, event.ts, event.thread_ts || null);
    const suggestedName = analysis.suggestedPerson || 'Ivan';
    const suggestedId = TEAM_ID_BY_NAME[suggestedName];

    if (!await tryClaimCooldown(event.channel, suggestedName)) {
      console.log(`[slack] ${partnerName}: ${suggestedName} already pinged in last 5 min — skipping`);
      return;
    }

    const routingId = await logRouting({
      channelId: event.channel,
      partnerName,
      suggestedPerson: suggestedName,
      summary: analysis.summary,
      partnerMessageLink: rawLink,
    }).catch(() => null);

    const { blocks, color } = buildNotificationBlocks({
      partnerName,
      summary: analysis.summary,
      suggestedName,
      suggestedId,
      messageLink: rawLink,
      routingId,
      lowConfidence: analysis.lowConfidence,
    });

    // ── Verifier escalation ─────────────────────────────────────────────
    // Evaluate the 4 triggers (OOO / low_conf / close_alt / unknown_partner).
    // If any hit, append a verifier block to the card and schedule number
    // reactions so Roy (or anyone) can resolve by clicking. Daily cap enforced
    // inside evaluateTriggers() — overflow routes normally.
    const trigger = evaluateTriggers({
      classification: analysis,
      partnerName,
    });
    const cardBlocks = trigger.escalate
      ? [...blocks, ...buildVerifierBlocks({ reason: trigger.reason, options: trigger.options })]
      : blocks;

    const postResult = await postBlocks(
      client, ASSISTANT_CHANNEL_ID, cardBlocks,
      `${partnerName} — ${suggestedName}${trigger.escalate ? ' (verify?)' : ''}`, color,
    );

    if (routingId && postResult?.ts) {
      storeMessageTs(routingId, postResult.ts).catch(() => {});

      if (trigger.escalate) {
        // Persist pending row so reaction_added can look it up by message ts
        recordVerifierPending({
          routingId,
          channelId: ASSISTANT_CHANNEL_ID,
          messageTs: postResult.ts,
          reason: trigger.reason,
          options: trigger.options,
          partnerName,
        });
        // Seed number reactions for one-click resolution
        for (const name of seedReactionEmojis(trigger.options)) {
          addReaction(client, ASSISTANT_CHANNEL_ID, postResult.ts, name).catch(() => {});
        }
        console.log(`[verifier] card ${routingId} escalated — reason=${trigger.reason} options=${trigger.options.length}`);
      }
    }

    console.log(`[slack] ${partnerName} inquiry posted → ${suggestedName}${trigger.escalate ? ` [verifier:${trigger.reason}]` : ''}`);
  } catch (err) {
    console.error('[slack] message handler error:', err.message);
  }
});

// ── Reassign button click → open modal ────────────────────────────────────

app.action('reassign_click', async ({ ack, action, body }) => {
  await ack();

  const routingId = action.value;
  const messageTs = body.message?.ts;
  const triggerId = body.trigger_id;

  const options = Object.values(TEAM)
    .filter(m => m.name !== 'Danny')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(m => ({
      text: { type: 'plain_text', text: m.name },
      value: m.name,
    }));

  const modal = {
    type: 'modal',
    callback_id: 'reassign_submit',
    private_metadata: JSON.stringify({ routingId, messageTs }),
    title: { type: 'plain_text', text: 'Reassign Inquiry' },
    submit: { type: 'plain_text', text: 'Reassign' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'person_block',
        label: { type: 'plain_text', text: 'Assign to' },
        element: {
          type: 'static_select',
          action_id: 'person_select',
          placeholder: { type: 'plain_text', text: 'Select team member' },
          options,
        },
      },
      {
        type: 'input',
        block_id: 'reason_block',
        optional: true,
        label: { type: 'plain_text', text: 'Reason (optional)' },
        element: {
          type: 'plain_text_input',
          action_id: 'reason_input',
          placeholder: { type: 'plain_text', text: 'e.g. Payment issue, not SDK setup' },
        },
      },
    ],
  };

  const result = await openModal(client, triggerId, modal);
  if (!result?.ok && body.response_url) {
    // trigger_id expires after 3s — fall back to ephemeral feedback
    fetch(body.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        replace_original: false,
        text: `Couldn't open the reassign dialog (${result?.error || 'unknown error'}). Please click Reassign again.`,
      }),
    }).catch(err => console.error('[slack] response_url fallback failed:', err.message));
  }
});

// ── Reassign modal submission ─────────────────────────────────────────────

app.view('reassign_submit', async ({ ack, view, body }) => {
  const meta = JSON.parse(view.private_metadata || '{}');
  const { routingId, messageTs } = meta;

  const correctedPerson = view.state.values?.person_block?.person_select?.selected_option?.value;
  const reason = view.state.values?.reason_block?.reason_input?.value?.trim() || null;
  const correctedBySlackId = body.user?.id;
  const correctedByName = TEAM[correctedBySlackId]?.name || body.user?.username || 'Team';

  if (!correctedPerson) {
    await ack({
      response_action: 'errors',
      errors: { person_block: 'Please select a team member' },
    });
    return;
  }

  await ack({ response_action: 'clear' });

  // Rebuild and update the original notification message in-place
  if (routingId && messageTs) {
    const routing = await getRoutingById(routingId).catch(() => null);
    if (routing) {
      const correctedId = TEAM_ID_BY_NAME[correctedPerson];
      const suggestedId = TEAM_ID_BY_NAME[routing.suggested_person];
      const { blocks, color } = buildNotificationBlocks({
        partnerName: routing.partner_name,
        summary: routing.summary,
        suggestedName: routing.suggested_person,
        suggestedId,
        messageLink: routing.partner_message_link,
        routingId,
        noLinkLabel: routing.partner_message_link ? undefined : 'TG - no link',
        correctedName: correctedPerson,
        correctedId,
        correctedBy: correctedByName,
        correctionReason: reason,
      });
      await updateMessage(
        client, ASSISTANT_CHANNEL_ID, messageTs, blocks,
        `${routing.partner_name} — reassigned to ${correctedPerson}`, color,
      ).catch(() => {});
    }
  }

  if (routingId) {
    await applyCorrection({ routingId, correctedPerson, reason, correctedBy: correctedByName }).catch(() => {});
    // Event-driven learner: enough recent corrections may trigger an
    // incremental pattern_analysis run off the weekly schedule.
    maybeRunIncrementalLearner(client).catch(() => {});
  }
});

// Make sure ack() for unknown actions doesn't produce console noise
app.action('view_message_link', async ({ ack }) => ack());
app.action('no_link_info', async ({ ack }) => ack());

// ── Lane A: @-mentions of the bot in #partners-assistant ───────────────────
//
// Only fires for app_mention events in ASSISTANT_CHANNEL_ID. Any other channel
// is silently ignored (defense in depth — the input-hardening earlier in the
// message handler also drops partner-channel team messages that try to reach
// the bot, but app_mention is a separate Slack event type that bypasses it).
app.event('app_mention', async ({ event }) => {
  try {
    if (event.channel !== ASSISTANT_CHANNEL_ID) return;
    if (!event.user || event.user === BOT_USER_ID) return;
    if (!TEAM_IDS.has(event.user)) {
      console.log(`[laneA] non-team mention from ${event.user} — ignored`);
      return;
    }
    const cleanText = stripBotMention(event.text);
    if (!cleanText) return;

    const senderName = TEAM[event.user]?.name || await getUserName(client, event.user);
    const parsed = await parseTeamIntent({
      text: cleanText, senderName, lane: 'A', cardContext: null,
    });
    const ack = await dispatchIntent({
      parsed, senderName, senderUserId: event.user, lane: 'A', cardContext: null,
    });

    // Ack in Slack: reaction on the user's message, optional thread reply.
    await addReaction(client, event.channel, event.ts, ack.reaction);
    if (ack.threadText) {
      await postThreadReply(client, event.channel, event.ts, ack.threadText);
    }

    logTeamInteraction({
      userId: event.user, userName: senderName, lane: 'A',
      rawText: cleanText, threadTs: event.ts, parentTs: null,
      parsedIntent: parsed.intent, parsedConfidence: parsed.confidence, parsedPayload: parsed.payload,
      actionTaken: ack.action, reactionUsed: ack.reaction,
    }).catch(() => {});

    console.log(`[laneA] ${senderName} -> ${parsed.intent} (${(parsed.confidence * 100).toFixed(0)}%) -> ${ack.action}`);
  } catch (err) {
    console.error('[laneA] app_mention error:', err.message);
  }
});

// ── Lane B: thread reply on a bot routing card ─────────────────────────────
//
// Called from the message handler above once we've already confirmed the
// parent is a bot routing card and the sender is on the team.
async function handleLaneB({ event, card }) {
  const senderName = TEAM[event.user]?.name || await getUserName(client, event.user);
  const cleanText = stripBotMention(event.text);
  if (!cleanText) return;

  const cardContext = {
    id: card.id,
    partner_name: card.partner_name,
    suggested_person: card.suggested_person,
    summary: card.summary,
  };
  const parsed = await parseTeamIntent({
    text: cleanText, senderName, lane: 'B', cardContext,
  });
  const ack = await dispatchIntent({
    parsed, senderName, senderUserId: event.user, lane: 'B', cardContext,
  });

  await addReaction(client, event.channel, event.ts, ack.reaction);
  if (ack.threadText) {
    // Lane B threadText posts into the SAME thread the team member is in,
    // which is the routing-card's thread (event.thread_ts === card ts).
    await postThreadReply(client, event.channel, event.thread_ts || event.ts, ack.threadText);
  }

  logTeamInteraction({
    userId: event.user, userName: senderName, lane: 'B',
    rawText: cleanText, threadTs: event.ts, parentTs: event.thread_ts || null,
    parsedIntent: parsed.intent, parsedConfidence: parsed.confidence, parsedPayload: parsed.payload,
    actionTaken: ack.action, reactionUsed: ack.reaction,
  }).catch(() => {});

  // If the Lane B action counted as a correction, nudge the event-driven learner
  if (['override_reassigned', 'override_self_claim', 'inquiry_flipped'].includes(ack.action)) {
    maybeRunIncrementalLearner(client).catch(() => {});
  }

  console.log(`[laneB] ${senderName} -> ${parsed.intent} (${(parsed.confidence * 100).toFixed(0)}%) -> ${ack.action}`);
}

// ── Reaction listener on bot routing cards ─────────────────────────────────
//
// Passive signal: team members react to cards with ✅ / ❌ / 👀 / 🤔 and each
// means something in the learner's accounting. We only care about reactions
// on the TOP-level bot routing card, not on thread replies.
app.event('reaction_added', async ({ event }) => {
  try {
    if (event.item?.type !== 'message') return;
    if (event.item?.channel !== ASSISTANT_CHANNEL_ID) return;
    if (!TEAM_IDS.has(event.user)) return;
    if (event.item_user && event.item_user !== BOT_USER_ID) return;  // only bot messages

    const card = getRoutingByMessageTs(event.item.ts);
    if (!card) return;

    const reactorName = TEAM[event.user]?.name || event.user;

    // Verifier resolution — number reactions on a card with a pending verifier
    // row pick one of the presented options. First valid reaction wins.
    if (['one', 'two', 'three'].includes(event.reaction)) {
      const pending = getVerifierByMessageTs(event.item.ts);
      if (pending && !pending.resolved_at) {
        const result = await resolveVerifierFromReaction({
          pending,
          emoji: event.reaction,
          reactorId: event.user,
          reactorName,
          originalSuggestion: card.suggested_person,
        });
        if (result.resolved) {
          logTeamInteraction({
            userId: event.user, userName: reactorName, lane: 'B',
            rawText: `:${event.reaction}: verifier ack on card ${card.id}`,
            threadTs: null, parentTs: event.item.ts,
            parsedIntent: 'VERIFIER_REACTION', parsedConfidence: 1,
            parsedPayload: {
              card_id: card.id, trigger: pending.trigger_reason,
              person: result.person, action: result.action,
            },
            actionTaken: result.action, reactionUsed: event.reaction,
          }).catch(() => {});
          if (result.action === 'verifier_corrected') {
            maybeRunIncrementalLearner(client).catch(() => {});
          }
          console.log(`[verifier] card ${card.id} resolved by ${reactorName} -> ${result.person || '(thread-reply)'} (${result.action})`);
        }
        return;
      }
    }

    switch (event.reaction) {
      case 'white_check_mark':
      case 'heavy_check_mark':
        // Positive: the team confirmed the routing was right.
        // We don't change routing_log, but we do log the signal for weekly digest.
        logTeamInteraction({
          userId: event.user, userName: reactorName, lane: 'B',
          rawText: `:${event.reaction}: on card ${card.id}`, threadTs: null, parentTs: event.item.ts,
          parsedIntent: 'POSITIVE_REACTION', parsedConfidence: 1,
          parsedPayload: { card_id: card.id, partner: card.partner_name, suggested: card.suggested_person },
          actionTaken: 'positive_reaction_logged', reactionUsed: null,
        }).catch(() => {});
        break;

      case 'x':
      case 'negative_squared_cross_mark':
        // Negative: team says the suggestion was wrong, no specific correction text.
        // Record as a correction with reason="x-reaction" so it flows into the learner.
        await applyCorrection({
          routingId: card.id,
          correctedPerson: 'Ivan',  // non-null placeholder; reason carries the meaning
          reason: 'x-reaction (no specific reassign given)',
          correctedBy: reactorName,
        }).catch(() => {});
        maybeRunIncrementalLearner(client).catch(() => {});
        console.log(`[reaction] ${reactorName} flagged card ${card.id} with :x:`);
        break;

      case 'eyes':
        // "I've got this" — treat as response claim.
        await applyCorrection({
          routingId: card.id,
          correctedPerson: reactorName,
          reason: ':eyes: claim on routing card',
          correctedBy: reactorName,
        }).catch(() => {});
        console.log(`[reaction] ${reactorName} claimed card ${card.id} via :eyes:`);
        break;

      case 'thinking_face':
        // Low-confidence signal from a human. Just log.
        logTeamInteraction({
          userId: event.user, userName: reactorName, lane: 'B',
          rawText: `:thinking_face: on card ${card.id}`, threadTs: null, parentTs: event.item.ts,
          parsedIntent: 'HUMAN_UNCLEAR', parsedConfidence: 1,
          parsedPayload: { card_id: card.id },
          actionTaken: 'human_unclear_flagged', reactionUsed: null,
        }).catch(() => {});
        break;

      default:
        // Any other reaction: don't care.
        return;
    }
  } catch (err) {
    console.error('[reaction] handler error:', err.message);
  }
});

// ─── Helpers (scoped to this file) ────────────────────────────────────────

function isOnlyEmoji(text) {
  return text.trim().length > 0 && !/[\p{L}\p{N}\p{P}]/u.test(text);
}

// Remove "<@BOT_USER_ID>" and "<@BOT_USER_ID|Display Name>" tokens from text.
// Used to sanitize partner messages before they reach the classifier, so a
// bot mention in a partner channel is never treated as command surface.
const BOT_MENTION_RE = new RegExp(`<@${BOT_USER_ID}(\\|[^>]*)?>`, 'g');
function stripBotMention(text) {
  if (!text) return '';
  return text.replace(BOT_MENTION_RE, '').replace(/\s+/g, ' ').trim();
}

function parseSlackTeamMention(text, team) {
  const matches = text.matchAll(/<@([A-Z0-9]+)>/g);
  for (const [, userId] of matches) {
    if (team[userId]) return team[userId].name;
  }
  return null;
}

// ─── Heartbeat ─────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
let heartbeatTimer = null;

function startHeartbeat() {
  const targetUser = process.env.HEARTBEAT_USER_ID;
  if (!targetUser) {
    console.log('[heartbeat] HEARTBEAT_USER_ID not set — skipping');
    return () => {};
  }

  const fire = async () => {
    const ts = new Date().toISOString();
    const uptimeMin = Math.round(process.uptime() / 60);
    const text = `:wave: Breez Partner Assistant heartbeat — ${ts} — uptime ${uptimeMin}m`;
    await sendDirectMessage(client, targetUser, text).catch(err =>
      console.error('[heartbeat] DM failed:', err.message));
  };

  // First beat ~2 min after boot so ops sees the bot came up cleanly
  setTimeout(fire, 2 * 60 * 1000);
  heartbeatTimer = setInterval(fire, HEARTBEAT_INTERVAL_MS);
  return () => { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } };
}

// ─── Boot ──────────────────────────────────────────────────────────────────

let stopLearner = () => {};
let stopTelegram = () => {};
let stopHeartbeat = () => {};
let stopDeadman = async () => {};

(async () => {
  try {
    await app.start();
    console.log('[boot] Slack Socket Mode connected');

    stopTelegram = await startTelegramPolling(client);
    stopLearner = startLearner(client);
    stopHeartbeat = startHeartbeat();
    stopDeadman = startDeadman(client);

    console.log('[boot] ready — SLACK + TELEGRAM + LEARNER + HEARTBEAT + DEADMAN all running');
  } catch (err) {
    console.error('[boot] startup failed:', err);
    process.exit(1);
  }
})();

// ─── Graceful shutdown ─────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[shutdown] received ${signal} — stopping services...`);
  // Cancel the pending dead-man alert FIRST (while the Slack app is still
  // running). If app.stop() went first the client wouldn't be usable.
  try { await stopDeadman(); } catch {}
  try { stopHeartbeat(); } catch {}
  try { stopLearner(); } catch {}
  try { stopTelegram(); } catch {}
  try { await app.stop(); } catch {}
  try { closeDb(); } catch {}
  console.log('[shutdown] done');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// SIGUSR2 → hot-reload learned routing rules. Used by the weekly
// pattern_analysis job after it writes data/routing_rules.json, and
// available as a manual shell trigger (`kill -USR2 <pid>`) if you ever
// edit the rules file by hand. NOT a restart — handler returns in
// microseconds, no socket disconnect, no message gap.
// (pm2 itself uses SIGUSR2 for graceful reload in cluster mode — we run
//  in fork mode so there's no conflict.)
process.on('SIGUSR2', () => {
  try {
    const result = reloadLearnedRules();
    console.log(`[signal] SIGUSR2 — learned rules ${result.changed ? 'refreshed' : 'unchanged'}`);
  } catch (err) {
    console.error('[signal] SIGUSR2 reload failed:', err.message);
  }
});
