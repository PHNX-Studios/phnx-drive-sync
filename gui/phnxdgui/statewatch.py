"""Polls status.json and the mount heartbeat, and reports state to the UI.

Mirrors how the tray reads the engine: status.json is the source of truth for
engine state, storage, progress and counts; the mount-ok heartbeat tells us
whether the FUSE sidecar is alive (the engine can keep running after a mount
loss). Runs on the GTK main loop via GLib timeouts.
"""

import json
import os
import time

import gi

gi.require_version("GLib", "2.0")
from gi.repository import GLib

from . import paths


def read_status() -> dict:
    try:
        with open(paths.status_file(), encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def mount_age_s() -> float:
    try:
        return time.time() - os.stat(paths.mount_ok_file()).st_mtime
    except OSError:
        return float("inf")


def sync_version(status):
    """A comparable "sync facts changed" signal, or None when unknown.

    Prefers the engine's monotonic ``revision`` (bumped at the end of every pass
    and after every mutating RPC): a change there means some file's status may
    have changed, so the visible folder should be re-read. Falls back to a
    fingerprint of the status fields that change when sync facts change, for an
    older engine that predates ``revision``. A ``None`` return means there is
    nothing to compare yet (engine not up), so the caller must not refresh.

    Pure and GTK-free so it is unit-testable without a display.
    """
    if not isinstance(status, dict) or not status:
        return None
    if "revision" in status:
        return ("rev", status.get("revision"))
    counts = status.get("counts") or {}
    return (
        status.get("lastPassAt"),
        counts.get("placeholders"),
        counts.get("reclaimable"),
        counts.get("tracked"),
        status.get("pid"),
    )


class StateWatch:
    """Periodic status.json poll; calls on_update(status_dict, mount_age_s)."""

    def __init__(self, on_update, interval_ms: int = 4000):
        self._on_update = on_update
        self._interval = interval_ms
        self._source = None

    def start(self):
        self._tick()
        if self._source is None:
            self._source = GLib.timeout_add(self._interval, self._tick)

    def stop(self):
        if self._source is not None:
            GLib.source_remove(self._source)
            self._source = None

    def poke(self):
        """Read again on the next main-loop iteration (after a mutation)."""
        GLib.idle_add(self._tick_once)

    def _tick(self) -> bool:
        self._tick_once()
        return True

    def _tick_once(self) -> bool:
        self._on_update(read_status(), mount_age_s())
        return False
