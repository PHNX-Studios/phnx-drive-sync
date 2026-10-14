"""Row model and column-sort comparators (skipped when GTK is unavailable)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

try:
    from phnxdgui.filebrowser import compare_mtime, compare_name, compare_size, compare_status  # noqa: E402
    from phnxdgui.rows import FileRow  # noqa: E402

    HAVE_GTK = True
except Exception as _exc:  # pragma: no cover - only when PyGObject is missing
    HAVE_GTK = False
    _GTK_ERROR = _exc


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


if __name__ == "__main__":
    unittest.main()
