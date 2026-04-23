#!/usr/bin/env python3
"""
Weekly pull of the Breez bot SQLite DB + learned routing rules from the
Hetzner VPS (65.108.147.171) to this Windows laptop.

Invoked by Windows Task Scheduler (task: "Breez-Bot-Weekly-Backup"), but
safe to run manually any time: `python scripts/weekly_backup.py`.

What it does:
  1. SSH to the VPS as root, run `sqlite3 .backup` on the live DB. This
     produces a consistent snapshot even while the bot is writing (WAL-safe).
  2. scp the snapshot + routing_rules.json back to this laptop, into a
     dated subfolder under backups/.
  3. Clean up the /tmp snapshot on the VPS — nothing persists there.
  4. Rotate local backups: keep the 4 most recent dated folders, delete
     older ones.
  5. Notify on start and finish (per global CLAUDE.md convention).

Design choices:
  - No cron on the VPS. The laptop drives the whole process by SSH. If the
    laptop is offline when the task fires, the task catches up when it's
    next available (StartWhenAvailable flag on the Scheduler trigger).
  - Backups are .db files only — no secrets, but they do contain
    partner-confidential summaries, so they're gitignored and never leave
    this laptop.
  - Retention of 4 weekly rotations gives up to a 4-week rollback window
    against silent corruption or a bug that's not noticed for a few days.
"""

import subprocess
import sys
from datetime import datetime
from pathlib import Path

# ─── config ──────────────────────────────────────────────────────────────────
VPS_HOST        = "root@65.108.147.171"
VPS_KEY         = r"D:\Cursor\Start9\hetzner_vps"
VPS_DB_PATH     = "/home/breez/breez-bot/data/breez-bot.db"
VPS_RULES_PATH  = "/home/breez/breez-bot/data/routing_rules.json"
VPS_TMP_DB      = "/tmp/breez-bot-snapshot.db"

PROJECT_ROOT    = Path(r"D:\Cursor\Breez\Breez Slack")
BACKUPS_ROOT    = PROJECT_ROOT / "backups"
LOG_FILE        = BACKUPS_ROOT / "backup.log"
RETENTION       = 4  # keep 4 most recent dated folders

SSH_OPTS = [
    "-i", VPS_KEY,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",           # fail fast if key auth doesn't work
    "-o", "ConnectTimeout=30",
]

# CREATE_NO_WINDOW — keeps PowerShell from flashing a console when launched
# from a hidden Task Scheduler job.
CREATE_NO_WINDOW = 0x08000000


# ─── helpers ─────────────────────────────────────────────────────────────────
def notify(title: str, message: str) -> None:
    """Windows toast via PowerShell NotifyIcon. No extra packages needed."""
    safe_title = title.replace("'", "''")
    safe_msg = message.replace("'", "''")
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$n = New-Object System.Windows.Forms.NotifyIcon;"
        "$n.Icon = [System.Drawing.SystemIcons]::Information;"
        "$n.Visible = $true;"
        f"$n.ShowBalloonTip(8000, '{safe_title}', '{safe_msg}', "
        "[System.Windows.Forms.ToolTipIcon]::Info);"
        "Start-Sleep -Seconds 9;"
        "$n.Dispose()"
    )
    try:
        subprocess.Popen(
            ["powershell", "-WindowStyle", "Hidden", "-Command", ps],
            creationflags=CREATE_NO_WINDOW,
        )
    except Exception:
        pass  # best-effort; never let a missed toast fail the backup


def log(msg: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] {msg}"
    print(line)
    try:
        BACKUPS_ROOT.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        print(f"  (log write failed: {e})")


def run_ssh(remote_cmd: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", *SSH_OPTS, VPS_HOST, remote_cmd],
        capture_output=True, text=True, timeout=timeout,
    )


def run_scp(remote_path: str, local_path: Path, timeout: int = 180) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["scp", *SSH_OPTS, f"{VPS_HOST}:{remote_path}", str(local_path)],
        capture_output=True, text=True, timeout=timeout,
    )


def _looks_dated(name: str) -> bool:
    try:
        datetime.strptime(name, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def rotate_backups() -> int:
    """Keep RETENTION newest date-named folders. Return count deleted."""
    if not BACKUPS_ROOT.exists():
        return 0
    dated = sorted(
        (p for p in BACKUPS_ROOT.iterdir() if p.is_dir() and _looks_dated(p.name)),
        key=lambda p: p.name,
        reverse=True,
    )
    to_delete = dated[RETENTION:]
    deleted = 0
    for p in to_delete:
        try:
            for child in p.iterdir():
                child.unlink()
            p.rmdir()
            log(f"rotated out: {p.name}")
            deleted += 1
        except Exception as e:
            log(f"rotate failed for {p.name}: {e}")
    return deleted


# ─── main ────────────────────────────────────────────────────────────────────
def main() -> int:
    notify("Breez Bot Backup", "Starting weekly backup from VPS...")
    log("=" * 60)
    log("weekly backup started")

    BACKUPS_ROOT.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    dest_dir = BACKUPS_ROOT / today
    dest_dir.mkdir(exist_ok=True)

    # 1. Online snapshot via sqlite3 .backup (WAL-safe while bot is writing)
    log(f"sqlite3 .backup on VPS -> {VPS_TMP_DB}")
    r = run_ssh(f"sqlite3 {VPS_DB_PATH} \".backup '{VPS_TMP_DB}'\"")
    if r.returncode != 0:
        err = (r.stderr.strip() or r.stdout.strip() or "unknown")[:200]
        log(f"sqlite3 .backup failed: {err}")
        notify("Breez Bot Backup", f"FAILED — sqlite3 .backup: {err[:120]}")
        return 1

    # 2. Pull the snapshot
    local_db = dest_dir / "breez-bot.db"
    log(f"scp snapshot -> {local_db}")
    r = run_scp(VPS_TMP_DB, local_db)
    if r.returncode != 0:
        err = (r.stderr.strip() or r.stdout.strip() or "unknown")[:200]
        log(f"scp db failed: {err}")
        notify("Breez Bot Backup", f"FAILED — scp db: {err[:120]}")
        run_ssh(f"rm -f {VPS_TMP_DB}")
        return 1

    # 3. Pull routing_rules.json (optional — may be ~empty if learner hasn't run)
    local_rules = dest_dir / "routing_rules.json"
    log(f"scp routing_rules.json -> {local_rules}")
    r = run_scp(VPS_RULES_PATH, local_rules)
    if r.returncode != 0:
        err = (r.stderr.strip() or "(no stderr)")[:160]
        log(f"routing_rules.json pull non-fatal failure: {err}")

    # 4. Clean up VPS /tmp — no copies left on the server
    log("cleaning up VPS /tmp")
    run_ssh(f"rm -f {VPS_TMP_DB}")

    # 5. Rotate local retention
    deleted = rotate_backups()

    # 6. Summary
    try:
        db_bytes = local_db.stat().st_size
    except Exception:
        db_bytes = 0
    kept = sum(
        1 for p in BACKUPS_ROOT.iterdir()
        if p.is_dir() and _looks_dated(p.name)
    )
    summary = (
        f"Saved {today} ({db_bytes // 1024} KB). "
        f"{kept} copies kept, {deleted} rotated out."
    )
    log(summary)
    notify("Breez Bot Backup", f"Done — {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
