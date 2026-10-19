"""The main application window: header, status banner, progress and the file list."""

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk, Pango

from . import dialogs, paths, rpcclient, statewatch, util
from .filebrowser import FileBrowser
from .statewatch import StateWatch

# While a pass is in flight the revision does not advance until it ends, so a
# folder being synced file by file would look frozen. Re-read it at this cadence
# (seconds) so badges settle live during long walks.
LIVE_REFRESH_S = 1.5


class MainWindow(Adw.ApplicationWindow):
    def __init__(self, application, start_rel: str = ""):
        super().__init__(application=application)
        self.set_default_size(1040, 660)
        self.set_title("PHNX Drive Sync")
        self._closing = False
        self._status = {}
        self._engine_down = False
        self._context_popover = None
        self._last_sync_version = None
        self._pass_timer = None

        self._browser = FileBrowser(self)
        self._build_ui()
        self._add_actions()
        self._install_accels()

        self._statewatch = StateWatch(self._on_state)
        self._statewatch.start()

        self.connect("close-request", self._on_close_request)
        GLib.idle_add(self._initial_navigate, start_rel)

    # --- construction -------------------------------------------------------

    def _build_ui(self):
        toolbar = Adw.ToolbarView()

        header = Adw.HeaderBar()
        toolbar.add_top_bar(header)

        nav = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        nav.add_css_class("linked")
        self._back_button = self._nav_button("go-previous-symbolic", "Back", self._browser.go_back)
        self._forward_button = self._nav_button("go-next-symbolic", "Forward", self._browser.go_forward)
        self._up_button = self._nav_button("go-up-symbolic", "Up", self._browser.go_up)
        nav.append(self._back_button)
        nav.append(self._forward_button)
        nav.append(self._up_button)
        header.pack_start(nav)

        self._title = Adw.WindowTitle(title="Proton Drive", subtitle="")
        header.set_title_widget(self._title)

        end = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self._sync_button = Gtk.Button(icon_name="view-refresh-symbolic")
        self._sync_button.set_tooltip_text("Sync now")
        self._sync_button.connect("clicked", lambda *_: self._sync_now())
        end.append(self._sync_button)
        end.append(self._build_menu_button())
        header.pack_end(end)

        self._banner = Adw.Banner()
        self._banner.set_revealed(False)
        toolbar.add_top_bar(self._banner)

        toolbar.set_content(self._build_content())

        self._path_label = Gtk.Label(xalign=0)
        self._path_label.set_ellipsize(Pango.EllipsizeMode.START)
        self._path_label.set_margin_start(12)
        self._path_label.set_margin_end(12)
        self._path_label.set_margin_top(4)
        self._path_label.set_margin_bottom(6)
        self._path_label.add_css_class("dim-label")
        self._path_label.set_text("~/Proton Drive")
        toolbar.add_bottom_bar(self._path_label)

        self._toast_overlay = Adw.ToastOverlay()
        self._toast_overlay.set_child(toolbar)
        self.set_content(self._toast_overlay)

    def _build_content(self) -> Gtk.Widget:
        self._stack = Gtk.Stack()
        self._stack.set_vexpand(True)

        self._status_page = Adw.StatusPage(
            icon_name="network-offline-symbolic",
            title="Sync engine not running",
            description="Start it with:\n\nsystemctl --user start phnx-drive-sync.service\n\nthen reopen this window.",
        )
        self._stack.add_named(self._status_page, "status")

        content_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)

        self._progress_label = Gtk.Label(xalign=0)
        self._progress_label.set_ellipsize(Pango.EllipsizeMode.END)
        self._progress_bar = Gtk.ProgressBar()
        progress_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        progress_box.set_margin_start(12)
        progress_box.set_margin_end(12)
        progress_box.set_margin_top(6)
        progress_box.set_margin_bottom(6)
        progress_box.append(self._progress_label)
        progress_box.append(self._progress_bar)
        self._progress_revealer = Gtk.Revealer()
        self._progress_revealer.set_child(progress_box)
        self._progress_revealer.set_reveal_child(False)
        content_box.append(self._progress_revealer)

        self._empty_page = Adw.StatusPage(icon_name="folder-open-symbolic", title="This folder is empty")
        empty_gesture = Gtk.GestureClick.new()
        empty_gesture.set_button(Gdk.BUTTON_SECONDARY)
        empty_gesture.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
        empty_gesture.connect("pressed", self._on_empty_right_click)
        self._empty_page.add_controller(empty_gesture)
        scroller = Gtk.ScrolledWindow()
        scroller.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scroller.set_vexpand(True)
        scroller.set_child(self._browser.column_view)

        self._inner_stack = Gtk.Stack()
        self._inner_stack.set_vexpand(True)
        self._inner_stack.add_named(scroller, "list")
        self._inner_stack.add_named(self._empty_page, "empty")
        content_box.append(self._inner_stack)

        self._stack.add_named(content_box, "content")
        return self._stack

    def _nav_button(self, icon_name, tooltip, callback):
        button = Gtk.Button(icon_name=icon_name)
        button.set_tooltip_text(tooltip)
        button.connect("clicked", lambda *_: callback())
        return button

    def _build_menu_button(self):
        menu = Gio.Menu()
        menu.append("Open", "win.open")
        menu.append("Keep on this device", "win.pin")
        menu.append("Free up space (selection)", "win.unpin")
        menu.append("Free up space (all local files)", "win.evict-all")
        section = Gio.Menu()
        section.append("New folder", "win.new-folder")
        section.append("Rename", "win.rename")
        section.append("Move to trash", "win.trash")
        menu.append_section(None, section)
        section2 = Gio.Menu()
        section2.append("Sync now", "win.sync-now")
        section2.append("Edit ignore filters", "win.edit-filters")
        menu.append_section(None, section2)
        section3 = Gio.Menu()
        section3.append("Preferences", "win.preferences")
        section3.append("About PHNX Drive Sync", "win.about")
        menu.append_section(None, section3)

        button = Gtk.MenuButton(icon_name="open-menu-symbolic")
        button.set_menu_model(menu)
        button.set_tooltip_text("Menu")
        return button

    def _add_actions(self):
        def add(name, callback):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", lambda *_: callback())
            self.add_action(action)

        add("open", self._browser.open_selected)
        add("pin", self._browser.pin_selected)
        add("unpin", self._browser.unpin_selected)
        add("evict-all", self._evict_all)
        add("new-folder", self._browser.new_folder)
        add("rename", self._browser.rename_selected)
        add("trash", self._browser.trash_selected)
        add("sync-now", self._sync_now)
        add("edit-filters", self._browser.open_filters)
        add("preferences", self._open_preferences)
        add("about", self._about)

    def _install_accels(self):
        app = self.get_application()
        if app is None:
            return
        accels = {
            "win.open": ["Return"],
            "win.sync-now": ["<Primary>r", "F5"],
            "win.new-folder": ["<Primary><Shift>n"],
            "win.rename": ["F2"],
            "win.trash": ["Delete"],
        }
        for action, keys in accels.items():
            app.set_accels_for_action(action, keys)

    # --- navigation glue ----------------------------------------------------

    def _initial_navigate(self, rel):
        self._browser.navigate(rel or "")
        return False

    def on_folder_loaded(self, rel, entries):
        if self._closing:
            return
        self._engine_down = False
        self._stack.set_visible_child_name("content")
        self._inner_stack.set_visible_child_name("list" if entries else "empty")
        self._title.set_title(util.basename(rel) or "Proton Drive")
        self._path_label.set_text(paths.mount_abs(rel) if rel else paths.mount_root())
        self._back_button.set_sensitive(self._browser.can_go_back())
        self._forward_button.set_sensitive(self._browser.can_go_forward())
        self._up_button.set_sensitive(rel != "")

    def on_engine_unreachable(self, message):
        if self._closing:
            return
        self._engine_down = True
        self._stack.set_visible_child_name("status")
        self._sync_button.set_sensitive(False)

    def set_status_message(self, message):
        if self._closing:
            return
        toast = Adw.Toast.new(message)
        toast.set_timeout(4)
        self._toast_overlay.add_toast(toast)

    def poke_state(self):
        self._statewatch.poke()

    # --- engine state -------------------------------------------------------

    def _on_state(self, status, _mount_age):
        if self._closing:
            return
        self._status = status or {}
        self._update_storage_line(self._status)
        self._update_progress(self._status)
        self._update_banner(self._status)

        available = rpcclient.engine_available()
        self._sync_button.set_sensitive(available)
        if available and self._engine_down:
            self._engine_down = False
            self._browser.refresh()
        self._maybe_live_refresh(self._status)

    def _maybe_live_refresh(self, status):
        """Re-read the visible folder when the engine reports changed sync facts.

        ``revision`` advances on every completed pass and every mutating RPC, so
        a file's badge repaints without the user navigating. During a long full
        walk the revision does not move until the end, so a faster pass-time
        timer keeps a progressively-synced folder current.
        """
        if self._closing or self._engine_down:
            return
        version = statewatch.sync_version(status)
        if version is not None and version != self._last_sync_version:
            self._last_sync_version = version
            self._browser.refresh()
        if status.get("state") == "passing":
            self._ensure_pass_refresh()

    def _ensure_pass_refresh(self):
        if self._pass_timer is not None or self._closing:
            return
        self._pass_timer = GLib.timeout_add(int(LIVE_REFRESH_S * 1000), self._pass_refresh_tick)

    def _pass_refresh_tick(self):
        """Re-read the folder at the pass cadence; stop once the pass ends."""
        if self._closing or self._engine_down or self._status.get("state") != "passing":
            self._pass_timer = None
            return GLib.SOURCE_REMOVE
        self._browser.refresh()
        return GLib.SOURCE_CONTINUE

    def _update_storage_line(self, status):
        storage = status.get("storage") or {}
        counts = status.get("counts") or {}
        parts = []
        if storage.get("max"):
            parts.append(f"{util.human_bytes(storage.get('used', 0))} of {util.human_bytes(storage['max'])} used")
        reclaim = counts.get("reclaimable")
        if isinstance(reclaim, int) and reclaim > 0:
            parts.append(f"{util.human_bytes(reclaim)} reclaimable")
        placeholders = counts.get("placeholders")
        if isinstance(placeholders, int) and placeholders > 0:
            parts.append(f"{placeholders} online-only")
        self._title.set_subtitle(" - ".join(parts) if parts else "Storage not reported yet")

    def _update_progress(self, status):
        progress = status.get("progress")
        if isinstance(progress, dict) and progress.get("current"):
            total = progress.get("total") or 0
            done = progress.get("done") or 0
            text = progress["current"]
            self._progress_label.set_text(f"{text} ({done}/{total})" if total else text)
            if total:
                self._progress_bar.set_fraction(min(1.0, done / total))
            else:
                self._progress_bar.pulse()
            self._progress_revealer.set_reveal_child(True)
        else:
            self._progress_revealer.set_reveal_child(False)

    def _update_banner(self, status):
        state = status.get("state")
        message = None
        if not status:
            message = "Waiting for the sync engine..."
        elif state == "auth-required":
            message = "Sign in required - run: phnx-drive-sync login"
        elif status.get("mount") == "degraded":
            message = "Mount degraded - the Proton Drive folder is temporarily unavailable"
        elif status.get("offline"):
            message = "Offline - files that aren't on this device can't be opened until you reconnect."
        elif status.get("lastError") and state in ("running", "passing"):
            message = f"Last sync error: {status['lastError']}"
        if message:
            self._banner.set_title(message)
            self._banner.set_revealed(True)
        else:
            self._banner.set_revealed(False)

    # --- actions ------------------------------------------------------------

    def _on_empty_right_click(self, gesture, _n_press, x, y):
        self._browser.show_background_menu(gesture.get_widget(), x, y)

    def _sync_now(self):
        if not rpcclient.engine_available():
            dialogs.error(self, "Sync engine not running", "Start it with: systemctl --user start phnx-drive-sync.service")
            return
        self.set_status_message("Sync requested")
        rpcclient.sync_now(lambda _resp: self.poke_state(), lambda exc: dialogs.error(self, "Could not request a sync", str(exc)))

    def _evict_all(self):
        reclaim = ((self._status.get("counts") or {}).get("reclaimable")) or 0
        if reclaim:
            body = (
                "Free up space by making local files online-only?\n\n"
                f"About {util.human_bytes(reclaim)} can be reclaimed. Files stay on Proton Drive and "
                "download again when you open them. Keep-on-this-device files are not touched."
            )
        else:
            body = "Free up space by making local files online-only?"
        dialogs.confirm(self, "Free up space", body, self._do_evict_all, confirm_label="Free up space", destructive=False)

    def _do_evict_all(self):
        self.set_status_message("Freeing up space...")
        rpcclient.evict_all(self._browser.on_rpc_done, self._browser.on_rpc_error)

    def _open_preferences(self):
        window = Adw.PreferencesWindow(transient_for=self, modal=True, title="Preferences")

        page = Adw.PreferencesPage(title="Sync", icon_name="emblem-synchronizing-symbolic")
        group = Adw.PreferencesGroup(
            title="Files on demand",
            description="Changes apply immediately to the running engine.",
        )

        row = Adw.ActionRow(
            title="Recall on hover",
            subtitle="Download online-only files as soon as you look at them",
        )
        switch = Gtk.Switch(valign=Gtk.Align.CENTER)
        switch.set_active(bool(self._status.get("prefetch")))
        switch.connect("notify::active", self._on_prefetch_toggled)
        row.add_suffix(switch)
        row.set_activatable_widget(switch)
        group.add(row)

        env_row = Adw.ActionRow(
            title="Advanced settings",
            subtitle=paths.env_file(),
        )
        env_row.set_subtitle_selectable(True)
        group.add(env_row)

        page.add(group)
        window.add(page)
        window.present()

    def _on_prefetch_toggled(self, switch, _param):
        mode = "on" if switch.get_active() else "off"
        rpcclient.prefetch(
            mode,
            lambda _resp: self.poke_state(),
            lambda exc: dialogs.error(self, "Could not change recall on hover", str(exc)),
        )

    def _about(self):
        about = Adw.AboutWindow(
            transient_for=self,
            application_name="PHNX Drive Sync",
            application_icon="phnx-drive-sync",
            version=util.app_version(),
            comments="File manager for an unofficial Proton Drive sync client.\nNot affiliated with or supported by Proton AG.",
            website="https://github.com/PHNX-Studios/phnx-drive-sync",
            license_type=Gtk.License.MIT_X11,
            developers=["PHNX Studios"],
        )
        about.present()

    # --- teardown -----------------------------------------------------------

    def _on_close_request(self, _window):
        self._closing = True
        self._statewatch.stop()
        if self._pass_timer is not None:
            GLib.source_remove(self._pass_timer)
            self._pass_timer = None
        self._browser.close()
        return False
