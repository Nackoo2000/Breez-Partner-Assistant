// lib/telegram.js — Telegram long-polling loop + message handler.
//
// Replaces the previous webhook handler at api/telegram.js. The shape of the
// business logic is deliberately identical — classify, cooldown, notify — so
// any regression is easy to spot.
//
// Long polling vs webhook:
//   - getUpdates with timeout=25 holds an outbound request open for up to 25s.
//   - No inbound port to open.
//   - offset = last seen update_id + 1 is how we acknowledge; Telegram drops
//     every update <= (offset-1) from the server-side queue.
//   - If the process dies mid-batch, whatever we didn't ack is redelivered.

import { BREEZ_TEAM_TELEGRAM_IDS, TELEGRAM_ID_TO_NAME, ASSISTANT_CHANNEL_ID, TEAM_ID_BY_NAME } from '../config.js';
import { analyzeMessage } from './claude.js';
import {
  storeTelegramMessage, getTelegramContext, tryClaimCooldown,
  logRouting, recordResponse, storeMessageTs, recordRoyMention,
} from './sqlite.js';
import { buildTelegramLink } from './utils.js';
import { postBlocks, buildNotificationBlocks } from './slack.js';

const TG_API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const POLL_TIMEOUT_SEC = 25;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

let running = false;
let stopping = false;

// ─── Telegram API helpers ──────────────────────────────────────────────────

async function tgCall(method, body = {}) {
  const resp = await fetch(`${TG_API()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function getUpdates(offset) {
  // timeout sec, allowed_updates filters out noise (edited msgs, reactions, etc)
  return tgCall('getUpdates', {
    offset,
    timeout: POLL_TIMEOUT_SEC,
    allowed_updates: ['message'],
  });
}

/**
 * Before starting the polling loop, ensure no webhook is set. The Vercel
 * deployment had one; if it's still registered, Telegram refuses to serve
 * getUpdates and returns "Conflict: terminated by other getUpdates request"
 * or "can't use getUpdates method while webhook is active". Idempotent.
 */
export async function deleteWebhook() {
  try {
    const resp = await tgCall('deleteWebhook', { drop_pending_updates: false });
    if (!resp.ok) {
      console.warn('[telegram] deleteWebhook returned not-ok:', resp.description);
    }
  } catch (err) {
    console.warn('[telegram] deleteWebhook failed (will try anyway):', err.message);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isOnlyEmoji(text) {
  return text.trim().length > 0 && !/[\p{L}\p{N}\p{P}]/u.test(text);
}

/**
 * Parse a Telegram message for the first text_mention of a known team member.
 * text_mention entities carry user.id directly — works for users without @usernames.
 */
function parseTelegramTeamMention(message, teamIds, idToName) {
  const entities = message.entities || message.caption_entities || [];
  for (const entity of entities) {
    if (entity.type === 'text_mention' && entity.user) {
      const userId = String(entity.user.id);
      if (teamIds.has(userId) && idToName[userId]) return idToName[userId];
    }
  }
  return null;
}

// ─── Per-message handler ───────────────────────────────────────────────────

async function handleMessage(message, slackClient) {
  const messageText = message?.text || message?.caption;
  if (!messageText?.trim()) return;
  if (isOnlyEmoji(messageText)) return;
  if (process.env.SYSTEM_PAUSED === 'true') return;

  const chatId = String(message.chat?.id);
  const chatTitle = message.chat?.title || 'Unknown Group';
  const senderId = String(message.from?.id);
  const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Unknown';
  const isTeam = BREEZ_TEAM_TELEGRAM_IDS.has(senderId);

  await storeTelegramMessage({ chatId, senderName, isTeam, messageText });

  if (isTeam) {
    const teamName = TELEGRAM_ID_TO_NAME[senderId];
    if (teamName) recordResponse({ channelId: chatId, actualPerson: teamName }).catch(() => {});
    if (teamName === 'Roy') {
      const mentioned = parseTelegramTeamMention(message, BREEZ_TEAM_TELEGRAM_IDS, TELEGRAM_ID_TO_NAME);
      if (mentioned) recordRoyMention({ channelId: chatId, mentionedPerson: mentioned }).catch(() => {});
    }
    return;
  }

  try {
    const context = await getTelegramContext(chatId);
    const analysis = await analyzeMessage({
      partnerName: chatTitle, context, newMessageText: messageText, senderName,
    });

    if (!analysis.isInquiry) {
      console.log(`[telegram] ${chatTitle}: not an inquiry — skipping`);
      return;
    }

    const messageId = String(message.message_id);
    const topicId = message.message_thread_id ? String(message.message_thread_id) : null;
    const messageLink = buildTelegramLink(chatId, messageId, topicId);

    const suggestedName = analysis.suggestedPerson || 'Ivan';
    const suggestedId = TEAM_ID_BY_NAME[suggestedName];

    if (!await tryClaimCooldown(chatId, suggestedName)) {
      console.log(`[telegram] ${chatTitle}: ${suggestedName} already pinged in last 5 min — skipping`);
      return;
    }

    const routingId = await logRouting({
      channelId: chatId,
      partnerName: chatTitle,
      suggestedPerson: suggestedName,
      summary: analysis.summary,
      partnerMessageLink: messageLink || null,
    }).catch(() => null);

    const { blocks, color } = buildNotificationBlocks({
      partnerName: chatTitle,
      summary: analysis.summary,
      suggestedName,
      suggestedId,
      messageLink,
      routingId,
      noLinkLabel: messageLink ? undefined : 'TG - no link',
      lowConfidence: analysis.lowConfidence,
    });

    const postResult = await postBlocks(
      slackClient,
      ASSISTANT_CHANNEL_ID,
      blocks,
      `${chatTitle} — ${suggestedName}`,
      color,
    );

    if (routingId && postResult?.ts) {
      storeMessageTs(routingId, postResult.ts).catch(() => {});
    }

    console.log(`[telegram] ${chatTitle} inquiry posted → ${suggestedName}`);
  } catch (err) {
    console.error('[telegram] handleMessage error:', err.message);
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────

/**
 * Start the long-polling loop. Returns a stop() function.
 *
 * slackClient is the Bolt WebClient — passed in rather than imported so the
 * telegram module doesn't have to know whether Slack is initialised yet.
 */
export async function startTelegramPolling(slackClient) {
  if (running) {
    console.warn('[telegram] polling already running — ignoring duplicate start');
    return () => {};
  }
  running = true;
  stopping = false;

  await deleteWebhook();
  console.log('[telegram] long polling started');

  let offset = 0;
  let backoff = BACKOFF_MIN_MS;

  (async () => {
    while (!stopping) {
      try {
        const resp = await getUpdates(offset);
        if (!resp.ok) {
          // 409 Conflict = a webhook is active or another getUpdates is running
          console.error('[telegram] getUpdates not-ok:', resp.error_code, resp.description);
          if (resp.error_code === 409) {
            await deleteWebhook();
          }
          await sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          continue;
        }

        backoff = BACKOFF_MIN_MS; // reset on success

        for (const update of resp.result || []) {
          offset = update.update_id + 1;
          if (update.edited_message) continue;
          if (!update.message) continue;
          await handleMessage(update.message, slackClient);
        }
      } catch (err) {
        console.error('[telegram] loop error:', err.message);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
    running = false;
    console.log('[telegram] long polling stopped');
  })();

  return () => { stopping = true; };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
