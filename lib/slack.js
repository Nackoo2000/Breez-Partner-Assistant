// lib/slack.js — Slack helpers refactored for Bolt Socket Mode.
//
// What changed from the v2 HTTP code:
//   - Every helper now takes `client` (a Bolt WebClient) instead of pulling
//     SLACK_BOT_TOKEN via process.env and hand-rolling fetch. One injected
//     dep instead of a hidden global; tests become trivial; token rotation
//     without restart is possible.
//   - Block Kit builder and message-link helpers stay pure — no I/O, no deps.
//   - Event dispatch itself lives in index.js (registered via app.event /
//     app.action / app.view). This file is the "how to talk to Slack" layer.

import { TEAM, BOT_USER_ID, ALLOWED_POST_CHANNELS } from '../config.js';

// ─── Channel info ─────────────────────────────────────────────────────────────

export async function getChannelInfo(client, channelId) {
  let data;
  try {
    data = await client.conversations.info({ channel: channelId });
  } catch (err) {
    console.error(`[slack] getChannelInfo failed for ${channelId}:`, err.data?.error || err.message);
    return { name: channelId, partnerName: channelId };
  }
  const name = data.channel?.name || channelId;

  // Extract partner name from naming pattern (bitkit-breez → Bitkit, breez-bitkit → Bitkit)
  const match = name.match(/^([\w-]+)-breez$|^breez-([\w-]+)$/i);
  const partnerName = match
    ? (match[1] || match[2]).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return { name, partnerName };
}

// ─── User name resolution ─────────────────────────────────────────────────────

