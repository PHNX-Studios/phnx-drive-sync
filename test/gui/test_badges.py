"""Badge mapping tests (pure status model)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

from phnxdgui import badges  # noqa: E402


def entry(**over):
    base = {"path": "x", "name": "x", "type": "file", "presence": "local", "sync": "clean", "pinned": False}
    base.update(over)
    return base


class Badges(unittest.TestCase):
    def test_directory(self):
        _icons, css, label = badges.badge_for(entry(type="dir", sync="n/a"))
        self.assertEqual(css, badges.FOLDER_CSS)
        self.assertEqual(label, "Folder")

    def test_online_only(self):
        _icons, css, label = badges.badge_for(entry(presence="online"))
        self.assertEqual(css, badges.CLOUD_CSS)
        self.assertEqual(label, "Online only")

    def test_local_clean(self):
        _icons, css, label = badges.badge_for(entry(presence="local", sync="clean"))
        self.assertEqual(css, badges.SYNCED_CSS)
        self.assertEqual(label, "On this device")

    def test_dirty(self):
        _icons, css, label = badges.badge_for(entry(sync="dirty"))
        self.assertEqual(css, badges.PENDING_CSS)
        self.assertEqual(label, "Pending sync")

    def test_unsynced(self):
        _icons, css, label = badges.badge_for(entry(sync="unsynced"))
        self.assertEqual(css, badges.NEW_CSS)
        self.assertEqual(label, "Not synced yet")

    def test_pinned_adds_marker(self):
        icons, _css, label = badges.badge_for(entry(pinned=True))
        self.assertIn(badges.PIN_ICONS[0], icons)
        self.assertIn("kept on this device", label)

    def test_online_pinned(self):
        icons, css, label = badges.badge_for(entry(presence="online", pinned=True))
        self.assertEqual(css, badges.CLOUD_CSS)
        self.assertIn(badges.PIN_ICONS[0], icons)
        self.assertIn("kept on this device", label)


if __name__ == "__main__":
    unittest.main()
