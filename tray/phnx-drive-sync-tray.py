#!/usr/bin/env python3
"""PHNX Drive Sync tray icon: live status, storage and controls for phnx-drive-sync.service."""

import fcntl
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))

import gi

gi.require_version("Gtk", "3.0")
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator3
except (ValueError, ImportError):
    # Older distros (e.g. Ubuntu 18.04) ship the un-renamed AppIndicator3 typelib.
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3 as AppIndicator3
from gi.repository import GLib, Gtk

SYNC_UNIT = "phnx-drive-sync.service"
SYNC_DIR = os.path.expanduser("~/Proton Drive")
ICON_DIR = os.path.join(_HERE, "icons")
STATE_DIR = os.path.expanduser("~/.local/state/phnx-drive-sync")
STATUS_FILE = os.path.join(STATE_DIR, "status.json")
MOUNT_OK = os.path.join(STATE_DIR, "mount-ok")
RPC_SOCK = os.path.join(STATE_DIR, "rpc.sock")
MOUNT_STALE_S = 15  # sidecar heartbeats every 2s; anything older means it died
EVICT_LABEL = "Free up space (all local files)"
# Opening the file manager GUI: the installed launcher, else the dev-checkout
# script next to this runtime (tray/ and gui/ are siblings under the libdir).
GUI_BIN = os.path.expanduser("~/.local/bin/phnx-drive-sync-gui")
GUI_SCRIPT = os.path.join(os.path.dirname(_HERE), "gui", "phnx-drive-sync-gui.py")

ICONS = {
    "idle": "phnx-drive-sync-idle",
    "syncing": "phnx-drive-sync-syncing",
    "error": "phnx-drive-sync-error",
    "paused": "phnx-drive-sync-paused",
}

STATE = {"state": "idle", "detail": "Starting...", "active": False, "evicting": False}

indicator = None
info_primary = None
info_secondary = None
pause_item = None
evict_item = None

def info_row(left, right, sep=" - "):
    """One menu row holding two info cells joined by a separator."""
    if not left:
        return right
    if not right:
        return left
    return f"{left}{sep}{right}"


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


def storage_fields(status):
    """Split storage/count info into the three cells of the 2x2 status grid."""
    storage = status.get("storage")
    counts = status.get("counts") or {}
    if isinstance(storage, dict) and storage.get("max"):
        used = storage.get("used", 0)
        maximum = storage.get("max", 0)
        used_text = f"{human_bytes(used)} of {human_bytes(maximum)} used"
    else:
        used_text = "Storage not reported yet"
    placeholders = counts.get("placeholders")
    online_text = f"{placeholders} online-only" if isinstance(placeholders, int) and placeholders > 0 else ""
    reclaimable = counts.get("reclaimable")
    reclaim_text = (
        f"{human_bytes(reclaimable)} reclaimable" if isinstance(reclaimable, int) and reclaimable > 0 else ""
    )
    return used_text, online_text, reclaim_text


def sync_progress_text(status):
    """Current item + item-count progress for the in-flight pass, or None."""
    progress = status.get("progress")
    if not isinstance(progress, dict):
        return None
    current = progress.get("current")
    if not current:
        return None
    total = progress.get("total") or 0
    done = progress.get("done") or 0
    if total > 0:
        return f"{current} ({done}/{total})"
    return current


def rpc_call(op, paths, timeout=15 * 60):
    """Talk to the phnx-drive-sync daemon over its unix socket (pin/unpin/evict/prefetch...)."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(RPC_SOCK)
        sock.sendall((json.dumps({"op": op, "paths": paths}) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                raise RuntimeError("sync engine closed the connection")
            buf += chunk
    finally:
        sock.close()
    resp = json.loads(buf.split(b"\n", 1)[0].decode())
    if not resp.get("ok"):
        raise RuntimeError(resp.get("error") or f"{op} failed")
    return resp


def mount_degraded(active):
    """True while the unit is up but the FUSE sidecar is gone or unresponsive."""
    if not active:
        return False
    return mount_age_s() > MOUNT_STALE_S


def mount_age_s():
    """Seconds since the sidecar's last heartbeat; inf when the file is gone."""
    try:
        return time.time() - os.stat(MOUNT_OK).st_mtime
    except OSError:
        return float("inf")


