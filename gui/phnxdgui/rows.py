"""GObject row type backing the GTK column view.

One FileRow per engine list entry. Every display field is a plain Python
attribute so the rest of the GUI reads them directly (sort comparators, the
context menu) exactly as before. The single ``revision`` GObject property is the
one observable bit: ``apply_entry`` bumps it whenever a field actually changes,
and the cell factories listen to ``notify::revision`` to repaint just that row.
That is what lets a live status update repaint a badge without rebuilding the
list (which would drop the selection and the scroll position).
"""

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GObject

from . import util
from .badges import badge_for

# Fields refreshed in place for an existing row (same relative path). Most change
# with sync status; name/type are included only to cover the rare case of a path
# flipping file<->dir, even though a rename yields a different path (hence a new
# row through the browser's merge). ``rel_path`` is the row identity and is never
# touched here.
_MANAGED_FIELDS = (
    "name",
    "entry_type",
    "presence",
    "sync",
    "pinned",
    "size",
    "mtime",
    "is_dir",
    "badge_icons",
    "badge_css",
    "badge_label",
    "size_label",
    "mtime_label",
)


def _entry_fields(entry: dict) -> dict:
    """Resolve an engine list entry into the row's full display state.

    Pure (no GTK) so the status mapping stays testable without a display.
    """
    entry_type = entry.get("type", "file")
    is_dir = entry_type == "dir"
    size = entry.get("size")
    mtime = entry.get("mtime")
    icons, css, label = badge_for(entry)
    return {
        "name": entry.get("name", ""),
        "entry_type": entry_type,
        "presence": entry.get("presence", "local"),
        "sync": entry.get("sync", "n/a"),
        "pinned": bool(entry.get("pinned")),
        "size": size,
        "mtime": mtime,
        "is_dir": is_dir,
        "badge_icons": icons,
        "badge_css": css,
        "badge_label": label,
        "size_label": "-" if is_dir or size is None else util.human_bytes(size),
        "mtime_label": util.fmt_mtime(mtime),
    }


class FileRow(GObject.Object):
    __gtype_name__ = "PhnxFileRow"

    # Bumped whenever apply_entry changes any field; drives per-row repaint.
    revision = GObject.Property(type=int, default=0)

    def __init__(self, entry: dict):
        super().__init__()
        self.rel_path = entry.get("path", "")
        for field, value in _entry_fields(entry).items():
            setattr(self, field, value)

    def apply_entry(self, entry: dict) -> bool:
        """Refresh this row from a newer engine entry; True if anything changed.

        Only changed fields are written, and ``revision`` is bumped once, so a
        no-op listing (e.g. a poll that returns identical status) repaints
        nothing.
        """
        fields = _entry_fields(entry)
        changed = False
        for field in _MANAGED_FIELDS:
            value = fields[field]
            if getattr(self, field) != value:
                setattr(self, field, value)
                changed = True
        if changed:
            self.set_property("revision", self.get_property("revision") + 1)
        return changed
