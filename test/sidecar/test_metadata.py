"""Characterization: attributes, inode numbers, directory listings, statfs."""

import errno
import hashlib
import os
import stat
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from harness import SidecarTestCase

MTIME_MS = 1_700_000_000_123


def expected_ino(rel):
    """The salt-0 inode the sidecar derives from a path (stable across restarts)."""
    return 2 + (int(hashlib.sha1(rel.encode()).hexdigest(), 16) & ((1 << 62) - 1))


class PlaceholderAttributes(SidecarTestCase):
    def setUpFixture(self):
        self.fx.add_placeholder('doc.pdf', 1234567, MTIME_MS)
        self.fx.add_placeholder('sub/deep.bin', 42, MTIME_MS)
        os.makedirs(self.fx.tree_path('sub'))

    def test_placeholder_reports_baseline_size_with_zero_blocks(self):
        st = os.stat(self.fx.mnt('doc.pdf'))
        self.assertEqual(st.st_size, 1234567)
        self.assertEqual(st.st_blocks, 0)  # du shows 0, stat shows the real size

    def test_placeholder_mode_and_owner(self):
        st = os.stat(self.fx.mnt('doc.pdf'))
        self.assertEqual(st.st_mode, stat.S_IFREG | 0o644)
        self.assertEqual(st.st_nlink, 1)
        self.assertEqual((st.st_uid, st.st_gid), (os.getuid(), os.getgid()))

    def test_placeholder_times_come_from_baseline_mtime(self):
        st = os.stat(self.fx.mnt('doc.pdf'))
        self.assertEqual(st.st_mtime_ns, MTIME_MS * 1_000_000)
        self.assertEqual(st.st_atime_ns, MTIME_MS * 1_000_000)
        self.assertEqual(st.st_ctime_ns, MTIME_MS * 1_000_000)

    def test_placeholder_in_subdirectory(self):
        self.assertEqual(os.stat(self.fx.mnt('sub/deep.bin')).st_size, 42)

    def test_marker_on_directory_row_is_not_a_placeholder(self):
        self.fx.add_placeholder('somedir', 0, MTIME_MS, kind='dir')
        self.assertErrno(errno.ENOENT, os.stat, self.fx.mnt('somedir'))

    def test_baseline_row_without_marker_is_not_shown(self):
        self.fx.add_placeholder('unmarked.txt', 10, MTIME_MS, marked=False)
        self.assertErrno(errno.ENOENT, os.stat, self.fx.mnt('unmarked.txt'))

    def test_missing_entry_is_enoent(self):
        self.assertErrno(errno.ENOENT, os.stat, self.fx.mnt('nope.txt'))

    def test_null_size_and_mtime_read_as_zero(self):
        self.fx.add_placeholder('blank.txt', None, None)
        st = os.stat(self.fx.mnt('blank.txt'))
        self.assertEqual((st.st_size, st.st_mtime_ns), (0, 0))


class MaterializedAttributes(SidecarTestCase):
    def setUpFixture(self):
        self.fx.write_tree('real.txt', b'x' * 5000)
        os.chmod(self.fx.tree_path('real.txt'), 0o600)

    def test_passthrough_matches_tree(self):
        mst = os.stat(self.fx.mnt('real.txt'))
        tst = os.stat(self.fx.tree_path('real.txt'))
        self.assertEqual(mst.st_size, 5000)
        self.assertEqual(mst.st_mode, tst.st_mode)
        self.assertEqual(mst.st_mtime_ns, tst.st_mtime_ns)
        self.assertEqual(mst.st_blocks, tst.st_blocks)

    def test_tree_wins_over_a_stale_marker(self):
        # a marker whose bytes are on disk anyway: the tree is the truth
        self.fx.add_placeholder('real.txt', 999999, MTIME_MS)
        st = os.stat(self.fx.mnt('real.txt'))
        self.assertEqual(st.st_size, 5000)
        self.assertNotEqual(st.st_blocks, 0)

    def test_root_inode_is_one(self):
        self.assertEqual(os.stat(self.fx.mnt()).st_ino, 1)