def remount(*_):
    """Engine alive but mount dead: restart the unit (a plain SIGUSR1 won't remount)."""
    subprocess.run(["systemctl", "--user", "restart", SYNC_UNIT], capture_output=True)
    GLib.timeout_add_seconds(2, _remount_poll)


def _remount_poll():
    poll()
    if STATE.get("state") == "error" and "Mount degraded" in STATE.get("detail", ""):
        return True  # still degraded; poll() keeps trying
    return False


def fetch_state():
    run = unit_props("ActiveState", "SubState", "ExecMainStatus")
    status = read_status()
    engine = status.get("state") or ""
    last_rel = relative_time(status.get("lastPassAt"))
    progress_text = sync_progress_text(status)

    active = run.get("ActiveState") == "active"
    if run.get("ActiveState") in ("activating", "reloading") or engine == "passing":
        state, detail = "syncing", progress_text or "Syncing now..."
    elif run.get("ActiveState") == "failed":
        state = "error"
        detail = f"Sync service failed (exit {run.get('ExecMainStatus') or '?'}) - check log"
    elif not active:
        if engine == "auth-required":
            state, detail = "error", "Sign in required - run: phnx-drive-sync login"
        else:
            state, detail = "paused", f"Paused - last sync {last_rel}"
    elif engine == "auth-required":
        state, detail = "error", "Sign in required - run: phnx-drive-sync login"
    elif engine in ("running", "idle", "stopped", "starting", ""):
        if status.get("lastError") and engine == "running":
            state, detail = "error", f"Last sync error: {status['lastError']}"
        else:
            state, detail = "idle", f"Synced {last_rel}"
    else:
        state, detail = "syncing", progress_text or "Syncing now..."

    if mount_degraded(active) and state in ("idle", "syncing"):
        state, detail = "error", "Mount degraded - folder not available"
    elif status.get("offline") and active and state in ("idle", "syncing"):
        state, detail = "paused", "Offline - reconnecting..."

    used_text, online_text, reclaim_text = storage_fields(status)
    return {
        "state": state,
        "detail": detail,
        "used": used_text,
        "online": online_text,
        "reclaim": reclaim_text,
        "active": active,
        "failed": run.get("ActiveState") == "failed",
        "reclaimable": counts_reclaimable(status),
    }


def counts_reclaimable(status):
    value = (status.get("counts") or {}).get("reclaimable")
    return value if isinstance(value, int) else 0


def sync_now(*_):
    run = unit_props("ActiveState")
    active = run.get("ActiveState")
    if active == "failed":
        subprocess.run(["systemctl", "--user", "reset-failed", SYNC_UNIT], capture_output=True)
        active = None
    if active == "active" and mount_degraded(True):
        remount()
        return
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


def open_app(*_):
    """Open the file manager GUI (a separate GTK4 process; safe to launch twice)."""
    argv = None
    if os.path.exists(GUI_BIN):
        argv = [GUI_BIN]
    elif os.path.exists(GUI_SCRIPT):
        py = shutil.which("python3") or shutil.which("python")
        if py:
            argv = [py, GUI_SCRIPT]
    if argv is None:
        subprocess.run(
            ["notify-send", "PHNX Drive Sync", "File manager not found - reinstall phnx-drive-sync"],
            capture_output=True,
        )
        return
    try:
        subprocess.Popen(argv)
    except OSError as exc:
        subprocess.run(
            ["notify-send", "PHNX Drive Sync", f"Could not open the file manager: {exc}"],
            capture_output=True,
        )


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


