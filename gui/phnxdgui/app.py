"""Adw.Application: single instance, stylesheet and icon theme setup."""

import os

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk

from . import paths
from .window import MainWindow

APP_ID = "org.phnxstudios.PhnxDriveSync"

# Status colours mirror the Nautilus emblem meanings: green check = on this
# device, blue cloud = online-only, amber = pending/not-yet-synced.
CSS = """
.synced { color: #2ec27e; }
.cloud { color: #62a0ea; }
.pending { color: #e5a50a; }
.newsync { color: #e5a50a; }
.dim { opacity: 0.75; }
"""


def _load_css(provider, css):
    if hasattr(provider, "load_from_string"):
        provider.load_from_string(css)
        return
    try:
        provider.load_from_data(css)
    except TypeError:
        provider.load_from_data(css.encode("utf-8"))


class PhnxApplication(Adw.Application):
    def __init__(self, start_rel: str = "", self_check: bool = False, unique: bool = True):
        if unique:
            super().__init__(application_id=APP_ID)
        else:
            # Self-check must never collide with (or activate) a running instance.
            super().__init__(application_id=APP_ID + ".SelfCheck", flags=Gio.ApplicationFlags.NON_UNIQUE)
        self._start_rel = start_rel
        self._self_check = self_check
        self.connect("startup", self._on_startup)

    def _on_startup(self, _app):
        display = Gdk.Display.get_default()
        if display is None:
            return
        provider = Gtk.CssProvider()
        _load_css(provider, CSS)
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        theme = Gtk.IconTheme.get_for_display(display)
        assets = os.path.join(paths.app_root(), "assets")
        if os.path.isdir(assets):
            theme.add_search_path(assets)

    def do_activate(self):
        window = self.props.active_window
        if window is None:
            window = MainWindow(application=self, start_rel=self._start_rel)
        window.present()
        if self._self_check:
            GLib.timeout_add(250, self._finish_self_check)

    def _finish_self_check(self) -> bool:
        self.quit()
        return False
