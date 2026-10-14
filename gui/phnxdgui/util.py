"""Pure helpers shared by the GUI: byte/time formatting and rel-path math.

Kept free of GTK imports so they are unit-testable without a display.
"""

import os
from datetime import datetime, timezone

from . import paths


def human_bytes(n) -> str:
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


def relative_time(iso) -> str:
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


def fmt_mtime(ms) -> str:
    if not ms:
        return ""
    try:
        return datetime.fromtimestamp(ms / 1000).strftime("%d %b %Y %H:%M")
    except (OverflowError, OSError, ValueError):
        return ""


def basename(rel: str) -> str:
    return rel.rsplit("/", 1)[-1] if rel else ""


def parent_rel(rel: str) -> str:
    return rel.rsplit("/", 1)[0] if "/" in rel else ""


def join_rel(parent: str, name: str) -> str:
    return f"{parent}/{name}" if parent else name


_STORAGE_CACHE = {"value": None}


def app_version() -> str:
    """Installed VERSION file if present, else the packaged constant."""
    if _STORAGE_CACHE["value"] is None:
        version = None
        try:
            with open(os.path.join(paths.app_root(), "VERSION"), encoding="utf-8") as handle:
                version = handle.read().strip() or None
        except OSError:
            version = None
        if version is None:
            from . import __version__

            version = __version__
        _STORAGE_CACHE["value"] = version
    return _STORAGE_CACHE["value"]
