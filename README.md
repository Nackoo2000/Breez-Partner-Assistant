# Breez Partner Assistant

A Slack + Telegram routing bot for partner support. It classifies inbound
partner messages across many channels, picks the most relevant team member
based on their area of expertise, and posts a compact notification into a
single internal channel so nothing falls through the cracks.

## What it does

- Watches partner Slack channels the bot is a member of.
- Watches partner Telegram groups the bot is a member of.
- For each message that looks like a real support inquiry (not banter, not an
  emoji-only reaction, not a team member's own reply), classifies the topic
  with an LLM and suggests the team member most likely to own the area.
- Posts a single Block Kit notification into an internal routing channel,
  with a **Reassign** button for one-click correction if the routing is off.
- Every Reassign click is stored as feedback and drives the learning loop.

## Architecture (one process, no public ports)

Slack is connected via **Socket Mode** (one persistent outbound WebSocket —
no inbound HTTP). Telegram is connected via **long polling** (the bot holds
an open request to Telegram's API for 25s at a time — again, no inbound HTTP).

The entire bot is a single Node.js process managed by `pm2`. State lives in
a local SQLite file (`data/breez-bot.db`) — small enough that a backup is a
single file copy.

```
                  ┌─────────────────────────────────────────────┐
                  │         Node.js process (pm2)               │
                  │                                             │
   Slack  ◀──────▶│  Bolt Socket Mode                           │
                  │   - message events                          │
                  │   - reassign button + modal                 │
                  │                                             │
   Telegram ◀────▶│  Long polling (getUpdates, 25s)             │
                  │                                             │
   Anthropic ───▶ │  Claude Haiku (real-time classification)    │
                  │  Claude Sonnet (periodic learner jobs)      │
                  │                                             │
   GitHub ──────▶ │  Monthly expertise recalibration            │
                  │                                             │
                  │  SQLite: routing_log, cooldowns, context    │
                  │  rules file: data/routing_rules.json        │
                  └─────────────────────────────────────────────┘
```

No public port is open. Nothing outside the process can send packets to it.
Every external service is reached by outbound connection only.

## Autonomous learning loop

On top of the real-time router, a scheduler runs four background jobs:

| Job | Frequency | Purpose |
|---|---|---|
| Pattern analysis | Sunday 23:00 UTC | Reads 30 days of routing decisions + corrections, lets an LLM propose rule changes, writes to `data/routing_rules.json` (archived before overwrite). |
| Confidence flag | Real-time | Low-confidence routings are flagged inline in the notification. |
| Weekly digest | Monday 08:00 UTC | Posts a short performance summary into the internal channel. |
| Monthly expertise check | First Monday 07:00 UTC | Cross-references GitHub activity against the team handles description — updates ownership hints if someone has clearly taken over an area. |

All four live in `lib/learner.js`. They run in-process, tick every 60s and
compare against `last_run_at` in SQLite so reboots don't cause drift and
missed fires are caught up on next boot. They honour a `LEARNER_DISABLED=true`
kill switch.

## Production deployment (current)

The bot runs as a single Node process on a **Hetzner VPS** (2 vCPU / 4 GiB
RAM / 40 GB disk) supervised by `pm2`, which is itself a `systemd` unit —
so if the VPS reboots, pm2 comes back and the bot comes back with it.

- **Process supervision**: `pm2` fork mode, `autorestart: true`,
  `max_memory_restart: 300M`, `min_uptime: 10s`, `max_restarts: 10`.
- **Boot persistence**: `systemctl is-enabled pm2-breez` → enabled.
- **Log rotation**: `pm2-logrotate` capped at 10 MB × 14 files, daily.
- **Persistence**: SQLite WAL mode at `data/breez-bot.db`.
- **External healthcheck**: a 2-minute cron on the VPS pings
  [healthchecks.io](https://healthchecks.io) only when `pm2 pid breez-bot`
  reports a live PID. If pings stop arriving for >5 min, healthchecks.io
  emails/Slacks the operator. Silent when healthy.
- **Daily DB backup**: a Windows Task Scheduler job pulls `sqlite3 .backup`
  over SSH to an off-VPS machine.

## Running it yourself

This bot is tightly coupled to one organisation's Slack + Telegram setup,
so running it verbatim isn't the point. The code is published as a reference
for anyone building a similar partner-support router.

The general shape if you wanted to adapt it:

1. Create a Slack app with Socket Mode enabled. You need `SLACK_BOT_TOKEN`
   and `SLACK_APP_TOKEN`.
2. Create a Telegram bot via BotFather. You need `TELEGRAM_BOT_TOKEN`.
3. Get an Anthropic API key (`ANTHROPIC_API_KEY`) for Claude Haiku + Sonnet.
4. Optional: a no-scope GitHub PAT (`GITHUB_TOKEN`) for the monthly
   expertise check (raises GitHub's API rate limit from 60/hr to 5000/hr).
5. Rewrite `config.js` with your team — Slack IDs, Telegram IDs, short
   descriptions of each member's area of expertise.
6. Deploy to any Linux server. The recommended setup is Node 22 LTS, a
   non-root service user, and `pm2` with `pm2-logrotate`.

Required env vars:

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Post messages to Slack (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Socket Mode (`xapp-...`, needs `connections:write`) |
| `ANTHROPIC_API_KEY` | Claude Haiku + Sonnet |
| `TELEGRAM_BOT_TOKEN` | Telegram long polling |

Optional env vars:

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | _unset_ | Raises GitHub API limit from 60/hr → 5000/hr for the monthly expertise check. Classic PAT recommended (fine-grained tokens > 366 days are blocked by the `breez` org policy). Public-read is enough. |
| `HEARTBEAT_USER_ID` | _unset_ | Slack user ID. Bot DMs them a 12-hour "still alive" message. If unset, heartbeat is skipped. |
| `SYSTEM_PAUSED` | `false` | Set to `true` to pause message processing without stopping the process. |
| `LEARNER_DISABLED` | `false` | Set to `true` to skip all scheduled learner jobs (kill switch). |
| `CLASSIFIER_DISABLED` | `false` | Set to `true` to skip Claude API calls entirely — every message routes straight to Ivan with lowConfidence=true. Use during an Anthropic outage or to freeze API spend without stopping Slack/Telegram intake. |
| `BREEZ_DB_PATH` | `data/breez-bot.db` | Override the SQLite file location. |
| `BREEZ_ROUTING_RULES_PATH` | `data/routing_rules.json` | Override the learner's rules file. |

## Deploying

The repo ships a `pm2` config tuned for this exact workload:

```
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup       # print + run the sudo command it shows
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

Important: `ecosystem.config.cjs` uses `exec_mode: 'fork'` with a single
instance. Do **not** switch it to cluster mode — Socket Mode holds one
persistent WebSocket per process, and the Telegram long-poll holds another.
Clustering them would produce duplicate routings.

One-shot manual operations:

```
npm run preflight                     # run before every deploy — catches
                                      # config typos, missing deps, bad JSON
npm run learner:run-now -- weekly_digest
npm run learner:run-now -- pattern_analysis
```

The repo also ships a Windows backup helper under `scripts/ops/` — a daily
`sqlite3 .backup`-over-SSH pull to a Windows machine, registered with Task
Scheduler. If you want it, `python scripts/ops/register_backup_task.py` sets
it up; see the script docstring for env vars.

## Design notes worth knowing

- **SQLite, not PostgreSQL.** The data volume is tiny (small four-digit row
  counts per year). One process, no concurrent writers, no replication need.
  Backup is a single file. No Postgres instance to baby.
- **Claude Haiku for real-time, Sonnet for batch.** Classification is a
  small, speed-sensitive task (Haiku). Pattern analysis and digest writing
  are reasoning-heavy and infrequent (Sonnet).
- **Prompt caching** on the stable system prompt keeps real-time cost low.
- **Retries are not retried.** Slack's HTTP webhook path retries failed
  deliveries after 3 seconds — a cold start or a slow LLM call would cause
  the event to be retried and double-processed. Socket Mode removes the
  retry entirely: the WebSocket doesn't time out, so there's no retry
  header to ignore and no lost events.
- **Cooldown is (channel, person)-keyed**, not channel-keyed. A different
  topic in the same channel routed to a different person can still alert
  even if another person was just pinged in that channel.

## License

MIT — see [LICENSE](LICENSE).
