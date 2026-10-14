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
