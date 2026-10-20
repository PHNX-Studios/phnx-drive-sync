"""Characterization: recall-on-hover/prefetch, heartbeat, signals, mount options."""

import os
import signal
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from harness import SidecarTestCase, is_mount_point, wait_for

MTIME_MS = 1_700_000_000_000
OFFLINE = {'ok': False, 'code': 'offline', 'error': 'offline: needs internet', 'offline': True}


class PrefetchBase(SidecarTestCase):
    def setUpFixture(self):
        for i in range(5):
            self.fx.add_placeholder(f'p{i}.txt', 5, MTIME_MS)
        self.release = threading.Event()
        self.release.set()

        def handler(req):
            self.release.wait(10)
            if req['op'] == 'hydrate':
                self.fx.materialize(req['paths'][0], b'fetch')
            return {'ok': True}
        self.fx.engine.handler = handler

    def settle(self, seconds=0.5):
        time.sleep(seconds)
        return self.fx.engine.ops()


class PrefetchOffByDefault(PrefetchBase):
    def test_stat_does_not_hydrate(self):
        os.stat(self.fx.mnt('p0.txt'))
        self.assertEqual(self.settle(), [])


class PrefetchMetaOn(PrefetchBase):
    def setUpFixture(self):
        super().setUpFixture()
        self.fx.set_meta('prefetch', 'on')

    def test_lookup_queues_a_background_hydrate(self):
        st = os.stat(self.fx.mnt('p0.txt'))  # returns at once with placeholder attrs
        self.assertEqual(st.st_blocks, 0)
        self.assertTrue(wait_for(lambda: os.path.exists(self.fx.tree_path('p0.txt'))))
        self.assertEqual([r['paths'] for r in self.fx.engine.ops('hydrate')], [['p0.txt']])

    def test_listing_alone_does_not_prefetch(self):
        os.listdir(self.fx.mnt())
        self.assertEqual(self.settle(), [])

    def test_materialized_lookup_does_not_prefetch(self):
        self.fx.write_tree('real.txt', b'r')
        os.stat(self.fx.mnt('real.txt'))
        self.assertEqual(self.settle(), [])

    def test_at_most_two_in_flight_and_no_duplicates(self):
        self.release.clear()
        for _ in range(3):
            for i in range(5):
                os.stat(self.fx.mnt(f'p{i}.txt'))
        self.assertTrue(wait_for(lambda: self.fx.engine.inflight == 2))
        time.sleep(0.3)
        self.assertEqual(self.fx.engine.max_inflight, 2)
        self.release.set()
        self.assertTrue(wait_for(lambda: all(os.path.exists(self.fx.tree_path(f'p{i}.txt')) for i in range(5))))
        paths = sorted(r['paths'][0] for r in self.fx.engine.ops('hydrate'))
        self.assertEqual(paths, [f'p{i}.txt' for i in range(5)])

    def test_meta_toggle_is_read_live(self):
        self.fx.set_meta('prefetch', 'off')
        os.stat(self.fx.mnt('p0.txt'))
        self.assertEqual(self.settle(), [])
        self.fx.set_meta('prefetch', 'on')
        os.stat(self.fx.mnt('p1.txt'))
        self.assertTrue(wait_for(lambda: self.fx.engine.ops('hydrate')))

    def test_offline_reply_stops_further_prefetch(self):
        self.fx.engine.handler = lambda req: dict(OFFLINE)
        os.stat(self.fx.mnt('p0.txt'))
        self.assertTrue(wait_for(lambda: len(self.fx.engine.ops()) == 1))
        for i in range(1, 5):
            os.stat(self.fx.mnt(f'p{i}.txt'))
        self.assertEqual(len(self.settle()), 1)

    def test_back_online_reply_resumes_prefetch(self):
        self.fx.engine.offline = True
        self.fx.engine.handler = lambda req: dict(OFFLINE)
        os.stat(self.fx.mnt('p0.txt'))
        self.assertTrue(wait_for(lambda: len(self.fx.engine.ops()) == 1))
        # any later reply stamped online clears the gate; an open is such an RPC
        self.fx.engine.offline = False

        def handler(req):
            self.fx.materialize(req['paths'][0], b'fetch')
            return {'ok': True}
        self.fx.engine.handler = handler
        with open(self.fx.mnt('p1.txt'), 'rb') as f:
            f.read()
        os.stat(self.fx.mnt('p2.txt'))
        self.assertTrue(wait_for(lambda: os.path.exists(self.fx.tree_path('p2.txt'))))


