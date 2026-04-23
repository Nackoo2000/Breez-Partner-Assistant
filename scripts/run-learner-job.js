// scripts/run-learner-job.js — manually trigger one of the learner jobs.
//
// Usage:
//   npm run learner:run-now -- pattern_analysis
//   npm run learner:run-now -- weekly_digest
//
// Handy when you want to preview a weekly digest mid-week, or re-run last
// Sunday's pattern analysis after fixing a bug, without waiting for the
// scheduled fire time.
//
// This bypasses the scheduler's last_run_at guard but then updates
// last_run_at afterward, so the regular scheduler won't immediately re-fire
// the same job when the bot next ticks.

import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { runJobByName } from '../lib/learner.js';
import { closeDb } from '../lib/sqlite.js';

const jobName = process.argv[2];
if (!jobName) {
  console.error('usage: npm run learner:run-now -- <job_name>');
  console.error('valid job names: pattern_analysis | weekly_digest');
  process.exit(2);
}

if (!process.env.SLACK_BOT_TOKEN) {
  console.error('SLACK_BOT_TOKEN not set (needed for digest/expertise jobs that post to Slack)');
  process.exit(1);
}

// Use a plain WebClient — we don't need the full Bolt app for a one-shot post,
// and booting Bolt would also start Socket Mode, which we don't want here.
const client = new WebClient(process.env.SLACK_BOT_TOKEN);

(async () => {
  try {
    await runJobByName(jobName, client);
    closeDb();
    process.exit(0);
  } catch (err) {
    console.error('[run-learner-job] failed:', err.message);
    try { closeDb(); } catch {}
    process.exit(1);
  }
})();
