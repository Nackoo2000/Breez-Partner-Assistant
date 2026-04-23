"""
backup_bot.py — Daily SQLite backup from the Hetzner VPS to this Windows machine.

Runs once a day via Windows Task Scheduler (see register_backup_task.py).
On each run it:

  1. Toasts "Starting..." so you see it kick off.
  2. SSH into the VPS and calls sqlite3 .backup on breez-bot.db (a live-safe
     snapshot — a plain file copy could catch a half-written WAL).
  3. scp the snapshot down to D:/Cursor/Breez/Breez Slack/backups/.
  4. Also pulls data/routing_rules.json and its archive/ directory (tiny, useful
     to roll back a bad learner week).
  5. Deletes local backups older than 30 days.
  6. Toasts "Done — <summary>" or "FAILED — <error>".
  7. Appends a full log line to backups/backup_log.txt.

Requires OpenSSH client on Windows (built in on Win10+) and a key-based login
configured to the breez@ user on the VPS. Set the env vars below in a .env.local
next to this file, or export them in the Task Scheduler action.

Env:
  BREEZ_VPS_HOST     — e.g. 65.108.147.171 or breez-vps
  BREEZ_VPS_USER     — default 'breez'
  BREEZ_VPS_DB_PATH  — default '/home/breez/breez-bot/data/breez-bot.db'
  BREEZ_VPS_RULES_DIR — default '/home/breez/breez-bot/data'
  BREEZ_BACKUP_DIR   — default 'D:/Cursor/Breez/Breez Slack/backups'
"""

import os
import pathlib
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent  # scripts/ops/ -> scripts/ -> repo root

# ─── Config (env with sane defaults) ──────────────────────────────────────
HOST        = os.environ.get("BREEZ_VPS_HOST")       or ""
USER        = os.environ.get("BREEZ_VPS_USER")       or "breez"
DB_REMOTE   = os.environ.get("BREEZ_VPS_DB_PATH")    or "/home/breez/breez-bot/data/breez-bot.db"
RULES_DIR   = os.environ.get("BREEZ_VPS_RULES_DIR")  or "/home/breez/breez-bot/data"
BACKUP_DIR  = pathlib.Path(
    os.environ.get("BREEZ_BACKUP_DIR") or str(REPO_ROOT / "backups")
).resolve()
RETENTION_DAYS = int(os.environ.get("BREEZ_BACKUP_RETENTION_DAYS") or "30")

LOG_FILE = BACKUP_DIR / "backup_log.txt"


# ─── Toast helper (no pip deps) ───────────────────────────────────────────
def notify(title: str, message: str) -> None:
    """Fire a Windows balloon-tip notification. Non-blocking. No throw on fail."""
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.ShowBalloonTip(8000, '{title}', '{message}', [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Seconds 9
$n.Dispose()
"""
    try:
        subprocess.Popen(
            ["powershell", "-WindowStyle", "Hidden", "-Command", ps],
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except Exception:
        pass


# ─── Logging ──────────────────────────────────────────────────────────────
def log(line: str) -> None:
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry = f"[{ts}] {line}"
    print(entry)
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(entry + "\n")
    except Exception as e:
        print(f"(log write failed: {e})")


# ─── SSH helpers (OpenSSH via subprocess, no paramiko dependency) ─────────
SSH_OPTS = [
    "-o", "BatchMode=yes",              # never prompt interactively
    "-o", "ConnectTimeout=20",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=15",
]


def run(cmd: list[str], timeout: int = 120) -> tuple[int, str, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired as e:
        return 124, "", f"timeout: {e}"


def ssh(remote_cmd: str, timeout: int = 120) -> tuple[int, str, str]:
    return run(["ssh", *SSH_OPTS, f"{USER}@{HOST}", remote_cmd], timeout=timeout)


def scp_down(remote_path: str, local_path: pathlib.Path, timeout: int = 300) -> tuple[int, str, str]:
    return run(
        ["scp", *SSH_OPTS, f"{USER}@{HOST}:{remote_path}", str(local_path)],
        timeout=timeout,
    )


def scp_down_recursive(remote_path: str, local_path: pathlib.Path, timeout: int = 300) -> tuple[int, str, str]:
    return run(
        ["scp", "-r", *SSH_OPTS, f"{USER}@{HOST}:{remote_path}", str(local_path)],
        timeout=timeout,
    )


# ─── Main routine ─────────────────────────────────────────────────────────
def prune_old_backups(dir_: pathlib.Path, retention_days: int) -> int:
    """Delete .db and .tar snapshots older than retention_days. Returns count."""
    if not dir_.exists():
        return 0
    cutoff = time.time() - retention_days * 86400
    removed = 0
    for child in dir_.iterdir():
        if child.suffix not in (".db", ".gz", ".tar"):
            continue
        try:
            if child.stat().st_mtime < cutoff:
                child.unlink()
                removed += 1
        except Exception as e:
            log(f"prune: could not delete {child.name}: {e}")
    return removed


def main() -> int:
    if not HOST:
        msg = "BREEZ_VPS_HOST not set"
        log(f"ABORT — {msg}")
        notify("Breez Bot Backup", f"FAILED — {msg}")
        return 2

    notify("Breez Bot Backup", "Starting...")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    remote_tmp = f"/tmp/breez-bot-{stamp}.db"
    local_db = BACKUP_DIR / f"breez-bot-{stamp}.db"

    log(f"START host={HOST} db_remote={DB_REMOTE}")

    # 1. Consistent snapshot on the remote
    rc, out, err = ssh(f"sqlite3 '{DB_REMOTE}' \".backup '{remote_tmp}'\"", timeout=120)
    if rc != 0:
        msg = f"remote sqlite3 .backup failed rc={rc}: {err.strip() or out.strip()}"
        log(f"FAIL — {msg}")
        notify("Breez Bot Backup", f"FAILED — {msg[:120]}")
        return 1

    # 2. Pull it down
    rc, out, err = scp_down(remote_tmp, local_db)
    if rc != 0:
        msg = f"scp db failed rc={rc}: {err.strip() or out.strip()}"
        log(f"FAIL — {msg}")
        ssh(f"rm -f '{remote_tmp}'", timeout=30)
        notify("Breez Bot Backup", f"FAILED — {msg[:120]}")
        return 1

    # 3. Remove remote temp
    ssh(f"rm -f '{remote_tmp}'", timeout=30)

    # 4. Pull the rules file + archive (tiny, always useful to keep next to the db)
    rules_local_dir = BACKUP_DIR / f"routing_rules-{stamp}"
    rules_local_dir.mkdir(exist_ok=True)
    scp_down(f"{RULES_DIR}/routing_rules.json", rules_local_dir / "routing_rules.json")
    scp_down_recursive(f"{RULES_DIR}/routing_rules.archive", rules_local_dir)

    # 5. Prune old snapshots
    removed = prune_old_backups(BACKUP_DIR, RETENTION_DAYS)

    size_mb = local_db.stat().st_size / (1024 * 1024)
    summary = f"{local_db.name} {size_mb:.2f} MB; pruned {removed} old"
    log(f"OK — {summary}")
    notify("Breez Bot Backup", f"Done — {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
