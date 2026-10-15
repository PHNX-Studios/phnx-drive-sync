"""sync_version change-signal tests (pure model, no display required)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

from phnxdgui import statewatch  # noqa: E402


class SyncVersion(unittest.TestCase):
    def test_empty_is_none(self):
        self.assertIsNone(statewatch.sync_version({}))
        self.assertIsNone(statewatch.sync_version(None))

    def test_prefers_revision(self):
        status = {"revision": 7, "lastPassAt": "2026-01-01T00:00:00Z", "counts": {"placeholders": 2}}
        self.assertEqual(statewatch.sync_version(status), ("rev", 7))

    def test_revision_change_is_detected(self):
        self.assertNotEqual(statewatch.sync_version({"revision": 1}), statewatch.sync_version({"revision": 2}))

    def test_revision_reset_is_detected(self):
        # engine restart: revision goes backwards; any change must trigger a refresh
        self.assertNotEqual(statewatch.sync_version({"revision": 9}), statewatch.sync_version({"revision": 0}))

    def test_fallback_fingerprint_for_older_engine(self):
        base = {"lastPassAt": "t1", "counts": {"placeholders": 1, "reclaimable": 10, "tracked": 5}, "pid": 42}
        self.assertEqual(statewatch.sync_version(base), ("t1", 1, 10, 5, 42))

    def test_fallback_detects_count_change(self):
        base = {"lastPassAt": "t1", "counts": {"placeholders": 1, "reclaimable": 10, "tracked": 5}, "pid": 42}
        moved = {**base, "counts": {"placeholders": 2, "reclaimable": 10, "tracked": 5}}
        self.assertNotEqual(statewatch.sync_version(base), statewatch.sync_version(moved))

    def test_stable_fingerprint_is_equal(self):
        base = {"lastPassAt": "t1", "counts": {"placeholders": 1, "reclaimable": 10, "tracked": 5}, "pid": 42}
        self.assertEqual(statewatch.sync_version(dict(base)), statewatch.sync_version(dict(base)))

    def test_missing_counts_does_not_crash(self):
        self.assertEqual(statewatch.sync_version({"lastPassAt": "t1", "pid": 1}), ("t1", None, None, None, 1))


if __name__ == "__main__":
    unittest.main()