class ZeroCacheTimeouts(SidecarTestCase):
    """entry/attr timeouts are 0: pin/unpin under the mount is seen immediately."""

    def setUpFixture(self):
        self.fx.add_placeholder('flip.txt', 1234, MTIME_MS)

    def test_materialize_is_visible_immediately(self):
        self.assertEqual(os.stat(self.fx.mnt('flip.txt')).st_size, 1234)
        self.fx.materialize('flip.txt', b'12345')
        self.assertEqual(os.stat(self.fx.mnt('flip.txt')).st_size, 5)

    def test_evict_is_visible_immediately(self):
        self.fx.materialize('flip.txt', b'12345')
        self.assertEqual(os.stat(self.fx.mnt('flip.txt')).st_blocks > 0, True)
        os.unlink(self.fx.tree_path('flip.txt'))
        self.fx.add_placeholder('flip.txt', 1234, MTIME_MS)
        st = os.stat(self.fx.mnt('flip.txt'))
        self.assertEqual((st.st_size, st.st_blocks), (1234, 0))

    def test_stat_never_misses_a_file_mid_hydrate_or_evict(self):
        # the engine's orders: hydrate puts the bytes in, then clears the marker;
        # evict sets the marker, then unlinks. Either way the file always exists
        # on one side or the other, so a stat must never see ENOENT.
        stop = threading.Event()
        misses = []

        def churn():
            while not stop.is_set():
                self.fx.materialize('flip.txt', b'12345')
                self.fx.add_placeholder('flip.txt', 1234, MTIME_MS)
                os.unlink(self.fx.tree_path('flip.txt'))

        def stat_loop():
            while not stop.is_set():
                try:
                    os.stat(self.fx.mnt('flip.txt'))
                except FileNotFoundError:
                    misses.append(1)
        threads = [threading.Thread(target=churn, daemon=True)] + \
            [threading.Thread(target=stat_loop, daemon=True) for _ in range(4)]
        for t in threads:
            t.start()
        time.sleep(4.0)
        stop.set()
        for t in threads:
            t.join(5)
        self.assertEqual(len(misses), 0)

    def test_tree_changes_outside_the_mount_are_visible(self):
        self.fx.write_tree('outside.txt', b'abc')
        self.assertEqual(os.stat(self.fx.mnt('outside.txt')).st_size, 3)


class InodeNumbers(SidecarTestCase):
    def setUpFixture(self):
        self.fx.add_placeholder('p.txt', 1, MTIME_MS)
        self.fx.write_tree('dir/real.txt', b'r')

    def test_inode_is_sha1_derived(self):
        self.assertEqual(os.stat(self.fx.mnt('p.txt')).st_ino, expected_ino('p.txt'))
        self.assertEqual(os.stat(self.fx.mnt('dir')).st_ino, expected_ino('dir'))
        self.assertEqual(os.stat(self.fx.mnt('dir/real.txt')).st_ino, expected_ino('dir/real.txt'))

    def test_inode_survives_a_sidecar_restart(self):
        before = os.stat(self.fx.mnt('dir/real.txt')).st_ino
        self.fx.stop()
        self.fx.start()
        self.assertEqual(os.stat(self.fx.mnt('dir/real.txt')).st_ino, before)

    def test_inode_is_stable_across_lookups(self):
        a = os.stat(self.fx.mnt('p.txt')).st_ino
        os.listdir(self.fx.mnt())
        self.assertEqual(os.stat(self.fx.mnt('p.txt')).st_ino, a)


