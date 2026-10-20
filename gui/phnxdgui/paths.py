"""Filesystem locations for the GUI.

Mirrors the engine's src/config.ts exactly: the same XDG base directories and
the same PHNX_DRIVE_SYNC_* overrides (the legacy DRIVE_SYNC_* names are still
honored), so the GUI and the engine always agree on where the mount, the real
tree, state.db and status.json live. Nothing here creates directories; the
engine owns layout.
"""

import os


def _home() -> str:
    return os.path.expanduser("~")


def _env(suffix: str):
    """Read a PHNX_DRIVE_SYNC_* override, falling back to the legacy DRIVE_SYNC_* name."""
    value = os.environ.get("PHNX_DRIVE_SYNC_" + suffix)
    if value is None:
        value = os.environ.get("DRIVE_SYNC_" + suffix)
    return value


def _state_dir() -> str:
    override = _env("HOME")
    if override:
        return os.path.join(override, "state")
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(_home(), ".local", "state")
    return os.path.join(base, "phnx-drive-sync")


def _share_dir() -> str:
    override = _env("HOME")
    if override:
        return os.path.join(override, "share")
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(_home(), ".local", "share")
    return os.path.join(base, "phnx-drive-sync")


def mount_root() -> str:
    """The user-facing FUSE mount point (~/Proton Drive)."""
    return os.path.abspath(_env("ROOT") or os.path.join(_home(), "Proton Drive"))


def tree_root() -> str:
    """The real on-disk tree the engine scans and watches."""
    return os.path.abspath(_env("TREE") or os.path.join(_share_dir(), "tree"))


def rpc_socket() -> str:
    return os.path.join(_state_dir(), "rpc.sock")


def status_file() -> str:
    return os.path.join(_state_dir(), "status.json")


def mount_ok_file() -> str:
    """Sidecar heartbeat the engine writes every couple of seconds."""
    return os.path.join(_state_dir(), "mount-ok")


def log_file() -> str:
    return os.path.join(_state_dir(), "phnx-drive-sync.log")


def config_dir() -> str:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(_home(), ".config")
    return os.path.join(base, "phnx-drive-sync")


def env_file() -> str:
    """systemd user unit EnvironmentFile (PHNX_DRIVE_SYNC_* / PROTON_DRIVE_* overrides)."""
    return os.path.join(config_dir(), "env")


def app_root() -> str:
    """The installed runtime dir (contains phnx-drive-sync-fuse, assets/, tray/, gui/, VERSION).

    gui/phnxdgui/paths.py -> gui/phnxdgui -> gui -> libdir
    """
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def mount_abs(rel: str) -> str:
    """Absolute path under the mount for a rel path ('' = the mount root)."""
    root = mount_root()
    return root if not rel else os.path.join(root, rel)


def to_rel(path: str) -> str:
    """Map a CLI path (absolute under the mount/tree, or already rel) to a rel path.

    '' means the sync root. Paths outside the known roots are treated as rel.
    """
    if not path:
        return ""
    abs_path = os.path.abspath(path)
    for root in (mount_root(), tree_root()):
        root = root.rstrip("/")
        if abs_path == root:
            return ""
        prefix = root + "/"
        if abs_path.startswith(prefix):
            return abs_path[len(prefix):]
    return path.strip("/")
