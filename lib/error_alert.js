// lib/error_alert.js — in-process classifier error-rate alerter.
//
// The dead-man switch only fires daily. If the Haiku classifier starts
// silently failing (rate limit, rotated API key, DNS hiccup, upstream outage)
// we don't want to wait until the next dead-man tick to notice. This module
// tracks classifier errors in a sliding window and DMs Ivan when the rate
// crosses a threshold. Alerts are throttled to at most one per hour so we
// don't spam him during a sustained outage.
//
// State is per-process and resets on pm2 restart. That's intentional — a
// restart is itself a signal and we don't want stale alert state persisting.

import { sendDirectMessage } from './slack.js';

const WINDOW_MS         = 10 * 60 * 1000;   // 10-minute sliding window
const THRESHOLD         = 5;                // errors within window to alert
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;   // max one DM per hour
const IVAN_SLACK_ID     = 'U04SQF99B8S';

const errorTimestamps = [];
let lastAlertAt = 0;

/**
 * Record the outcome of one analyzeMessage() call. If the result indicates a
 * classifier error (the catch-block fallback in lib/claude.js sets
 * classifierError: true), bump the window and maybe DM Ivan. Non-fatal.
 */
export async function trackClassifierResult(slackClient, analysis) {
  if (!analysis?.classifierError) return;

  const now = Date.now();
  errorTimestamps.push(now);
  // Drop anything outside the window.
  while (errorTimestamps.length && errorTimestamps[0] < now - WINDOW_MS) {
    errorTimestamps.shift();
  }
  if (errorTimestamps.length < THRESHOLD) return;
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;

  lastAlertAt = now;
  const minutes = Math.round(WINDOW_MS / 60000);
  const msg = `:rotating_light: Classifier is failing — ${errorTimestamps.length} errors in the last ${minutes} min. Messages are routing to Ivan by fallback. Check \`pm2 logs breez-bot\` and https://status.anthropic.com.`;
  try {
    await sendDirectMessage(slackClient, IVAN_SLACK_ID, msg);
    console.log(`[error_alert] DMed Ivan — ${errorTimestamps.length} classifier errors in ${minutes}m`);
  } catch (err) {
    console.error('[error_alert] DM failed:', err.message);
  }
}
