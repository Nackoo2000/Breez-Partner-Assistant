// ecosystem.config.cjs — pm2 process definition for the VPS deploy.
//
// On the VPS:
//   cd /home/breez/breez-bot
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup   # generates systemd unit — run the printed sudo command
//
// pm2-logrotate (installed separately via `pm2 install pm2-logrotate`) rotates
// the logs; the module options below are what we keep on the DO side.

module.exports = {
  apps: [
    {
      name: 'breez-bot',
      script: 'index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      // Socket Mode holds one persistent WebSocket — never cluster this.
      autorestart: true,
      max_memory_restart: '300M',
      // Restart on crash, but stop the crash-loop if it can't stay up >10s.
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 2_000,
      kill_timeout: 10_000, // gives shutdown() time to flush the SQLite connection
      wait_ready: false,
      env: {
        NODE_ENV: 'production',
      },
      // Relative log paths — pm2 resolves these to ~/.pm2/logs/ unless an
      // absolute path is given. We rely on pm2-logrotate (configured below)
      // for retention.
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true, // prefix each log line with ISO timestamp
    },
  ],
};

// ─── pm2-logrotate recommended config ─────────────────────────────────────
//
// After installing pm2-logrotate, run these on the VPS once:
//
//   pm2 set pm2-logrotate:max_size 10M
//   pm2 set pm2-logrotate:retain 14
//   pm2 set pm2-logrotate:compress true
//   pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
//
// Meaning: rotate when any log hits 10MB OR at midnight UTC, keep 14
// compressed archives, then delete the oldest. ~140MB cap on log disk usage.
