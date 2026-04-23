// lib/deadman.js — Slack-native dead-man switch.
//
// Alerts the team when the bot dies, using only Slack APIs we already have
// access to. No external services, no accounts, no credentials.
//
// How it works:
//   Every CHECK_IN_MS (5 min), the bot:
//     (a) Lists every pending scheduled message in the alert channel that
//         matches our deadman prefix, and deletes each one. This is authoritative
//         state from Slack, not a cached ID — so we don't rely on sqlite KV
//         tracking the right message.
//     (b) Schedules a fresh alert ALERT_POST_AT_MS (15 min) in the future.
//   As long as the bot is alive, each alert is cancelled well before it fires.
//
//   If the bot dies (process crashes, VPS down, network gone), the most
//   recent alert is NOT cancelled and fires ~10–15 min later in
//   #partners-assistant. That's the alert.
//
// Why list-and-delete instead of tracking one ID:
//   Slack's delete API occasionally returns ok for a scheduled message that
//   still fires (or returns `invalid_scheduled_message_id` for one that's
//   still pending). Tracking a single cached ID makes this bug fatal —
//   one failed cancel = one false alert. Listing pending messages on every
//   tick makes us self-healing: if a cancel didn't actually take effect,
//   the NEXT tick sees the message still pending and tries again. With a
//   15-min post_at window and 5-min ticks, we get 2 cancel chances before
//   the alert fires, so a single Slack API glitch no longer cries wolf.
//
// Failure modes covered:
//   - pm2 restart → shutdown handler cancels all pending → clean start
//     reschedules one within a few seconds. Silent.
//   - Hard crash (OOM, segfault) → no shutdown runs → pending alert fires.
//     Team sees the alert within ~10–15 min. New instance on next boot
//     cleans up whatever orphans it finds in its first tick.
//   - VPS down → same as hard crash from Slack's perspective.
//   - Slack API transient error during cancel → absorbed by next tick.

import { ASSISTANT_CHANNEL_ID } from '../config.js';

const CHECK_IN_MS      = 5  * 60 * 1000;   // tick every 5 min
const ALERT_POST_AT_MS = 15 * 60 * 1000;   // alerts live 15 min ahead (2 cancel chances)
const ALERT_PREFIX     = ':rotating_light: Breez bot is DOWN';

function buildAlertPayload() {
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = `${ALERT_PREFIX} — last healthy check-in ${nowIso} UTC`;
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':rotating_light: Breez bot is DOWN', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Last healthy check-in: *${nowIso} UTC* (~10–15 min ago).\n\nThe bot has stopped sending dead-man cancellations. Likely causes: process crashed and pm2 gave up, VPS unreachable, or network issue.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Recover:*\n`ssh breez@65.108.147.171`\n`pm2 status breez-bot`\n`pm2 restart breez-bot`\n`pm2 logs breez-bot --lines 50`',
      },
    },
  ];
  return { text, blocks };
}

/**
 * Lists every pending scheduled message in the alert channel that matches
 * our deadman prefix, and deletes each. Returns how many we successfully
 * cancelled and how many were already fired/invalid (treated as no-op).
 * Never throws — logs and moves on.
 */
async function cancelAllPending(client, reason) {
  let found = 0, cancelled = 0, stale = 0, failed = 0;
  try {
    const list = await client.chat.scheduledMessages.list({ channel: ASSISTANT_CHANNEL_ID });
    const ours = (list?.scheduled_messages ?? []).filter(m =>
      typeof m.text === 'string' && m.text.startsWith(ALERT_PREFIX)
    );
    found = ours.length;
    for (const m of ours) {
      try {
        await client.chat.deleteScheduledMessage({
          channel: ASSISTANT_CHANNEL_ID,
          scheduled_message_id: m.id,
        });
        cancelled++;
      } catch (err) {
        const code = err?.data?.error || err?.message || 'unknown';
        if (code === 'invalid_scheduled_message_id') {
          // Already fired OR within Slack's 60-second pre-fire window — nothing to do
          stale++;
        } else {
          failed++;
          console.warn(`[deadman] cancel ${m.id} returned "${code}" (${reason})`);
        }
      }
    }
  } catch (err) {
    console.error(`[deadman] list+cancel failed (${reason}):`, err?.data?.error || err.message);
  }
  return { found, cancelled, stale, failed };
}

async function scheduleFreshAlert(client) {
  const postAt = Math.floor((Date.now() + ALERT_POST_AT_MS) / 1000);
  const { text, blocks } = buildAlertPayload();
  try {
    const result = await client.chat.scheduleMessage({
      channel: ASSISTANT_CHANNEL_ID,
      post_at: postAt,
      text,
      blocks,
    });
    if (!result?.scheduled_message_id) {
      console.warn('[deadman] scheduleMessage returned no id — next tick will retry');
      return null;
    }
    return result.scheduled_message_id;
  } catch (err) {
    console.error('[deadman] scheduleMessage failed:', err?.data?.error || err.message);
    return null;
  }
}

async function tick(client) {
  try {
    const cleanup = await cancelAllPending(client, 'tick');
    const newId = await scheduleFreshAlert(client);
    if (cleanup.found > 1 || cleanup.failed > 0) {
      console.warn(
        `[deadman] tick — found=${cleanup.found} cancelled=${cleanup.cancelled} ` +
        `stale=${cleanup.stale} failed=${cleanup.failed} scheduled=${newId || 'none'}`
      );
    }
  } catch (err) {
    console.error('[deadman] tick error:', err.message);
  }
}

/**
 * Start the dead-man switch. Returns a stop() function that cancels every
 * pending alert (so a planned shutdown doesn't false-alarm) and stops the loop.
 */
export function startDeadman(client) {
  if (process.env.DEADMAN_DISABLED === 'true') {
    console.log('[deadman] DEADMAN_DISABLED=true — skipping');
    return async () => {};
  }

  console.log('[deadman] starting — check-in every 5 min, alert fires ~15 min after last tick');

  // Fire the first check-in immediately so coverage starts at boot. Any
  // stale pending alert left over from a crashed previous instance gets
  // cleaned up in this first tick.
  tick(client);

  const timer = setInterval(() => tick(client), CHECK_IN_MS);

  return async function stopDeadman() {
    clearInterval(timer);
    const cleanup = await cancelAllPending(client, 'shutdown');
    console.log(`[deadman] stopped — cancelled ${cleanup.cancelled} of ${cleanup.found} pending`);
  };
}
