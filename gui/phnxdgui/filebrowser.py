"""The directory view and the file operations on it.

The listing comes from the engine's ``list`` RPC (the engine owns sync status);
file operations go through the FUSE mount with GIO, so the sidecar's placeholder
semantics (hydrate on open, remote-only rename/trash) apply automatically. Slow
operations run on worker threads and report back on the GTK main loop.
"""

import os
import threading

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango

from . import dialogs, paths, rpcclient, util
from .rows import FileRow

CSS_CLASSES = ("synced", "cloud", "pending", "newsync", "dim")

_STATUS_ORDER = {"cloud": 0, "synced": 1, "pending": 2, "newsync": 3, "dim": 4}


# --- sort comparators (module-level so Gtk.CustomSorter can hold them) -------

def _dirs_first(a, b):
    if a.is_dir != b.is_dir:
        return -1 if a.is_dir else 1
    return 0


def compare_name(a, b, _data):
    order = _dirs_first(a, b)
    if order:
        return order
    an, bn = a.name.casefold(), b.name.casefold()
    return (an > bn) - (an < bn)


def compare_size(a, b, _data):
    order = _dirs_first(a, b)
    if order:
        return order
    av = a.size if a.size is not None else -1
    bv = b.size if b.size is not None else -1
    return (av > bv) - (av < bv)


def compare_mtime(a, b, _data):
    order = _dirs_first(a, b)
    if order:
        return order
    av = a.mtime or 0
    bv = b.mtime or 0
    return (av > bv) - (av < bv)


def compare_status(a, b, _data):
    order = _dirs_first(a, b)
    if order:
        return order
    av = _STATUS_ORDER.get(a.badge_css, 9)
    bv = _STATUS_ORDER.get(b.badge_css, 9)
    return (av > bv) - (av < bv)


