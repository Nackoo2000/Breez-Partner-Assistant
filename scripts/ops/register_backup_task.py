"""
register_backup_task.py — Register (or re-register) the daily Breez Bot backup
job with Windows Task Scheduler so backup_bot.py runs automatically.

Why Task Scheduler and not `claude` scheduled tasks? Per the global CLAUDE.md
rule: anything that should run automatically without a new Claude session belongs
in WTS. Claude scheduled tasks clutter the sidebar and need per-run approval.

Why PowerShell Register-ScheduledTask and not schtasks.exe? schtasks' flags
(`/TN`, `/SC` etc.) start with `/`, which Git Bash mangles into paths. PowerShell
cmdlets avoid that trap.

Laptop-off handling (user explicitly flagged: "my laptop may be off for a few
hours up to a day"):
  -StartWhenAvailable          → run ASAP after a missed scheduled start
  -AllowStartIfOnBatteries     → don't skip just because we're unplugged
  -DontStopIfGoingOnBatteries  → finish the run if battery kicks in mid-backup

Usage:
  python scripts/ops/register_backup_task.py                 # defaults: 07:00 daily
  python scripts/ops/register_backup_task.py --time 08:30
  python scripts/ops/register_backup_task.py --unregister    # remove the task
"""

import argparse
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
BACKUP_SCRIPT = HERE / "backup_bot.py"

DEFAULT_TASK_NAME = "Breez Bot Daily Backup"
DEFAULT_TIME = "07:00"


def find_pythonw() -> str:
    """Return absolute path to pythonw.exe (the no-console Python launcher).

    We prefer pythonw.exe over python.exe so the scheduled run doesn't flash a
    console window every morning. Falls back to python.exe if pythonw is missing
    (uncommon — comes with standard CPython installs).
    """
    exe = pathlib.Path(sys.executable)
    candidate = exe.with_name("pythonw.exe")
    if candidate.exists():
        return str(candidate)
    return str(exe)


def register(task_name: str, start_time: str) -> int:
    if not BACKUP_SCRIPT.exists():
        print(f"ERROR: backup script not found at {BACKUP_SCRIPT}", file=sys.stderr)
        return 1

    pythonw = find_pythonw()

    ps_script = f"""
$ErrorActionPreference = 'Stop'

$action = New-ScheduledTaskAction `
    -Execute '{pythonw}' `
    -Argument '"{BACKUP_SCRIPT}"' `
    -WorkingDirectory '{HERE.parent.parent}'

$trigger = New-ScheduledTaskTrigger -Daily -At '{start_time}'

# Settings tuned for laptops that sleep / hibernate / travel:
#   - StartWhenAvailable: run missed schedules as soon as the box wakes up.
#   - AllowStartIfOnBatteries / DontStopIfGoingOnBatteries: always run, even
#     if we're unplugged when the trigger fires.
#   - MultipleInstances IgnoreNew: if yesterday's run is still going somehow,
#     skip today's rather than pile up.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

# Unregister any prior version so re-running this script just updates the task.
Unregister-ScheduledTask -TaskName '{task_name}' -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName '{task_name}' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Daily SQLite + routing-rules backup pulled from the Breez bot VPS to this Windows machine. See scripts/ops/backup_bot.py.' `
    -Force | Out-Null

Write-Host "Registered '{task_name}' — daily at {start_time}"
Write-Host "  Script:  {BACKUP_SCRIPT}"
Write-Host "  Runtime: {pythonw}"
"""

    r = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
        capture_output=True, text=True,
    )
    if r.stdout:
        print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr.strip() or "(no stderr)", file=sys.stderr)
        return r.returncode

    # Verify by dumping the task's next run time so the user sees it's real.
    verify = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Get-ScheduledTask -TaskName '{task_name}' | Get-ScheduledTaskInfo | "
         f"Select-Object NextRunTime, LastRunTime, LastTaskResult | Format-List"],
        capture_output=True, text=True,
    )
    if verify.stdout.strip():
        print()
        print(verify.stdout.strip())
    return 0


def unregister(task_name: str) -> int:
    ps_script = (
        f"Unregister-ScheduledTask -TaskName '{task_name}' -Confirm:$false "
        f"-ErrorAction Stop; Write-Host 'Unregistered {task_name}'"
    )
    r = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
        capture_output=True, text=True,
    )
    if r.stdout:
        print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr.strip() or "(no stderr)", file=sys.stderr)
    return r.returncode


def main() -> int:
    p = argparse.ArgumentParser(description="Register the daily Breez Bot backup with Windows Task Scheduler.")
    p.add_argument("--name", default=DEFAULT_TASK_NAME,
                   help=f"Scheduled-task name (default: {DEFAULT_TASK_NAME!r})")
    p.add_argument("--time", default=DEFAULT_TIME,
                   help=f"Daily trigger time HH:MM local (default: {DEFAULT_TIME})")
    p.add_argument("--unregister", action="store_true",
                   help="Remove the task instead of creating/updating it")
    args = p.parse_args()

    if args.unregister:
        return unregister(args.name)
    return register(args.name, args.time)


if __name__ == "__main__":
    sys.exit(main())
