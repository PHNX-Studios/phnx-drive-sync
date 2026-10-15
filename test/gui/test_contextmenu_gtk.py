"""Context-menu button wiring (GTK; skipped when PyGObject is unavailable).

The pure spec lives in test_contextmenu.py; here we check that a rendered menu
item is a real button that activates the window's matching ``win.*`` action on
click, which is what made the menu work when a popover parented to a ColumnView
cell would otherwise appear but do nothing.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

try:
    import gi

    gi.require_version("Gtk", "4.0")
    from gi.repository import Gtk  # noqa: E402

    from phnxdgui import contextmenu  # noqa: E402

    HAVE_GTK = True
except Exception as _exc:  # pragma: no cover - only when PyGObject is missing
    HAVE_GTK = False
    _GTK_ERROR = _exc


class _FakeWindow:
    def __init__(self):
        self._context_popover = None
        self.activated = []

    def activate_action(self, name, arg=None):
        self.activated.append((name, arg))
        return True


class _FakeRow:
    def __init__(self, is_dir=False, presence="local", pinned=False):
        self.is_dir = is_dir
        self.presence = presence
        self.pinned = pinned


@unittest.skipUnless(HAVE_GTK, "PyGObject/GTK not available")
class MenuButtons(unittest.TestCase):
    def test_item_button_activates_action(self):
        window = _FakeWindow()
        button = contextmenu._menu_item(window, "Keep on this device", "win.pin")
        self.assertIsInstance(button, Gtk.Button)
        self.assertEqual(button.get_label(), "Keep on this device")
        button.emit("clicked")
        self.assertEqual(window.activated, [("win.pin", None)])

    def test_every_spec_item_is_wired(self):
        window = _FakeWindow()
        ctx = contextmenu.context_for([_FakeRow()], engine_up=True)
        fired = []
        for section in contextmenu.menu_spec_for(ctx):
            for label, action in section:
                button = contextmenu._menu_item(window, label, action)
                window.activated.clear()
                button.emit("clicked")
                fired.extend(name for name, _ in window.activated)
        self.assertIn("win.pin", fired)
        self.assertIn("win.unpin", fired)
        self.assertIn("win.open", fired)
        self.assertIn("win.trash", fired)

    def test_background_items_are_wired(self):
        window = _FakeWindow()
        ctx = contextmenu.context_for([], engine_up=True)
        fired = []
        for section in contextmenu.menu_spec_for(ctx):
            for label, action in section:
                button = contextmenu._menu_item(window, label, action)
                window.activated.clear()
                button.emit("clicked")
                fired.extend(name for name, _ in window.activated)
        self.assertIn("win.evict-all", fired)
        self.assertIn("win.new-folder", fired)


if __name__ == "__main__":
    unittest.main()
