"""The directory view and the file operations on it.

The listing comes from the engine's ``list`` RPC (the engine owns sync status);
file operations go through the FUSE mount with GIO, so the sidecar's placeholder
semantics (hydrate on open, remote-only rename/trash) apply automatically. Slow
operations run on worker threads and report back on the GTK main loop.

A refresh merges the new listing into the existing store in place (rows that
persist are updated through ``FileRow.apply_entry``) instead of rebuilding it, so
a live status change repaints only the affected cells and leaves the selection
and the scroll position untouched.
"""

import os
import threading

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
from gi.repository import Gdk, Gio, GLib, Gtk, Pango

from . import contextmenu, dialogs, paths, rpcclient, util
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
        self._attach_background_gesture()

    # --- construction -------------------------------------------------------

    def _build_columns(self):
        self._name_sorter = Gtk.CustomSorter.new(compare_name, None)
        name_col = Gtk.ColumnViewColumn(title="Name", factory=self._name_factory())
        name_col.set_expand(True)
        name_col.set_resizable(True)
        name_col.set_sorter(self._name_sorter)
        self.column_view.append_column(name_col)

        self._size_sorter = Gtk.CustomSorter.new(compare_size, None)
        size_col = Gtk.ColumnViewColumn(title="Size", factory=self._label_factory(self._render_size))
        size_col.set_resizable(True)
        size_col.set_sorter(self._size_sorter)
        self.column_view.append_column(size_col)

        self._mtime_sorter = Gtk.CustomSorter.new(compare_mtime, None)
        mtime_col = Gtk.ColumnViewColumn(title="Modified", factory=self._label_factory(self._render_mtime))
        mtime_col.set_resizable(True)
        mtime_col.set_sorter(self._mtime_sorter)
        self.column_view.append_column(mtime_col)

        self._status_sorter = Gtk.CustomSorter.new(compare_status, None)
        status_col = Gtk.ColumnViewColumn(title="Sync", factory=self._label_factory(self._render_status))
        status_col.set_resizable(True)
        status_col.set_sorter(self._status_sorter)
        self.column_view.append_column(status_col)

        self.column_view.sort_by_column(name_col, Gtk.SortType.ASCENDING)

    def _name_factory(self):
        factory = Gtk.SignalListItemFactory()
        factory.connect("setup", self._name_setup)
        factory.connect("bind", self._name_bind)
        factory.connect("unbind", self._name_unbind)
        return factory

    def _label_factory(self, render):
        factory = Gtk.SignalListItemFactory()
        factory.connect("setup", self._label_setup)
        factory.connect("bind", lambda _factory, item: self._label_bind(item, render))
        factory.connect("unbind", self._label_unbind)
        return factory

    def _name_setup(self, _factory, item):
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        image = Gtk.Image()
        label = Gtk.Label(xalign=0)
        label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        box.append(image)
        box.append(label)
        item.set_child(box)
        self._attach_row_gesture(item, box)

    def _name_bind(self, _factory, item):
        box = item.get_child()
        row = item.get_item()
        self._render_name(box, row)
        self._track(item, row, lambda r: self._render_name(box, r))

    def _name_unbind(self, _factory, item):
        self._untrack(item)

    def _label_setup(self, _factory, item):
        label = Gtk.Label(xalign=0)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        item.set_child(label)
        self._attach_row_gesture(item, label)

    def _label_bind(self, item, render):
        label = item.get_child()
        row = item.get_item()
        render(label, row)
        self._track(item, row, lambda r: render(label, r))

    def _label_unbind(self, _factory, item):
        self._untrack(item)

    def _track(self, item, row, render):
        """Render a row into its recycled cell and repaint it on later changes.

        The handler id is stored alongside the row on the ListItem so ``unbind``
        can always disconnect it, even if ``get_item()`` is already cleared.
        """
        handler = row.connect("notify::revision", lambda r, _pspec: render(r))
        item._phnx_bound = (row, handler)

    def _untrack(self, item):
        bound = getattr(item, "_phnx_bound", None)
        if bound is not None:
            row, handler = bound
            row.disconnect(handler)
        item._phnx_bound = None

    # --- rendering ----------------------------------------------------------

    def _render_name(self, box, row):
        image = box.get_first_child()
        label = image.get_next_sibling()
        icon = self._resolve_icon(row.badge_icons)
        if icon:
            image.set_from_icon_name(icon)
        else:
            image.clear()
        label.set_text(row.name)
        self._apply_css(label, row.badge_css)

    def _render_size(self, label, row):
        label.set_xalign(1)
        label.set_text(row.size_label)

    def _render_mtime(self, label, row):
        label.set_xalign(0)
        label.set_text(row.mtime_label)

    def _render_status(self, label, row):
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
        self._reconcile(entries)
        self._window.on_folder_loaded(self.current_rel, entries)

    def _reconcile(self, entries):
        """Merge a fresh listing into the store in place.

        Rows still present are updated through ``apply_entry`` (badges, size and
        mtime repaint without disturbing the list), missing rows are removed and
        new rows are appended (the sorter places them). A different folder simply
        becomes an all-remove/all-append merge, which is correct for navigation.
        """
        by_path = {}
        for entry in entries:
            path = entry.get("path", "")
            if path not in by_path:
                by_path[path] = entry

        rows_by_path = {}
        for index in range(self.store.get_n_items()):
            row = self.store.get_item(index)
            rows_by_path[row.rel_path] = row

        changed = False
        for path, entry in by_path.items():
            row = rows_by_path.get(path)
            if row is None:
                self.store.append(FileRow(entry))
                changed = True
            elif row.apply_entry(entry):
                changed = True

        for path, row in rows_by_path.items():
            if path not in by_path:
                index = self._index_of(row)
                if index is not None:
                    self.store.remove(index)
                changed = True

        if changed:
            self._invalidate_sorters()

    def _index_of(self, row):
        for index in range(self.store.get_n_items()):
            if self.store.get_item(index) is row:
                return index
        return None

    def _invalidate_sorters(self):
        # A changed badge/size/mtime may reorder the view when that column is the
        # active sort; tell every sorter the order may have changed.
        for sorter in (self._name_sorter, self._size_sorter, self._mtime_sorter, self._status_sorter):
            sorter.changed(Gtk.SorterChange.DIFFERENT)

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

    # --- context menu -------------------------------------------------------

    def _attach_row_gesture(self, item, child):
        """Right-click on any cell of a row opens that row's context menu.

        The Gtk.ListItem is passed as user data so the handler can resolve the
        currently bound FileRow regardless of factory recycling.
        """
        gesture = Gtk.GestureClick.new()
        gesture.set_button(Gdk.BUTTON_SECONDARY)
        gesture.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
        gesture.connect("pressed", self._on_row_right_click, item)
        child.add_controller(gesture)

    def _attach_background_gesture(self):
        """Right-click on empty space opens the folder background menu.

        BUBBLE phase lets it fire on the column view's own surface; row clicks
        are claimed by the cell gesture above and never reach it.
        """
        gesture = Gtk.GestureClick.new()
        gesture.set_button(Gdk.BUTTON_SECONDARY)
        gesture.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
        gesture.connect("pressed", self._on_background_right_click)
        self.column_view.add_controller(gesture)

    def _on_row_right_click(self, gesture, _n_press, x, y, item):
        row = item.get_item()
        if row is None:
            return
        # Claim the sequence so the background controller on the column view
        # does not also fire for a row click.
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        self._select_only_if_needed(item)
        ctx = contextmenu.context_for(self.selected_rows(), rpcclient.engine_available())
        contextmenu.present(self._window, gesture.get_widget(), x, y, ctx)

    def _on_background_right_click(self, gesture, _n_press, x, y):
        widget = gesture.get_widget()
        # The header is a child of the column view, so its clicks bubble here
        # too; a right-click on a column header is not "empty space".
        picked = widget.pick(x, y, Gtk.PickFlags.DEFAULT)
        if picked is not None and picked.get_ancestor("GtkColumnViewTitle") is not None:
            return
        self.show_background_menu(widget, x, y)

    def show_background_menu(self, widget, x, y):
        """Present the no-selection menu (also used by the empty-folder page)."""
        ctx = contextmenu.context_for([], rpcclient.engine_available())
        contextmenu.present(self._window, widget, x, y, ctx)

    def _select_only_if_needed(self, item):
        """Right-clicking an unselected row selects just it; an already selected
        row keeps the current (possibly multi-) selection, as file managers do."""
        position = item.get_position()
        if position == Gtk.INVALID_LIST_POSITION:
            return
        if not self.selection.is_selected(position):
            self.selection.select_item(position, True)

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
