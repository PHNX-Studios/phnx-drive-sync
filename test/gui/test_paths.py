"""Path resolution tests: the GUI must agree with src/config.ts on XDG layout."""

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

from phnxdgui import paths  # noqa: E402

_KEYS = (
    "PHNX_DRIVE_SYNC_HOME",
    "PHNX_DRIVE_SYNC_ROOT",
    "PHNX_DRIVE_SYNC_TREE",
    "DRIVE_SYNC_HOME",
    "DRIVE_SYNC_ROOT",
    "DRIVE_SYNC_TREE",
)


class Paths(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in _KEYS}
        for key in _KEYS:
            os.environ.pop(key, None)
        self._home = tempfile.mkdtemp()
        os.environ["PHNX_DRIVE_SYNC_HOME"] = self._home

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self._home, ignore_errors=True)

    def test_state_files_live_under_drive_sync_home(self):
        self.assertEqual(paths.rpc_socket(), os.path.join(self._home, "state", "rpc.sock"))
        self.assertEqual(paths.status_file(), os.path.join(self._home, "state", "status.json"))
        self.assertEqual(paths.mount_ok_file(), os.path.join(self._home, "state", "mount-ok"))

    def test_tree_defaults_under_share(self):
        self.assertEqual(paths.tree_root(), os.path.join(self._home, "share", "tree"))

    def test_mount_defaults_to_home_proton_drive(self):
        self.assertEqual(paths.mount_root(), os.path.abspath(os.path.join(os.path.expanduser("~"), "Proton Drive")))

    def test_env_overrides_win(self):
        os.environ["PHNX_DRIVE_SYNC_ROOT"] = os.path.join(self._home, "mnt")
        os.environ["PHNX_DRIVE_SYNC_TREE"] = os.path.join(self._home, "realtree")
        self.assertEqual(paths.mount_root(), os.path.join(self._home, "mnt"))
        self.assertEqual(paths.tree_root(), os.path.join(self._home, "realtree"))

    def test_legacy_drive_sync_names_still_work(self):
        os.environ.pop("PHNX_DRIVE_SYNC_HOME", None)
        os.environ["DRIVE_SYNC_HOME"] = self._home
        self.assertEqual(paths.rpc_socket(), os.path.join(self._home, "state", "rpc.sock"))

    def test_canonical_name_wins_over_legacy(self):
        other = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, other, ignore_errors=True)
        os.environ["DRIVE_SYNC_HOME"] = other
        self.assertEqual(paths.rpc_socket(), os.path.join(self._home, "state", "rpc.sock"))

    def test_to_rel(self):
        os.environ["PHNX_DRIVE_SYNC_ROOT"] = os.path.join(self._home, "mnt")
        os.environ["PHNX_DRIVE_SYNC_TREE"] = os.path.join(self._home, "realtree")
        self.assertEqual(paths.to_rel(""), "")
        self.assertEqual(paths.to_rel(os.path.join(self._home, "mnt")), "")
        self.assertEqual(paths.to_rel(os.path.join(self._home, "mnt", "a", "b")), "a/b")
        self.assertEqual(paths.to_rel(os.path.join(self._home, "realtree", "a")), "a")
        self.assertEqual(paths.to_rel("rel/path"), "rel/path")

    def test_mount_abs(self):
        os.environ["PHNX_DRIVE_SYNC_ROOT"] = os.path.join(self._home, "mnt")
        self.assertEqual(paths.mount_abs(""), os.path.join(self._home, "mnt"))
        self.assertEqual(paths.mount_abs("a/b"), os.path.join(self._home, "mnt", "a", "b"))


if __name__ == "__main__":
    unittest.main()
