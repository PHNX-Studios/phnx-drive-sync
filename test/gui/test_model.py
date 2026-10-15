"""Row model and column-sort comparators (skipped when GTK is unavailable)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

try:
    import gi

    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")
    from gi.repository import Gdk, Gtk  # noqa: E402

    from phnxdgui.filebrowser import FileBrowser, compare_mtime, compare_name, compare_size, compare_status  # noqa: E402
    from phnxdgui.rows import FileRow, _entry_fields  # noqa: E402

    HAVE_GTK = True
except Exception as _exc:  # pragma: no cover - only when PyGObject is missing
    HAVE_GTK = False
    _GTK_ERROR = _exc


def _display_available():
    """True only when GTK has a usable display.

    ``FileRow`` is a plain GObject and needs no display, but constructing a
    ``FileBrowser`` creates widgets, and creating a widget with no display
    segfaults on some GTK builds (seen with GTK 4.14 on the CI runners). Require
    an actual ``Gdk.Display``; CI provides one via xvfb-run.
    """
    if not HAVE_GTK:
        return False
    try:
        Gtk.init_check()
        return Gdk.Display.get_default() is not None
    except Exception:  # pragma: no cover - defensive
        return False


HAVE_DISPLAY = _display_available()


def file_entry(name, **over):
    base = {
        "path": name,
        "name": name,
        "type": "file",
        "presence": "local",
        "sync": "clean",
        "pinned": False,
        "size": 0,
        "mtime": 0,
    }
    base.update(over)
    return base


@unittest.skipUnless(HAVE_GTK, "PyGObject/GTK not available")
class Rows(unittest.TestCase):
    def test_fields_and_labels(self):
        row = FileRow(file_entry("b.txt", size=2048))
        self.assertEqual(row.name, "b.txt")
        self.assertFalse(row.is_dir)
        self.assertEqual(row.size_label, "2.0 KB")
        self.assertEqual(row.badge_css, "synced")

    def test_directory_size_label(self):
        row = FileRow(file_entry("sub", type="dir", sync="n/a"))
        self.assertTrue(row.is_dir)
        self.assertEqual(row.size_label, "-")

    def test_unknown_size(self):
        row = FileRow(file_entry("x.bin", size=None, sync="unsynced"))
        self.assertEqual(row.size_label, "-")


@unittest.skipUnless(HAVE_GTK, "PyGObject/GTK not available")
class SortComparators(unittest.TestCase):
    def setUp(self):
        self.dir = FileRow(file_entry("zzz-dir", type="dir", sync="n/a"))
        self.a = FileRow(file_entry("apple", size=10, mtime=100, presence="online"))
        self.b = FileRow(file_entry("banana", size=20, mtime=200, presence="local", sync="clean"))

    def test_directories_sort_first(self):
        self.assertLess(compare_name(self.dir, self.a, None), 0)
        self.assertGreater(compare_name(self.a, self.dir, None), 0)

    def test_name_case_insensitive(self):
        self.assertLess(compare_name(self.a, self.b, None), 0)

    def test_size(self):
        self.assertLess(compare_size(self.a, self.b, None), 0)

    def test_mtime(self):
        self.assertLess(compare_mtime(self.a, self.b, None), 0)

    def test_status_orders_cloud_before_synced(self):
        self.assertLess(compare_status(self.a, self.b, None), 0)


class EntryFields(unittest.TestCase):
    def test_file_fields(self):
        fields = _entry_fields(file_entry("b.txt", size=2048))
        self.assertEqual(fields["name"], "b.txt")
        self.assertFalse(fields["is_dir"])
        self.assertEqual(fields["size_label"], "2.0 KB")
        self.assertEqual(fields["badge_css"], "synced")

    def test_directory_fields(self):
        fields = _entry_fields(file_entry("sub", type="dir", sync="n/a"))
        self.assertTrue(fields["is_dir"])
        self.assertEqual(fields["size_label"], "-")
        self.assertEqual(fields["badge_css"], "dim")

    def test_unknown_size_label(self):
        fields = _entry_fields(file_entry("x.bin", size=None, sync="unsynced"))
        self.assertEqual(fields["size_label"], "-")


@unittest.skipUnless(HAVE_GTK, "PyGObject/GTK not available")
class ApplyEntry(unittest.TestCase):
    def test_no_change_returns_false(self):
        row = FileRow(file_entry("a.txt"))
        self.assertFalse(row.apply_entry(file_entry("a.txt")))
        self.assertEqual(row.get_property("revision"), 0)

    def test_change_updates_and_bumps_revision(self):
        row = FileRow(file_entry("a.txt", sync="dirty", presence="local"))
        before = row.get_property("revision")
        self.assertTrue(row.apply_entry(file_entry("a.txt", sync="clean", presence="local")))
        self.assertEqual(row.sync, "clean")
        self.assertEqual(row.badge_css, "synced")
        self.assertEqual(row.get_property("revision"), before + 1)

    def test_online_flip_changes_badge(self):
        row = FileRow(file_entry("a.txt", presence="local", sync="clean"))
        self.assertTrue(row.apply_entry(file_entry("a.txt", presence="online", sync="clean")))
        self.assertEqual(row.badge_css, "cloud")

    def test_revision_notify_fires_once_per_change(self):
        row = FileRow(file_entry("a.txt", sync="dirty"))
        seen = []
        row.connect("notify::revision", lambda _r, _p: seen.append(1))
        row.apply_entry(file_entry("a.txt", sync="clean"))
        row.apply_entry(file_entry("a.txt", sync="clean"))  # no-op, no notify
        self.assertEqual(len(seen), 1)


class _FakeWindow:
    def on_folder_loaded(self, rel, entries):
        pass

    def set_status_message(self, message):
        pass

    def poke_state(self):
        pass

    def on_engine_unreachable(self, message):
        pass


@unittest.skipUnless(HAVE_DISPLAY, "no GTK display available (run under xvfb-run)")
class Reconcile(unittest.TestCase):
    def _browser(self):
        return FileBrowser(_FakeWindow())

    @staticmethod
    def _paths(browser):
        return [browser.store.get_item(i).rel_path for i in range(browser.store.get_n_items())]

    def test_first_load_appends_all(self):
        browser = self._browser()
        browser._reconcile([file_entry("a"), file_entry("b")])
        self.assertEqual(set(self._paths(browser)), {"a", "b"})

    def test_update_in_place_preserves_row_identity(self):
        browser = self._browser()
        browser._reconcile([file_entry("a", sync="dirty")])
        row = browser.store.get_item(0)
        browser._reconcile([file_entry("a", sync="clean")])
        self.assertIs(browser.store.get_item(0), row)
        self.assertEqual(row.sync, "clean")

    def test_remove_and_append(self):
        browser = self._browser()
        browser._reconcile([file_entry("a"), file_entry("b")])
        browser._reconcile([file_entry("b"), file_entry("c")])
        self.assertEqual(set(self._paths(browser)), {"b", "c"})

    def test_duplicate_paths_are_collapsed(self):
        browser = self._browser()
        browser._reconcile([file_entry("a"), file_entry("a", sync="dirty")])
        self.assertEqual(self._paths(browser), ["a"])

    def test_empty_listing_clears_store(self):
        browser = self._browser()
        browser._reconcile([file_entry("a")])
        browser._reconcile([])
        self.assertEqual(self._paths(browser), [])

    def test_track_repaints_on_change_and_untrack_disconnects(self):
        browser = self._browser()
        row = FileRow(file_entry("a", sync="dirty"))
        item = Gtk.ListItem()
        seen = []
        browser._track(item, row, lambda r: seen.append(r.sync))
        row.apply_entry(file_entry("a", sync="clean"))
        self.assertEqual(seen, ["clean"])
        browser._untrack(item)
        row.apply_entry(file_entry("a", sync="dirty"))
        self.assertEqual(seen, ["clean"])  # disconnected: no further repaint


if __name__ == "__main__":
    unittest.main()
