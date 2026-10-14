"""Pure-helper unit tests (no GTK/display required)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

from phnxdgui import util  # noqa: E402


class HumanBytes(unittest.TestCase):
    def test_none(self):
        self.assertEqual(util.human_bytes(None), "?")

    def test_bytes(self):
        self.assertEqual(util.human_bytes(0), "0 B")
        self.assertEqual(util.human_bytes(512), "512 B")

    def test_scaling(self):
        self.assertEqual(util.human_bytes(1024), "1.0 KB")
        self.assertEqual(util.human_bytes(1536), "1.5 KB")
        self.assertEqual(util.human_bytes(1024 ** 3), "1.0 GB")


class RelPaths(unittest.TestCase):
    def test_basename(self):
        self.assertEqual(util.basename("a/b/c.txt"), "c.txt")
        self.assertEqual(util.basename("top"), "top")
        self.assertEqual(util.basename(""), "")

    def test_parent(self):
        self.assertEqual(util.parent_rel("a/b/c.txt"), "a/b")
        self.assertEqual(util.parent_rel("top"), "")
        self.assertEqual(util.parent_rel("a"), "")

    def test_join(self):
        self.assertEqual(util.join_rel("a", "b"), "a/b")
        self.assertEqual(util.join_rel("", "b"), "b")


class Mtime(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(util.fmt_mtime(None), "")
        self.assertEqual(util.fmt_mtime(0), "")

    def test_formats_epoch(self):
        self.assertTrue(util.fmt_mtime(1_700_000_000_000))


if __name__ == "__main__":
    unittest.main()
