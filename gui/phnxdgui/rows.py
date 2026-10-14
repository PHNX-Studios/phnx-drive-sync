"""GObject row type backing the GTK column view.

One FileRow per engine list entry. It is a plain GObject so it can live in a
Gio.ListStore, with resolved badge text/classes computed once at construction.
"""

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GObject

from . import util
from .badges import badge_for


class FileRow(GObject.Object):
    __gtype_name__ = "PhnxFileRow"

    def __init__(self, entry: dict):
        super().__init__()
        self.rel_path = entry.get("path", "")
        self.name = entry.get("name", "")
        self.entry_type = entry.get("type", "file")
        self.presence = entry.get("presence", "local")
        self.sync = entry.get("sync", "n/a")
        self.pinned = bool(entry.get("pinned"))
        self.size = entry.get("size")
        self.mtime = entry.get("mtime")
        self.is_dir = self.entry_type == "dir"

        icons, css, label = badge_for(entry)
        self.badge_icons = icons
        self.badge_css = css
        self.badge_label = label
        self.size_label = "-" if self.is_dir or self.size is None else util.human_bytes(self.size)
        self.mtime_label = util.fmt_mtime(self.mtime)