class Listing(SidecarTestCase):
    def setUpFixture(self):
        fx = self.fx
        for name in ('b.txt', 'A.txt', 'zdir/inner.txt'):
            fx.write_tree(name, b'1')
        os.makedirs(fx.tree_path('.Trash-1000/files'))
        os.makedirs(fx.tree_path('.Trash'))
        fx.write_tree('.hidden', b'h')
        for name in ('c.txt', 'a.txt', 'zdir/remote.txt'):
            fx.add_placeholder(name, 7, MTIME_MS)
        fx.add_placeholder('b.txt', 7, MTIME_MS)  # shadowed by the tree file

    def test_order_is_tree_sorted_then_placeholders_sorted(self):
        self.assertEqual(os.listdir(self.fx.mnt()),
                         ['.hidden', 'A.txt', 'b.txt', 'zdir', 'a.txt', 'c.txt'])

    def test_subdirectory_merges_its_own_placeholders_only(self):
        self.assertEqual(os.listdir(self.fx.mnt('zdir')), ['inner.txt', 'remote.txt'])

    def test_trash_dirs_are_hidden_but_reachable(self):
        names = os.listdir(self.fx.mnt())
        self.assertNotIn('.Trash', names)
        self.assertNotIn('.Trash-1000', names)
        self.assertTrue(stat.S_ISDIR(os.stat(self.fx.mnt('.Trash-1000')).st_mode))
        self.assertEqual(os.listdir(self.fx.mnt('.Trash-1000')), ['files'])

    def test_shadowed_placeholder_is_listed_once_with_tree_attrs(self):
        with os.scandir(self.fx.mnt()) as it:
            entries = {e.name: e for e in it}
        self.assertEqual(entries['b.txt'].stat().st_size, 1)

    def test_scandir_types(self):
        with os.scandir(self.fx.mnt()) as it:
            kinds = {e.name: (e.is_dir(), e.is_file()) for e in it}
        self.assertEqual(kinds['zdir'], (True, False))
        self.assertEqual(kinds['c.txt'], (False, True))

    def test_empty_directory(self):
        os.makedirs(self.fx.tree_path('empty'))
        self.assertEqual(os.listdir(self.fx.mnt('empty')), [])

    def test_listing_a_missing_directory_fails(self):
        self.assertErrno(errno.ENOENT, os.listdir, self.fx.mnt('ghost'))


class LargeListing(SidecarTestCase):
    """Big enough to need several readdir calls; offsets must not skip or repeat."""

    N = 400

    def setUpFixture(self):
        for i in range(self.N):
            self.fx.write_tree(f'big/t{i:04}.txt', b'')
            self.fx.add_placeholder(f'big/p{i:04}.txt', i, MTIME_MS)

    def test_every_entry_exactly_once(self):
        names = os.listdir(self.fx.mnt('big'))
        self.assertEqual(len(names), 2 * self.N)
        self.assertEqual(len(set(names)), 2 * self.N)
        self.assertEqual(names[:2], ['t0000.txt', 't0001.txt'])
        self.assertEqual(names[self.N], 'p0000.txt')


class OddNames(SidecarTestCase):
    def setUpFixture(self):
        self.fx.write_tree('spaced name (1).txt', b's')
        self.fx.write_tree('ünïcødé.txt', b'u')
        self.fx.add_placeholder('ремоут.txt', 3, MTIME_MS)

    def test_utf8_names_round_trip(self):
        names = os.listdir(self.fx.mnt())
        self.assertIn('spaced name (1).txt', names)
        self.assertIn('ünïcødé.txt', names)
        self.assertIn('ремоут.txt', names)
        self.assertEqual(os.stat(self.fx.mnt('ремоут.txt')).st_size, 3)

    # inode numbers hash the raw name bytes (the Python sidecar hashed str.encode(),
    # which raised on such a name and took the whole mount down)
    def test_non_utf8_tree_name_is_listed_and_readable(self):
        raw = os.fsencode(self.fx.tree) + b'/caf\xe9.txt'
        with open(raw, 'wb') as f:
            f.write(b'latin1')
        names = os.listdir(os.fsencode(self.fx.mnt()))
        self.assertIn(b'caf\xe9.txt', names)
        with open(os.fsencode(self.fx.mnt()) + b'/caf\xe9.txt', 'rb') as f:
            self.assertEqual(f.read(), b'latin1')


class Statfs(SidecarTestCase):
    def test_statfs_mirrors_the_tree_filesystem(self):
        m, t = os.statvfs(self.fx.mnt()), os.statvfs(self.fx.tree)
        self.assertEqual((m.f_bsize, m.f_frsize, m.f_blocks, m.f_files, m.f_namemax),
                         (t.f_bsize, t.f_frsize, t.f_blocks, t.f_files, t.f_namemax))


if __name__ == '__main__':
    unittest.main()