def free_up_space(*_):
    """Bulk-evict: tell the daemon to make every local file online-only (keeps stay local)."""
    if STATE.get("evicting"):
        return
    STATE["evicting"] = True
    evict_item.set_sensitive(False)
    evict_item.set_label("Freeing space...")

    def work():
        err = None
        try:
            rpc_call("evict", ["*"])
        except FileNotFoundError:
            err = "Sync engine is not running"
        except Exception as exc:
            err = f"Could not free space: {exc}"
        GLib.idle_add(_evict_done, err)

    threading.Thread(target=work, daemon=True).start()


def _evict_done(err):
    STATE["evicting"] = False
    evict_item.set_sensitive(True)
    evict_item.set_label(EVICT_LABEL)
    if err:
        subprocess.run(["notify-send", "PHNX Drive Sync", err], capture_output=True)
    poll()
    return False


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
    info_primary.set_label(info_row(state["detail"], state["used"]))
    info_secondary.set_label(info_row(state["online"], state["reclaim"]))
    pause_item.set_label("Resume syncing" if not state["active"] else "Pause syncing")
    # bulk free: only worth offering while the mount is up and there is something to free
    want_evict = state["active"] and (STATE.get("evicting") or state.get("reclaimable", 0) > 0)
    if evict_item.get_visible() != want_evict:
        evict_item.set_visible(want_evict)
    return True


def main():
    lock_path = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "phnx-drive-sync-tray.lock")
    lock_handle = open(lock_path, "w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit(0)

    global indicator, info_primary, info_secondary, pause_item, evict_item

    indicator = AppIndicator3.Indicator.new(
        "phnx-drive-sync", ICONS["idle"], AppIndicator3.IndicatorCategory.SYSTEM_SERVICES
    )
    indicator.set_icon_theme_path(ICON_DIR)
    indicator.set_title("PHNX Drive Sync (unofficial)")
    indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)

    menu = Gtk.Menu()

    # status grid: two rows, two cells each (status | storage, online-only | reclaimable)
    info_primary = Gtk.MenuItem(label="Starting...")
    info_primary.set_sensitive(False)
    menu.append(info_primary)

    info_secondary = Gtk.MenuItem(label="")
    info_secondary.set_sensitive(False)
    menu.append(info_secondary)
    menu.append(Gtk.SeparatorMenuItem())

    # actions are all top level (no submenus): sync, open the app, open the
    # folder, show the last log, and bulk free up space
    sync_now_item = Gtk.MenuItem(label="Sync now")
    sync_now_item.connect("activate", sync_now)
    menu.append(sync_now_item)

    open_app_item = Gtk.MenuItem(label="Open PHNX Drive Sync")
    open_app_item.connect("activate", open_app)
    menu.append(open_app_item)

    open_item = Gtk.MenuItem(label="Open Proton Drive folder")
    open_item.connect("activate", open_folder)
    menu.append(open_item)

    log_item = Gtk.MenuItem(label="Show last log")
    log_item.connect("activate", show_log)
    menu.append(log_item)

    evict_item = Gtk.MenuItem(label=EVICT_LABEL)
    evict_item.connect("activate", free_up_space)
    menu.append(evict_item)

    menu.append(Gtk.SeparatorMenuItem())

    pause_item = Gtk.MenuItem(label="Pause syncing")
    pause_item.connect("activate", toggle_pause)
    menu.append(pause_item)

    quit_item = Gtk.MenuItem(label="Quit tray icon")
    quit_item.connect("activate", lambda *_: Gtk.main_quit())
    menu.append(quit_item)

    menu.show_all()
    evict_item.set_visible(False)  # poll() reveals it when there is reclaimable space
    indicator.set_menu(menu)

    poll()
    GLib.timeout_add_seconds(5, poll)
    Gtk.main()


if __name__ == "__main__":
    main()