export async function getUserName(client, userId, cache = new Map()) {
  if (TEAM[userId]) return TEAM[userId].name;
  if (cache.has(userId)) return cache.get(userId);
  try {
    const data = await client.users.info({ user: userId });
    const name = data.user?.profile?.display_name || data.user?.real_name || userId;
    cache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// ─── Fetch channel context ────────────────────────────────────────────────────

/**
 * Fetch the last 10 top-level messages. If the triggering message belongs to a
 * thread, fully expand only that thread. All other threads stay collapsed.
 *
 * Returns { context, threadParentFound } so the caller can decide whether to
 * skip a thread reply whose parent is older than the 10 fetched messages.
 */
export async function fetchChannelContext(client, channelId, currentThreadTs) {
  const nameCache = new Map();

  let historyData;
  try {
    historyData = await client.conversations.history({ channel: channelId, limit: 10 });
  } catch (err) {
    console.error(`[slack] fetchChannelContext history failed for ${channelId}:`, err.data?.error || err.message);
    return { context: '', threadParentFound: false };
  }
  const topLevel = (historyData.messages || []).reverse();

  const lines = [];
  let threadParentFound = false;

  for (const msg of topLevel) {
    if (msg.bot_id || msg.user === BOT_USER_ID) continue;
    if (msg.subtype && !['file_share', 'thread_broadcast'].includes(msg.subtype)) continue;

    const senderName = msg.user ? await getUserName(client, msg.user, nameCache) : 'Unknown';
    const isTeam = TEAM[msg.user];
    const label = isTeam ? `Team (${senderName})` : senderName;
    const text = (msg.text || '[file/media]').slice(0, 500);

    lines.push(`[${label}]: ${text}`);

    const msgTs = msg.ts;
    const isActiveThread = currentThreadTs && msgTs === currentThreadTs;
    if (isActiveThread) threadParentFound = true;

    if (isActiveThread && msg.reply_count > 0) {
      // Hard cap on expanded replies — avoids blowing up prompt size on pathologically long threads.
      const MAX_THREAD_REPLIES = 120;
      let repliesAdded = 0;
      let cursor;
      let firstPage = true;
      let capReached = false;
      do {
        const params = { channel: channelId, ts: msgTs, limit: 200 };
        if (cursor) params.cursor = cursor;
        let threadData;
        try {
          threadData = await client.conversations.replies(params);
        } catch (err) {
          console.error(`[slack] fetchChannelContext replies failed for ${channelId} ts=${msgTs}:`, err.data?.error || err.message);
          break;
        }
        const page = threadData.messages || [];
        const replies = firstPage ? page.slice(1) : page;
        firstPage = false;
        for (const reply of replies) {
          if (reply.bot_id || reply.user === BOT_USER_ID) continue;
          if (repliesAdded >= MAX_THREAD_REPLIES) { capReached = true; break; }
          const rName = reply.user ? await getUserName(client, reply.user, nameCache) : 'Unknown';
          const rIsTeam = TEAM[reply.user];
          const rLabel = rIsTeam ? `Team (${rName})` : rName;
          const rText = (reply.text || '[file/media]').slice(0, 500);
          lines.push(`  ↳ [${rLabel}]: ${rText}`);
          repliesAdded++;
        }
        if (capReached) {
          lines.push(`  ↳ [… thread truncated after ${MAX_THREAD_REPLIES} replies]`);
          break;
        }
        cursor = threadData.response_metadata?.next_cursor;
      } while (cursor);
    }
  }

  return { context: lines.join('\n'), threadParentFound };
}

// ─── Posting ──────────────────────────────────────────────────────────────────

export async function postMessage(client, channelId, text) {
  if (!ALLOWED_POST_CHANNELS.has(channelId)) {
    console.error(`[slack] postMessage blocked — channel ${channelId} is not in the allowed list`);
    return null;
  }
  try {
    return await client.chat.postMessage({ channel: channelId, text, unfurl_links: false });
  } catch (err) {
    console.error('[slack] postMessage error:', err.data?.error || err.message);
    return null;
  }
}

/**
 * Post a Block Kit message. Returns the Slack API response (caller needs .ts).
 * When color is set, the blocks are wrapped in an attachment so Slack renders
 * the colored left-bar (same pattern as Jira/PagerDuty).
 */
export async function postBlocks(client, channelId, blocks, fallbackText = '', color = null) {
  if (!ALLOWED_POST_CHANNELS.has(channelId)) {
    console.error(`[slack] postBlocks blocked — channel ${channelId} is not in the allowed list`);
    return null;
  }
  const body = color
    ? { channel: channelId, text: fallbackText, unfurl_links: false, attachments: [{ color, blocks }] }
    : { channel: channelId, blocks, text: fallbackText, unfurl_links: false };
  try {
    return await client.chat.postMessage(body);
  } catch (err) {
    console.error('[slack] postBlocks error:', err.data?.error || err.message);
    return null;
  }
}

export async function updateMessage(client, channelId, ts, blocks, fallbackText = '', color = null) {
  const body = color
    ? { channel: channelId, ts, text: fallbackText, attachments: [{ color, blocks }] }
    : { channel: channelId, ts, blocks, text: fallbackText };
  try {
    return await client.chat.update(body);
  } catch (err) {
    console.error('[slack] updateMessage error:', err.data?.error || err.message);
    return null;
  }
}

export async function openModal(client, triggerId, view) {
  try {
    return await client.views.open({ trigger_id: triggerId, view });
  } catch (err) {
    console.error('[slack] openModal error:', err.data?.error || err.message);
    return { ok: false, error: err.data?.error || err.message };
  }
}

/**
 * Direct-message a user. Opens (or reuses) the IM channel first. Used by the
 * heartbeat loop so ops always has an unambiguous "bot is alive" signal.
 */
export async function sendDirectMessage(client, userId, text) {
  try {
    const im = await client.conversations.open({ users: userId });
    const channel = im.channel?.id;
    if (!channel) return null;
    return await client.chat.postMessage({ channel, text, unfurl_links: false });
  } catch (err) {
    console.error('[slack] sendDirectMessage error:', err.data?.error || err.message);
    return null;
  }
}

// ─── Reactions + thread replies (Lane A/B ack) ────────────────────────────

/**
 * Add an emoji reaction to a message. `name` is the Slack reaction shortname
 * without colons (e.g. 'white_check_mark', 'thinking_face', 'eyes', 'warning').
 * Failures are logged and swallowed — a missing scope should never crash the
 * message handler.
 */
export async function addReaction(client, channelId, ts, name) {
  try {
    return await client.reactions.add({ channel: channelId, timestamp: ts, name });
  } catch (err) {
    const code = err?.data?.error || err.message;
    if (code !== 'already_reacted') {
      console.warn(`[slack] addReaction "${name}" failed (${code}) — requires reactions:write scope`);
    }
    return null;
  }
}

/**
 * Post a reply in the same thread as `parentTs`. For Lane A, parentTs is the
 * triggering @-mention message itself; for Lane B, parentTs is the routing
 * card's top-level message.
 */
export async function postThreadReply(client, channelId, parentTs, text) {
  if (!ALLOWED_POST_CHANNELS.has(channelId)) {
    console.error(`[slack] postThreadReply blocked — channel ${channelId} not in allowed list`);
    return null;
  }
  try {
    return await client.chat.postMessage({
      channel: channelId,
      thread_ts: parentTs,
      text,
      unfurl_links: false,
    });
  } catch (err) {
    console.error('[slack] postThreadReply error:', err.data?.error || err.message);
    return null;
  }
}

// ─── Block Kit builder ────────────────────────────────────────────────────────

/**
 * Build Block Kit blocks + a sidebar color for a partner inquiry notification.
 *
 * State 1 — initial inquiry        → single "Suggested" field
 * State 2 — manually reassigned    → two-column "Originally / Reassigned to"
 *
 * Set lowConfidence: true to inline a ⚠️ caveat under the summary — the
 * real-time "confidence flag" learner signal.
 */
export function buildNotificationBlocks({
  partnerName, summary, suggestedName, suggestedId,
  messageLink, routingId, noLinkLabel,
  correctedName, correctedId, correctedBy, correctionReason,
  lowConfidence,
}) {
  const originalMention = suggestedId ? `<@${suggestedId}>` : suggestedName;

  let personBlock;
  if (correctedName) {
    const correctedMention = correctedId ? `<@${correctedId}>` : correctedName;
    const rightLines = [`*Reassigned to*`, correctedMention, `_by ${correctedBy}_`];
    if (correctionReason) rightLines.push(`_${correctionReason}_`);
    personBlock = {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Originally suggested*\n${originalMention}` },
        { type: 'mrkdwn', text: rightLines.join('\n') },
      ],
    };
  } else {
    personBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Suggested:* ${originalMention}` },
    };
  }

  const actionButtons = [];
  if (messageLink) {
    actionButtons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View message ↗', emoji: true },
      url: messageLink,
      action_id: 'view_message_link',
    });
  } else if (noLinkLabel) {
    actionButtons.push({
      type: 'button',
      text: { type: 'plain_text', text: noLinkLabel },
      action_id: 'no_link_info',
    });
  }
  if (routingId) {
    actionButtons.push({
      type: 'button',
      text: { type: 'plain_text', text: '↺ Reassign', emoji: true },
      action_id: 'reassign_click',
      value: String(routingId),
    });
  }

  const headerEmoji = correctedName ? '🔵' : '🟡';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${headerEmoji} ${partnerName}`, emoji: true },
    },
    ...(summary ? [{ type: 'section', text: { type: 'mrkdwn', text: summary } }] : []),
    ...(lowConfidence && !correctedName ? [{
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '⚠️ Low-confidence routing — double-check before pinging' }],
    }] : []),
    { type: 'divider' },
    personBlock,
    ...(actionButtons.length > 0 ? [{ type: 'actions', elements: actionButtons }] : []),
  ];

  return { blocks, color: null };
}

// ─── Message permalink (pure function, no client needed) ──────────────────────

export function buildMessageLink(channelId, ts, threadTs) {
  const tsClean = ts.replace('.', '');
  let url = `https://breez-tech.slack.com/archives/${channelId}/p${tsClean}`;
  if (threadTs && threadTs !== ts) {
    url += `?thread_ts=${threadTs}&cid=${channelId}`;
  }
  return url;
}
