"""Characterization: operations that reach the engine (hydrate, trash, mv) and
their errno mapping, plus plain passthrough mutations."""

import ctypes
import errno
import hashlib
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from harness import SidecarTestCase, wait_for

MTIME_MS = 1_700_000_000_000
OFFLINE = {'ok': False, 'code': 'offline', 'error': 'offline: needs internet', 'offline': True}
AUTH = {'ok': False, 'code': 'auth', 'error': '401 Unauthorized'}
UNAVAILABLE = {'ok': False, 'code': 'unavailable', 'error': 'engine is still connecting'}
TIMEOUT = {'ok': False, 'code': 'timeout', 'error': 'download stalled'}
FAIL = {'ok': False, 'error': 'missing baseline facts'}


RENAME_NOREPLACE = 1
_libc = ctypes.CDLL(None, use_errno=True)


def rename_noreplace(src, dst):
    """renameat2(RENAME_NOREPLACE), as `mv -n` and glib's no-clobber moves use."""
    if _libc.renameat2(-100, os.fsencode(src), -100, os.fsencode(dst), RENAME_NOREPLACE) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), src)


def strip_t(reqs):
    return [{k: v for k, v in r.items() if k != 't'} for r in reqs]


class Hydrate(SidecarTestCase):
    def setUpFixture(self):
        self.fx.add_placeholder('dir/doc.txt', 11, MTIME_MS)
        os.makedirs(self.fx.tree_path('dir'))
        self.fx.write_tree('local.txt', b'local')

    def hydrate_with(self, data):
        def handler(req):
            if req['op'] == 'hydrate':
                self.fx.materialize(req['paths'][0], data)
            return {'ok': True, 'results': []}
        self.fx.engine.handler = handler

    def test_open_hydrates_then_serves_the_real_file(self):
        self.hydrate_with(b'hello world')
        with open(self.fx.mnt('dir/doc.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'hello world')
        self.assertEqual(strip_t(self.fx.engine.ops()), [{'op': 'hydrate', 'paths': ['dir/doc.txt']}])
        st = os.stat(self.fx.mnt('dir/doc.txt'))
        self.assertGreater(st.st_blocks, 0)

    def test_open_for_write_hydrates_first(self):
        self.hydrate_with(b'hello world')
        with open(self.fx.mnt('dir/doc.txt'), 'r+b') as f:
            f.seek(0, 2)
            f.write(b'!')
        with open(self.fx.tree_path('dir/doc.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'hello world!')

    def test_open_of_materialized_file_never_calls_the_engine(self):
        with open(self.fx.mnt('local.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'local')
        self.assertEqual(self.fx.engine.ops(), [])

    def test_hydrate_ok_but_nothing_on_disk_is_eio(self):
        self.fx.engine.handler = lambda req: {'ok': True, 'results': []}
        self.assertErrno(errno.EIO, open, self.fx.mnt('dir/doc.txt'), 'rb')

    def test_offline_is_enetdown(self):
        self.fx.engine.handler = lambda req: dict(OFFLINE)
        self.assertErrno(errno.ENETDOWN, open, self.fx.mnt('dir/doc.txt'), 'rb')

    def test_auth_is_eacces(self):
        self.fx.engine.handler = lambda req: dict(AUTH)
        self.assertErrno(errno.EACCES, open, self.fx.mnt('dir/doc.txt'), 'rb')

    def test_plain_engine_error_is_eio(self):
        self.fx.engine.handler = lambda req: dict(FAIL)
        self.assertErrno(errno.EIO, open, self.fx.mnt('dir/doc.txt'), 'rb')

    def test_marker_cleared_without_bytes_is_enoent(self):
        # neither on disk nor a placeholder any more (engine state moved on)
        self.fx.drop_rows('dir/doc.txt')
        self.assertErrno(errno.ENOENT, open, self.fx.mnt('dir/doc.txt'), 'rb')

    def test_hydrate_does_not_block_other_operations(self):
        release = threading.Event()

        def handler(req):
            release.wait(10)
            self.fx.materialize(req['paths'][0], b'late')
            return {'ok': True}
        self.fx.engine.handler = handler
        result = {}

        def reader():
            with open(self.fx.mnt('dir/doc.txt'), 'rb') as f:
                result['data'] = f.read()
        t = threading.Thread(target=reader)
        t.start()
        self.assertTrue(wait_for(lambda: self.fx.engine.ops('hydrate')))
        started = time.monotonic()
        self.assertEqual(os.stat(self.fx.mnt('local.txt')).st_size, 5)
        with open(self.fx.mnt('local.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'local')
        self.assertEqual(os.listdir(self.fx.mnt('dir')), ['doc.txt'])
        self.assertLess(time.monotonic() - started, 2.0)
        release.set()
        t.join(10)
        self.assertEqual(result.get('data'), b'late')

    def test_concurrent_opens_of_different_placeholders_hydrate_in_parallel(self):
        self.fx.add_placeholder('dir/two.txt', 3, MTIME_MS)
        barrier = threading.Barrier(2, timeout=5)

        def handler(req):
            barrier.wait()  # both hydrates must be in flight at once
            self.fx.materialize(req['paths'][0], b'ok')
            return {'ok': True}
        self.fx.engine.handler = handler
        errors = []

        def reader(rel):
            try:
                with open(self.fx.mnt(rel), 'rb') as f:
                    f.read()
            except OSError as e:
                errors.append(e)
        ts = [threading.Thread(target=reader, args=(r,)) for r in ('dir/doc.txt', 'dir/two.txt')]
        for t in ts:
            t.start()
        for t in ts:
            t.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(self.fx.engine.max_inflight, 2)


class EngineUnreachable(SidecarTestCase):
    ENV = {'PHNX_DRIVE_SYNC_RPC_CONNECT_TIMEOUT_S': '1', 'PHNX_DRIVE_SYNC_RPC_RESPONSE_TIMEOUT_S': '1'}

    def setUpFixture(self):
        self.fx.add_placeholder('doc.txt', 11, MTIME_MS)

    def test_missing_socket_is_enotconn_within_the_connect_budget(self):
        self.fx.engine.stop()
        started = time.monotonic()
        self.assertErrno(errno.ENOTCONN, open, self.fx.mnt('doc.txt'), 'rb')
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.9)
        self.assertLess(elapsed, 4.0)

    def test_silent_engine_is_enotconn_after_the_response_timeout(self):
        self.fx.engine.handler = lambda req: None
        started = time.monotonic()
        self.assertErrno(errno.ENOTCONN, open, self.fx.mnt('doc.txt'), 'rb')
        self.assertLess(time.monotonic() - started, 4.0)

    def test_engine_hanging_up_is_enotconn(self):
        def handler(req):
            raise OSError('drop the connection without a reply')
        self.fx.engine.handler = handler
        self.assertErrno(errno.ENOTCONN, open, self.fx.mnt('doc.txt'), 'rb')


class EngineNotReady(SidecarTestCase):
    def setUpFixture(self):
        self.fx.add_placeholder('doc.txt', 11, MTIME_MS)

    def test_unavailable_is_enotconn(self):
        self.fx.engine.handler = lambda req: UNAVAILABLE
        started = time.monotonic()
        self.assertErrno(errno.ENOTCONN, open, self.fx.mnt('doc.txt'), 'rb')
        self.assertLess(time.monotonic() - started, 2.0)

    def test_timeout_is_etimedout(self):
        self.fx.engine.handler = lambda req: TIMEOUT
        started = time.monotonic()
        self.assertErrno(errno.ETIMEDOUT, open, self.fx.mnt('doc.txt'), 'rb')
        self.assertLess(time.monotonic() - started, 2.0)


class LegacyTimeoutEnv(SidecarTestCase):
    ENV = {'DRIVE_SYNC_RPC_CONNECT_TIMEOUT_S': '1'}

    def setUpFixture(self):
        self.fx.add_placeholder('doc.txt', 11, MTIME_MS)

    def test_legacy_connect_timeout_name_is_honoured(self):
        self.fx.engine.stop()
        started = time.monotonic()
        self.assertErrno(errno.ENOTCONN, open, self.fx.mnt('doc.txt'), 'rb')
        self.assertLess(time.monotonic() - started, 4.0)


class SetattrHydrates(SidecarTestCase):
    def setUpFixture(self):
        self.fx.add_placeholder('doc.txt', 11, MTIME_MS)
        self.fx.write_tree('real.txt', b'0123456789')

        def handler(req):
            if req['op'] == 'hydrate':
                self.fx.materialize(req['paths'][0], b'hello world')
            return {'ok': True}
        self.fx.engine.handler = handler

    def test_truncate_placeholder_hydrates_then_truncates(self):
        os.truncate(self.fx.mnt('doc.txt'), 5)
        self.assertEqual(strip_t(self.fx.engine.ops()), [{'op': 'hydrate', 'paths': ['doc.txt']}])
        with open(self.fx.tree_path('doc.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'hello')

    def test_chmod_placeholder_hydrates(self):
        os.chmod(self.fx.mnt('doc.txt'), 0o600)
        self.assertEqual(len(self.fx.engine.ops('hydrate')), 1)
        self.assertEqual(os.stat(self.fx.tree_path('doc.txt')).st_mode & 0o777, 0o600)

    def test_setattr_placeholder_offline_is_enetdown(self):
        self.fx.engine.handler = lambda req: dict(OFFLINE)
        self.assertErrno(errno.ENETDOWN, os.truncate, self.fx.mnt('doc.txt'), 0)

    def test_materialized_chmod_truncate_utime_pass_through(self):
        p = self.fx.mnt('real.txt')
        os.chmod(p, 0o640)
        os.truncate(p, 4)
        os.utime(p, ns=(1_600_000_000_000_000_000, 1_650_000_000_000_000_000))
        st = os.stat(self.fx.tree_path('real.txt'))
        self.assertEqual(st.st_mode & 0o777, 0o640)
        self.assertEqual(st.st_size, 4)
        self.assertEqual(st.st_atime_ns, 1_600_000_000_000_000_000)
        self.assertEqual(st.st_mtime_ns, 1_650_000_000_000_000_000)
        self.assertEqual(self.fx.engine.ops(), [])

    def test_utime_only_mtime_keeps_atime(self):
        p = self.fx.mnt('real.txt')
        os.utime(self.fx.tree_path('real.txt'), ns=(1_500_000_000_000_000_000, 1_500_000_000_000_000_000))
        fd = os.open(p, os.O_RDONLY)
        try:
            os.utime(fd, ns=(1_500_000_000_000_000_000, 1_700_000_000_000_000_000))
        finally:
            os.close(fd)
        st = os.stat(self.fx.tree_path('real.txt'))
        self.assertEqual(st.st_mtime_ns, 1_700_000_000_000_000_000)


class Unlink(SidecarTestCase):
    def setUpFixture(self):
        self.fx.add_placeholder('remote.txt', 11, MTIME_MS)
        self.fx.write_tree('local.txt', b'l')

    def test_materialized_unlink_is_local_only(self):
        os.unlink(self.fx.mnt('local.txt'))
        self.assertFalse(os.path.exists(self.fx.tree_path('local.txt')))
        self.assertEqual(self.fx.engine.ops(), [])

    def test_placeholder_unlink_is_a_trash_rpc(self):
        def handler(req):
            self.fx.drop_rows(req['paths'][0])
            return {'ok': True}
        self.fx.engine.handler = handler
        os.unlink(self.fx.mnt('remote.txt'))
        self.assertEqual(strip_t(self.fx.engine.ops()), [{'op': 'trash', 'paths': ['remote.txt']}])
        self.assertErrno(errno.ENOENT, os.stat, self.fx.mnt('remote.txt'))

    def test_placeholder_unlink_offline_is_enetdown_and_keeps_it(self):
        self.fx.engine.handler = lambda req: dict(OFFLINE)
        self.assertErrno(errno.ENETDOWN, os.unlink, self.fx.mnt('remote.txt'))
        self.assertEqual(os.stat(self.fx.mnt('remote.txt')).st_size, 11)

    def test_placeholder_unlink_auth_is_eacces(self):
        self.fx.engine.handler = lambda req: dict(AUTH)
        self.assertErrno(errno.EACCES, os.unlink, self.fx.mnt('remote.txt'))

    def test_unlink_missing_is_enoent(self):
        self.assertErrno(errno.ENOENT, os.unlink, self.fx.mnt('nope.txt'))
        self.assertEqual(self.fx.engine.ops(), [])


class Rename(SidecarTestCase):
    def setUpFixture(self):
        self.fx.add_placeholder('remote.txt', 11, MTIME_MS)
        self.fx.write_tree('local.txt', b'l')
        os.makedirs(self.fx.tree_path('dest'))
        os.makedirs(self.fx.tree_path('.Trash-1000/files'))
        os.makedirs(self.fx.tree_path('.Trash'))

    def engine_moves(self):
        def handler(req):
            if req['op'] == 'mv':
                self.fx.move_rows(*req['paths'])
            elif req['op'] == 'trash':
                self.fx.drop_rows(req['paths'][0])
            return {'ok': True}
        self.fx.engine.handler = handler

    def test_materialized_rename_is_local_and_keeps_the_inode(self):
        ino = os.stat(self.fx.mnt('local.txt')).st_ino
        os.rename(self.fx.mnt('local.txt'), self.fx.mnt('dest/moved.txt'))
        self.assertTrue(os.path.exists(self.fx.tree_path('dest/moved.txt')))
        self.assertEqual(os.stat(self.fx.mnt('dest/moved.txt')).st_ino, ino)
        self.assertEqual(self.fx.engine.ops(), [])

    def test_placeholder_rename_is_an_mv_rpc_and_keeps_the_inode(self):
        self.engine_moves()
        ino = os.stat(self.fx.mnt('remote.txt')).st_ino
        os.rename(self.fx.mnt('remote.txt'), self.fx.mnt('dest/renamed.txt'))
        self.assertEqual(strip_t(self.fx.engine.ops()), [{'op': 'mv', 'paths': ['remote.txt', 'dest/renamed.txt']}])
        st = os.stat(self.fx.mnt('dest/renamed.txt'))
        self.assertEqual((st.st_ino, st.st_size, st.st_blocks), (ino, 11, 0))
        self.assertFalse(os.path.exists(self.fx.tree_path('dest/renamed.txt')))

    def test_placeholder_rename_into_trash_uid_dir_is_a_trash_rpc(self):
        self.engine_moves()
        os.rename(self.fx.mnt('remote.txt'), self.fx.mnt('.Trash-1000/files/remote.txt'))
        self.assertEqual(strip_t(self.fx.engine.ops()), [{'op': 'trash', 'paths': ['remote.txt']}])
        self.assertErrno(errno.ENOENT, os.stat, self.fx.mnt('remote.txt'))

    def test_placeholder_rename_into_dot_trash_is_a_trash_rpc(self):
        self.engine_moves()
        os.rename(self.fx.mnt('remote.txt'), self.fx.mnt('.Trash/remote.txt'))
        self.assertEqual(strip_t(self.fx.engine.ops()), [{'op': 'trash', 'paths': ['remote.txt']}])

    def test_trash_named_lookalike_is_a_plain_mv(self):
        # `.Trash-abc` is not a trash dir (suffix must be digits)
        os.makedirs(self.fx.tree_path('.Trash-abc'))
        self.engine_moves()
        os.rename(self.fx.mnt('remote.txt'), self.fx.mnt('.Trash-abc/remote.txt'))
        self.assertEqual(self.fx.engine.ops()[0]['op'], 'mv')

    def test_placeholder_rename_offline_is_enetdown_without_local_fallback(self):
        self.fx.engine.handler = lambda req: dict(OFFLINE)
        self.assertErrno(errno.ENETDOWN, os.rename, self.fx.mnt('remote.txt'), self.fx.mnt('x.txt'))
        self.assertEqual(os.stat(self.fx.mnt('remote.txt')).st_size, 11)
        self.assertFalse(os.path.exists(self.fx.tree_path('x.txt')))

    def test_placeholder_rename_auth_is_eacces(self):
        self.fx.engine.handler = lambda req: dict(AUTH)
        self.assertErrno(errno.EACCES, os.rename, self.fx.mnt('remote.txt'), self.fx.mnt('x.txt'))

    def test_placeholder_trash_offline_is_enetdown(self):
        self.fx.engine.handler = lambda req: dict(OFFLINE)
        self.assertErrno(errno.ENETDOWN, os.rename, self.fx.mnt('remote.txt'),
                         self.fx.mnt('.Trash-1000/files/remote.txt'))

    def test_mv_error_after_a_racing_materialize_falls_back_to_local_rename(self):
        def handler(req):
            self.fx.materialize('remote.txt', b'raced')  # pinned meanwhile
            return dict(FAIL, error='not a placeholder')
        self.fx.engine.handler = handler
        os.rename(self.fx.mnt('remote.txt'), self.fx.mnt('dest/r.txt'))
        with open(self.fx.tree_path('dest/r.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'raced')

    def test_mv_error_without_a_local_file_is_eio(self):
        self.fx.engine.handler = lambda req: dict(FAIL)
        self.assertErrno(errno.EIO, os.rename, self.fx.mnt('remote.txt'), self.fx.mnt('x.txt'))

    # the VFS refuses NOREPLACE onto a name lookup() reports, before rename() runs
    def test_noreplace_onto_an_existing_file_is_eexist(self):
        self.fx.write_tree('dest/taken.txt', b'keep me')
        self.assertErrno(errno.EEXIST, rename_noreplace, self.fx.mnt('local.txt'), self.fx.mnt('dest/taken.txt'))
        with open(self.fx.tree_path('dest/taken.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'keep me')

    def test_noreplace_placeholder_onto_an_existing_file_is_eexist(self):
        self.fx.write_tree('dest/taken.txt', b'keep me')
        self.assertErrno(errno.EEXIST, rename_noreplace, self.fx.mnt('remote.txt'), self.fx.mnt('dest/taken.txt'))
        self.assertEqual(self.fx.engine.ops(), [])

    def test_noreplace_onto_a_free_name_renames(self):
        self.engine_moves()
        rename_noreplace(self.fx.mnt('local.txt'), self.fx.mnt('dest/free.txt'))
        rename_noreplace(self.fx.mnt('remote.txt'), self.fx.mnt('dest/free2.txt'))
        self.assertTrue(os.path.exists(self.fx.tree_path('dest/free.txt')))
        self.assertEqual(strip_t(self.fx.engine.ops()), [{'op': 'mv', 'paths': ['remote.txt', 'dest/free2.txt']}])

    def test_rename_missing_is_enoent(self):
        self.assertErrno(errno.ENOENT, os.rename, self.fx.mnt('nope.txt'), self.fx.mnt('x.txt'))


class Passthrough(SidecarTestCase):
    def test_create_write_read_round_trip(self):
        data = os.urandom(5 * 1024 * 1024 + 123)
        with open(self.fx.mnt('new.bin'), 'wb') as f:
            f.write(data)
        with open(self.fx.mnt('new.bin'), 'rb') as f:
            self.assertEqual(hashlib.sha256(f.read()).digest(), hashlib.sha256(data).digest())
        with open(self.fx.tree_path('new.bin'), 'rb') as f:
            self.assertEqual(f.read(), data)
        self.assertEqual(self.fx.engine.ops(), [])

    def test_create_honours_mode(self):
        fd = os.open(self.fx.mnt('m.txt'), os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        self.assertEqual(os.stat(self.fx.tree_path('m.txt')).st_mode & 0o777, 0o600 & ~self.umask())

    def test_exclusive_create_of_existing_is_eexist(self):
        self.fx.write_tree('e.txt', b'')
        self.assertErrno(errno.EEXIST, os.open, self.fx.mnt('e.txt'), os.O_CREAT | os.O_EXCL | os.O_WRONLY)

    def test_positional_io(self):
        self.fx.write_tree('p.txt', b'0123456789')
        fd = os.open(self.fx.mnt('p.txt'), os.O_RDWR)
        try:
            self.assertEqual(os.pread(fd, 3, 4), b'456')
            os.pwrite(fd, b'XY', 8)
            os.fsync(fd)
            os.fdatasync(fd)
        finally:
            os.close(fd)
        with open(self.fx.tree_path('p.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'01234567XY')

    def test_append(self):
        self.fx.write_tree('a.txt', b'one')
        with open(self.fx.mnt('a.txt'), 'ab') as f:
            f.write(b'two')
        with open(self.fx.tree_path('a.txt'), 'rb') as f:
            self.assertEqual(f.read(), b'onetwo')

    def test_mkdir_rmdir(self):
        os.mkdir(self.fx.mnt('d'), 0o750)
        self.assertTrue(os.path.isdir(self.fx.tree_path('d')))
        self.fx.write_tree('d/f', b'')
        self.assertErrno(errno.ENOTEMPTY, os.rmdir, self.fx.mnt('d'))
        os.unlink(self.fx.mnt('d/f'))
        os.rmdir(self.fx.mnt('d'))
        self.assertFalse(os.path.exists(self.fx.tree_path('d')))

    def test_mkdir_existing_is_eexist(self):
        os.makedirs(self.fx.tree_path('d'))
        self.assertErrno(errno.EEXIST, os.mkdir, self.fx.mnt('d'))

    def test_readlink_of_tree_symlink(self):
        os.symlink('target/elsewhere', self.fx.tree_path('link'))
        self.assertEqual(os.readlink(self.fx.mnt('link')), 'target/elsewhere')
        self.assertTrue(os.path.islink(self.fx.mnt('link')))

    def test_symlink_and_hardlink_creation_are_unsupported(self):
        self.fx.write_tree('src.txt', b's')
        with self.assertRaises(OSError) as cm:
            os.symlink('src.txt', self.fx.mnt('ln'))
        self.assertIn(cm.exception.errno, (errno.ENOSYS, errno.EPERM, errno.EOPNOTSUPP))
        with self.assertRaises(OSError) as cm:
            os.link(self.fx.mnt('src.txt'), self.fx.mnt('hard'))
        self.assertIn(cm.exception.errno, (errno.ENOSYS, errno.EPERM, errno.EOPNOTSUPP))

    @staticmethod
    def umask():
        m = os.umask(0)
        os.umask(m)
        return m


if __name__ == '__main__':
    unittest.main()