class FileBrowser:
    """Owns the column view, the navigation history and the file operations."""

    def __init__(self, window):
        self._window = window
        self._closing = False
        self._gen = 0
        self.current_rel = ""
        self._history = [""]
        self._history_pos = 0

        self.store = Gio.ListStore.new(FileRow)
        self.column_view = Gtk.ColumnView()
        self.column_view.set_show_row_separators(True)
        self.column_view.set_show_column_separators(False)
        self.column_view.set_vexpand(True)
        self.column_view.set_hexpand(True)
        sort_model = Gtk.SortListModel.new(self.store, self.column_view.get_sorter())
        self.selection = Gtk.MultiSelection.new(sort_model)
        self.column_view.set_model(self.selection)
        self._build_columns()
        self.column_view.connect("activate", self._on_activate)

    # --- construction -------------------------------------------------------

    def _build_columns(self):
        name_col = Gtk.ColumnViewColumn(title="Name", factory=self._name_factory())
        name_col.set_expand(True)
        name_col.set_resizable(True)
        name_col.set_sorter(Gtk.CustomSorter.new(compare_name, None))
        self.column_view.append_column(name_col)

        size_col = Gtk.ColumnViewColumn(title="Size", factory=self._label_factory(self._bind_size))
        size_col.set_resizable(True)
        size_col.set_sorter(Gtk.CustomSorter.new(compare_size, None))
        self.column_view.append_column(size_col)

        mtime_col = Gtk.ColumnViewColumn(title="Modified", factory=self._label_factory(self._bind_mtime))
        mtime_col.set_resizable(True)
        mtime_col.set_sorter(Gtk.CustomSorter.new(compare_mtime, None))
        self.column_view.append_column(mtime_col)

        status_col = Gtk.ColumnViewColumn(title="Sync", factory=self._label_factory(self._bind_status))
        status_col.set_resizable(True)
        status_col.set_sorter(Gtk.CustomSorter.new(compare_status, None))
        self.column_view.append_column(status_col)

        self.column_view.sort_by_column(name_col, Gtk.SortType.ASCENDING)

    def _name_factory(self):
        factory = Gtk.SignalListItemFactory()
        factory.connect("setup", self._name_setup)
        factory.connect("bind", self._name_bind)
        return factory

    def _label_factory(self, bind_func):
        factory = Gtk.SignalListItemFactory()
        factory.connect("setup", self._label_setup)
        factory.connect("bind", bind_func)
        return factory

    @staticmethod
    def _name_setup(_factory, item):
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        image = Gtk.Image()
        label = Gtk.Label(xalign=0)
        label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        box.append(image)
        box.append(label)
        item.set_child(box)

    def _name_bind(self, _factory, item):
        row = item.get_item()
        box = item.get_child()
        image = box.get_first_child()
        label = image.get_next_sibling()
        icon = self._resolve_icon(row.badge_icons)
        if icon:
            image.set_from_icon_name(icon)
        else:
            image.clear()
        label.set_text(row.name)
        self._apply_css(label, row.badge_css)

    @staticmethod
    def _label_setup(_factory, item):
        label = Gtk.Label(xalign=0)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        item.set_child(label)

    def _bind_size(self, _factory, item):
        row = item.get_item()
        label = item.get_child()
        label.set_text(row.size_label)
        label.set_xalign(1)

    def _bind_mtime(self, _factory, item):
        row = item.get_item()
        label = item.get_child()
        label.set_text(row.mtime_label)
        label.set_xalign(0)

    def _bind_status(self, _factory, item):
        row = item.get_item()
        label = item.get_child()
        label.set_text(row.badge_label)
        self._apply_css(label, row.badge_css)

    # --- helpers ------------------------------------------------------------

    def _resolve_icon(self, names):
        display = self.column_view.get_display() or Gdk.Display.get_default()
        if display is None:
            return names[0] if names else None
        theme = Gtk.IconTheme.get_for_display(display)
        for name in names:
            if theme.has_icon(name):
                return name
        return names[0] if names else None

    @staticmethod
    def _apply_css(widget, css):
        for cls in CSS_CLASSES:
            widget.remove_css_class(cls)
        if css:
            widget.add_css_class(css)

    # --- navigation ---------------------------------------------------------

    def navigate(self, rel, record=True):
        rel = rel or ""
        self.current_rel = rel
        if record:
            self._history = self._history[: self._history_pos + 1]
            if not self._history or self._history[-1] != rel:
                self._history.append(rel)
            self._history_pos = len(self._history) - 1
        self.refresh()

    def go_up(self):
        if self.current_rel == "":
            return
        self.navigate(util.parent_rel(self.current_rel))

    def go_back(self):
        if self._history_pos > 0:
            self._history_pos -= 1
            self.navigate(self._history[self._history_pos], record=False)

    def go_forward(self):
        if self._history_pos < len(self._history) - 1:
            self._history_pos += 1
            self.navigate(self._history[self._history_pos], record=False)

    def can_go_back(self):
        return self._history_pos > 0

    def can_go_forward(self):
        return self._history_pos < len(self._history) - 1

    # --- data ---------------------------------------------------------------

    def refresh(self):
        # Bump a generation token so a slow reply for a folder the user already
        # navigated away from is dropped instead of repainting the wrong listing.
        self._gen += 1
        gen = self._gen
        rpcclient.list_dir(
            self.current_rel,
            lambda resp: self._on_list(resp, gen),
            lambda exc: self._on_list_error(exc, gen),
        )

    def _on_list(self, resp, gen):
        if self._closing or gen != self._gen:
            return
        entries = resp.get("entries") or []
        self.store.remove_all()
        for entry in entries:
            self.store.append(FileRow(entry))
        self._window.on_folder_loaded(self.current_rel, entries)

    def _on_list_error(self, exc, gen):
        if self._closing or gen != self._gen:
            return
        self._window.on_engine_unreachable(str(exc))

    # --- selection ----------------------------------------------------------

    def selected_rows(self):
        rows = []
        model = self.selection
        for index in range(model.get_n_items()):
            if model.is_selected(index):
                item = model.get_item(index)
                if item is not None:
                    rows.append(item)
        return rows

    # --- actions ------------------------------------------------------------

    def _on_activate(self, _view, position):
        model = self.column_view.get_model()
        row = model.get_item(position)
        if row is None:
            return
        self.activate_row(row)

    def activate_row(self, row):
        if row.is_dir:
            self.navigate(row.rel_path)
        else:
            self.open_row(row)

    def open_row(self, row):
        uri = GLib.filename_to_uri(paths.mount_abs(row.rel_path), None)
        try:
            Gio.AppInfo.launch_default_for_uri(uri, None)
        except GLib.Error as exc:
            dialogs.error(self._window, "Could not open file", exc.message)

    def open_selected(self):
        rows = self.selected_rows()
        if not rows:
            return
        self.activate_row(rows[0])

    def pin_selected(self):
        rows = self.selected_rows()
        if not rows:
            return
        path_list = [r.rel_path for r in rows]
        self._window.set_status_message(f"Downloading {len(path_list)} item(s)...")
        rpcclient.pin(path_list, self.on_rpc_done, self.on_rpc_error)

    def unpin_selected(self):
        rows = self.selected_rows()
        if not rows:
            return
        path_list = [r.rel_path for r in rows]
        self._window.set_status_message(f"Freeing space for {len(path_list)} item(s)...")
        rpcclient.unpin(path_list, self.on_rpc_done, self.on_rpc_error)

    def on_rpc_done(self, resp):
        if self._closing:
            return
        results = resp.get("results") or []
        failed = [r for r in results if not r.get("ok")]
        if failed:
            body = "\n".join(f"{r.get('path')}: {r.get('note', '')}" for r in failed[:10])
            dialogs.error(self._window, "Finished with errors", body)
        else:
            self._window.set_status_message("Done")
        self.refresh()
        self._window.poke_state()

    def on_rpc_error(self, exc):
        if self._closing:
            return
        dialogs.error(self._window, "Engine request failed", str(exc))
        self._window.poke_state()

    def trash_selected(self):
        rows = self.selected_rows()
        if not rows:
            return
        if len(rows) == 1:
            heading = "Move to trash"
            body = f'Move "{rows[0].name}" to the trash?\n\nThe file is removed from Proton Drive (recoverable there).'
        else:
            heading = f"Move {len(rows)} items to trash"
            names = ", ".join(r.name for r in rows[:5])
            more = "" if len(rows) <= 5 else f" and {len(rows) - 5} more"
            body = f"Move {len(rows)} items to the trash?\n\n{names}{more}"
        dialogs.confirm(self._window, heading, body, lambda: self._run_bg("Moved to trash", lambda: self._trash(rows)))

    def _trash(self, rows):
        errors = []
        for row in rows:
            try:
                Gio.File.new_for_path(paths.mount_abs(row.rel_path)).trash(None)
            except GLib.Error as exc:
                errors.append(f"{row.name}: {exc.message}")
        return errors

    def rename_selected(self):
        rows = self.selected_rows()
        if len(rows) != 1:
            dialogs.error(self._window, "Rename", "Select exactly one item to rename.")
            return
        row = rows[0]
        dialogs.prompt(
            self._window,
            "Rename",
            f'New name for "{row.name}":',
            row.name,
            lambda name: self._run_bg(f"Renamed to {name}", lambda: self._rename(row, name)),
            accept_label="Rename",
        )

    def _rename(self, row, name):
        target = Gio.File.new_for_path(paths.mount_abs(row.rel_path))
        target.set_display_name(name, None)
        return []

    def new_folder(self):
        initial = "New folder"
        dialogs.prompt(
            self._window,
            "New folder",
            "Name for the new folder:",
            initial,
            lambda name: self._run_bg(f"Created folder {name}", lambda: self._mkdir(name)),
            accept_label="Create",
        )

    def _mkdir(self, name):
        target = util.join_rel(self.current_rel, name)
        Gio.File.new_for_path(paths.mount_abs(target)).make_directory(None)
        return []

    # --- background file operations ----------------------------------------

    def _run_bg(self, label, work):
        self._window.set_status_message(f"{label}...")

        def runner():
            try:
                errors = work()
            except GLib.Error as exc:
                errors = [exc.message]
            except Exception as exc:  # noqa: BLE001 - surfaced to the UI thread
                errors = [str(exc)]
            GLib.idle_add(self._bg_done, label, errors)

        threading.Thread(target=runner, daemon=True, name="gui-op").start()

    def _bg_done(self, label, errors):
        if self._closing:
            return False
        if errors:
            dialogs.error(self._window, f"Action failed: {label}", os.linesep.join(str(e) for e in errors[:10]))
        else:
            self._window.set_status_message(f"{label}.")
        self.refresh()
        self._window.poke_state()
        return False

    def close(self):
        self._closing = True

    def open_filters(self):
        target = paths.mount_abs(".protonignore")
        if not os.path.exists(target):
            # the engine only creates it once present in the tree; create an empty one
            try:
                with open(target, "w", encoding="utf-8"):
                    pass
            except OSError:
                target = os.path.join(paths.tree_root(), ".protonignore")
        uri = GLib.filename_to_uri(target, None)
        try:
            Gio.AppInfo.launch_default_for_uri(uri, None)
        except GLib.Error as exc:
            dialogs.error(self._window, "Could not open filters file", exc.message)