class PrefetchEnvOn(PrefetchBase):
    ENV = {'PHNX_DRIVE_SYNC_PREFETCH': 'yes'}

    def test_env_enables_prefetch(self):
        os.stat(self.fx.mnt('p0.txt'))
        self.assertTrue(wait_for(lambda: self.fx.engine.ops('hydrate')))

    def test_meta_off_overrides_env(self):
        self.fx.set_meta('prefetch', 'off')
        os.stat(self.fx.mnt('p0.txt'))
        self.assertEqual(self.settle(), [])


class PrefetchLegacyEnv(PrefetchBase):
    ENV = {'DRIVE_SYNC_PREFETCH': '1'}

    def test_legacy_env_name_enables_prefetch(self):
        os.stat(self.fx.mnt('p0.txt'))
        self.assertTrue(wait_for(lambda: self.fx.engine.ops('hydrate')))


class PrefetchEnvFalsy(PrefetchBase):
    ENV = {'PHNX_DRIVE_SYNC_PREFETCH': 'off'}

    def test_falsy_env_keeps_prefetch_off(self):
        os.stat(self.fx.mnt('p0.txt'))
        self.assertEqual(self.settle(), [])


class Heartbeat(SidecarTestCase):
    def test_mount_ok_holds_the_pid_and_is_refreshed(self):
        with open(self.fx.mount_ok) as f:
            self.assertEqual(f.read().strip(), str(self.fx.proc.pid))
        first = os.stat(self.fx.mount_ok).st_mtime_ns
        self.assertTrue(wait_for(lambda: os.stat(self.fx.mount_ok).st_mtime_ns > first, timeout=4.0))

    def test_mount_options(self):
        with open('/proc/self/mounts') as f:
            line = next(ln for ln in f if ln.split()[1] == self.fx.mount.replace(' ', '\\040'))
        source, _, fstype, opts = line.split()[:4]
        self.assertEqual(source, 'phnx-drive-sync')
        self.assertTrue(fstype == 'fuse' or fstype.startswith('fuse.'), fstype)
        self.assertIn('default_permissions', opts.split(','))
        self.assertIn('rw', opts.split(','))


class Signals(SidecarTestCase):
    def assert_clean_exit(self, rc):
        self.assertEqual(self.fx.proc.wait(10), rc)
        self.assertFalse(os.path.exists(self.fx.mount_ok))
        self.assertTrue(wait_for(lambda: not is_mount_point(self.fx.mount)))

    def test_sigterm_unmounts_and_exits_143(self):
        self.fx.proc.send_signal(signal.SIGTERM)
        self.assert_clean_exit(143)

    def test_sigint_unmounts_and_exits_130(self):
        self.fx.proc.send_signal(signal.SIGINT)
        self.assert_clean_exit(130)

    def test_sigterm_during_a_blocked_hydrate_still_exits(self):
        self.fx.add_placeholder('slow.txt', 5, MTIME_MS)
        self.fx.engine.handler = lambda req: None  # never answers
        t = threading.Thread(target=self._try_open, args=('slow.txt',), daemon=True)
        t.start()
        self.assertTrue(wait_for(lambda: self.fx.engine.ops('hydrate')))
        self.fx.proc.send_signal(signal.SIGTERM)
        self.assertIsNotNone(self._wait_exit(10))
        self.assertTrue(wait_for(lambda: not is_mount_point(self.fx.mount)))
        t.join(5)

    def test_external_unmount_ends_the_process(self):
        subprocess.run(['fusermount3', '-u', self.fx.mount], check=True)
        self.assertIsNotNone(self._wait_exit(10))
        self.assertTrue(wait_for(lambda: not os.path.exists(self.fx.mount_ok)))

    def _try_open(self, rel):
        try:
            with open(self.fx.mnt(rel), 'rb') as f:
                f.read()
        except OSError:
            pass

    def _wait_exit(self, timeout):
        try:
            return self.fx.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            return None


class StartupFailures(SidecarTestCase):
    AUTOSTART = False

    def test_mountpoint_is_created_if_missing(self):
        self.assertFalse(os.path.exists(self.fx.mount))
        self.fx.start()
        self.assertTrue(is_mount_point(self.fx.mount))

    def test_missing_required_flag_fails_fast(self):
        from harness import sidecar_cmd, sidecar_env
        rc = subprocess.run(sidecar_cmd() + ['--mount', self.fx.mount], env=sidecar_env(),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode
        self.assertNotEqual(rc, 0)
        self.assertFalse(is_mount_point(self.fx.mount))


if __name__ == '__main__':
    unittest.main()
