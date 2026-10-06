#!/usr/bin/env python3
"""Proton Drive Sync tray icon: live status, storage and controls for drive-sync.service."""

import fcntl
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_LOCAL_TYPELIB = os.path.expanduser("~/.local/lib/girepository-1.0")
if os.path.isdir(_LOCAL_TYPELIB):
    os.environ["GI_TYPELIB_PATH"] = _LOCAL_TYPELIB + os.pathsep + os.environ.get("GI_TYPELIB_PATH", "")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("AyatanaAppIndicator3", "0.1")
from gi.repository import AyatanaAppIndicator3 as AppIndicator3
from gi.repository import GLib, Gtk

SYNC_UNIT = "drive-sync.service"
SYNC_DIR = os.path.expanduser("~/Proton Drive")
ICON_DIR = os.path.join(_HERE, "icons")
STATE_DIR = os.path.expanduser("~/.local/state/drive-sync")
STATUS_FILE = os.path.join(STATE_DIR, "status.json")

ICONS = {
    "idle": "drive-sync-idle",
    "syncing": "drive-sync-syncing",
    "error": "drive-sync-error",
    "paused": "drive-sync-paused",
}

STATE = {"state": "idle", "detail": "Starting...", "active": False}

indicator = None
status_item = None
storage_item = None
pause_item = None


def unit_props(*props):
    args = ["systemctl", "--user", "show", SYNC_UNIT]
    for prop in props:
        args += ["-p", prop]
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=15).stdout
    except (subprocess.SubprocessError, FileNotFoundError):
        return {}
    result = {}
    for line in out.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            result[key] = value
    return result


def read_status():
    try:
        with open(STATUS_FILE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def relative_time(iso):
    if not iso:
        return "never"
    try:
        parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return "unknown"
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    seconds = max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    if seconds < 86400:
        return f"{seconds // 3600} h ago"
    return parsed.astimezone().strftime("%d %b %H:%M")


def human_bytes(n):
    if n is None:
        return "?"
    value = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def storage_detail(status):
    storage = status.get("storage")
    if not isinstance(storage, dict) or not storage.get("max"):
        return "Storage: not reported yet"
    used = storage.get("used", 0)
    maximum = storage.get("max", 0)
    free = max(0, maximum - used)
    return f"Storage: {human_bytes(used)} used · {human_bytes(free)} free"


def fetch_state():
    run = unit_props("ActiveState", "SubState", "ExecMainStatus")
    status = read_status()
    engine = status.get("state") or ""
    last_rel = relative_time(status.get("lastPassAt"))

    active = run.get("ActiveState") == "active"
    if run.get("ActiveState") in ("activating", "reloading") or engine == "passing":
        state, detail = "syncing", "Syncing now..."
    elif run.get("ActiveState") == "failed":
        state = "error"
        detail = f"Sync service failed (exit {run.get('ExecMainStatus') or '?'}) - check log"
    elif not active:
        if engine == "auth-required":
            state, detail = "error", "Authentication required - run: proton-drive"
        else:
            state, detail = "paused", f"Paused - last sync {last_rel}"
    elif engine == "auth-required":
        state, detail = "error", "Authentication required - run: proton-drive"
    elif engine in ("running", "idle", "stopped", "starting", ""):
        if status.get("lastError") and engine == "running":
            state, detail = "error", f"Last sync error: {status['lastError']}"
        else:
            state, detail = "idle", f"Synced {last_rel}"
    else:
        state, detail = "syncing", "Syncing now..."

    return {
        "state": state,
        "detail": detail,
        "storage": storage_detail(status),
        "active": active,
        "failed": run.get("ActiveState") == "failed",
    }


def sync_now(*_):
    run = unit_props("ActiveState")
    active = run.get("ActiveState")
    if active == "failed":
        subprocess.run(["systemctl", "--user", "reset-failed", SYNC_UNIT], capture_output=True)
        active = None
    if active == "active":
        subprocess.run(
            ["systemctl", "--user", "kill", "--kill-whom=main", "--signal=SIGUSR1", SYNC_UNIT],
            capture_output=True,
        )
    else:
        subprocess.run(["systemctl", "--user", "start", SYNC_UNIT], capture_output=True)
    GLib.timeout_add(700, poll)


def open_folder(*_):
    subprocess.Popen(["xdg-open", SYNC_DIR])


def show_log(*_):
    os.makedirs(STATE_DIR, exist_ok=True)
    path = os.path.join(STATE_DIR, "last-run.log")
    try:
        out = subprocess.run(
            ["journalctl", "--user", "-u", SYNC_UNIT, "-n", "100", "--no-pager", "-o", "short-iso"],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except (subprocess.SubprocessError, FileNotFoundError):
        out = ""
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(out or "(no journal output)\n")
    subprocess.Popen(["xdg-open", path])


def toggle_pause(*_):
    if STATE.get("active"):
        subprocess.run(["systemctl", "--user", "stop", SYNC_UNIT], capture_output=True)
    else:
        subprocess.run(["systemctl", "--user", "start", SYNC_UNIT], capture_output=True)
    poll()


def poll():
    try:
        state = fetch_state()
    except Exception:
        return True
    STATE.update(state)
    icon = ICONS[state["state"]]
    if getattr(poll, "_icon", None) != icon:
        indicator.set_icon(icon)
        poll._icon = icon
    status_item.set_label(state["detail"])
    storage_item.set_label(state["storage"])
    pause_item.set_label("Resume syncing" if not state["active"] else "Pause syncing")
    return True


def main():
    lock_path = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "drive-sync-tray.lock")
    lock_handle = open(lock_path, "w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(0)

    global indicator, status_item, storage_item, pause_item

    indicator = AppIndicator3.Indicator.new(
        "drive-sync", ICONS["idle"], AppIndicator3.IndicatorCategory.SYSTEM_SERVICES
    )
    indicator.set_icon_theme_path(ICON_DIR)
    indicator.set_title("Proton Drive Sync")
    indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)

    menu = Gtk.Menu()

    status_item = Gtk.MenuItem(label="Starting...")
    status_item.set_sensitive(False)
    menu.append(status_item)

    storage_item = Gtk.MenuItem(label="Storage: ...")
    storage_item.set_sensitive(False)
    menu.append(storage_item)
    menu.append(Gtk.SeparatorMenuItem())

    sync_now_item = Gtk.MenuItem(label="Sync now")
    sync_now_item.connect("activate", sync_now)
    menu.append(sync_now_item)

    open_item = Gtk.MenuItem(label="Open Proton Drive folder")
    open_item.connect("activate", open_folder)
    menu.append(open_item)

    log_item = Gtk.MenuItem(label="Show last log")
    log_item.connect("activate", show_log)
    menu.append(log_item)
    menu.append(Gtk.SeparatorMenuItem())

    pause_item = Gtk.MenuItem(label="Pause syncing")
    pause_item.connect("activate", toggle_pause)
    menu.append(pause_item)

    quit_item = Gtk.MenuItem(label="Quit tray icon")
    quit_item.connect("activate", lambda *_: Gtk.main_quit())
    menu.append(quit_item)

    menu.show_all()
    indicator.set_menu(menu)

    poll()
    GLib.timeout_add_seconds(5, poll)
    Gtk.main()


if __name__ == "__main__":
    main()
