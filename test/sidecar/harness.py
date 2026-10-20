"""Black-box harness for the FUSE sidecar characterization suite.

Mounts a real sidecar on a private temp directory, backed by a fixture tree, a
fixture state.db (same schema as src/state.ts) and a scripted fake engine on the
RPC socket. Nothing here touches the user's real mount or state.

The implementation under test is chosen by ``PHNX_SIDECAR_CMD`` (a shell-quoted
command line; the harness appends the standard ``--mount/--tree/--db/--rpc/
--mount-ok`` flags). Unset, it runs ``python3 python/sidecar.py``, so the same
suite characterizes the Python sidecar today and gates the Rust port later.

For the Python sidecar, pyfuse3/trio are found on ``PHNX_SIDECAR_PYTHONPATH``
when set, else on the installed app's lib dir (``~/.local/share/phnx-drive-sync/
python``), else on the system path.
"""

import json
import os
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PY_SIDECAR = os.path.join(ROOT, 'python', 'sidecar.py')

# mirrors openState() in src/state.ts
SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS sync (
    path  TEXT PRIMARY KEY,
    uid   TEXT,
    type  TEXT NOT NULL,
    lsize INTEGER,
    lmtime INTEGER,
    rsize INTEGER,
    rmtime INTEGER
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS online (
    path   TEXT PRIMARY KEY,
    pinned INTEGER NOT NULL DEFAULT 0
);
"""


def sidecar_cmd():
    raw = os.environ.get('PHNX_SIDECAR_CMD')
    if raw:
        return shlex.split(raw)
    return [sys.executable, PY_SIDECAR]


def _python_path():
    explicit = os.environ.get('PHNX_SIDECAR_PYTHONPATH')
    if explicit:
        return explicit
    for base in (os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'),):
        for name in ('phnx-drive-sync', 'drive-sync'):
            p = os.path.join(base, name, 'python')
            if os.path.isdir(p):
                return p
    return ''


def sidecar_env(extra=None):
    env = dict(os.environ)
    # never inherit a developer's tuning into a characterization run
    for k in list(env):
        if k.startswith(('PHNX_DRIVE_SYNC_', 'DRIVE_SYNC_')):
            del env[k]
    if 'PHNX_SIDECAR_CMD' not in os.environ:
        pp = _python_path()
        if pp:
            env['PYTHONPATH'] = pp + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
    env.update(extra or {})
    return env


def is_python_sidecar():
    return 'PHNX_SIDECAR_CMD' not in os.environ


def python_sidecar_bug(why):
    """Known defect of the Python sidecar the replacement must not inherit.

    Expected to fail against the Python sidecar (so the suite stays green and the
    defect stays documented); a normal, required test for any other implementation.
    """
    def wrap(fn):
        fn.__doc__ = f'Python sidecar bug: {why}'
        return unittest.expectedFailure(fn) if is_python_sidecar() else fn
    return wrap


def python_sidecar_flaky(why):
    """Intermittent defect of the Python sidecar: skipped for it (an expected
    failure would turn its lucky passes into errors), required for any other."""
    def wrap(fn):
        fn.__doc__ = f'Python sidecar flaky bug: {why}'
        return unittest.skip(f'Python sidecar flaky bug: {why}')(fn) if is_python_sidecar() else fn
    return wrap


def _confined_label():
    """AppArmor label of this process when it is confined, else None."""
    try:
        with open('/proc/self/attr/current') as f:
            label = f.read().strip().rstrip('\x00')
    except OSError:
        return None
    return None if label in ('', 'unconfined') else label


def fuse_unavailable_reason():
    """Why mount tests cannot run here, or None."""
    if not os.path.exists('/dev/fuse'):
        return '/dev/fuse is missing'
    if not shutil.which('fusermount3'):
        return 'fusermount3 is not installed'
    label = _confined_label()
    if label and label.startswith('snap.'):
        # fusermount3's profile cannot inherit a socket created under a snap label
        return (f'running confined ({label}); fusermount3 cannot mount from here - '
                'use test/sidecar/run.sh')
    if 'PHNX_SIDECAR_CMD' not in os.environ:
        probe = subprocess.run([sys.executable, '-c', 'import pyfuse3, trio'], env=sidecar_env(),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode != 0:
            return 'pyfuse3/trio are not importable for the Python sidecar'
    return None


def is_mount_point(p):
    try:
        return os.stat(p).st_dev != os.stat(os.path.dirname(p)).st_dev
    except OSError:
        return False


def wait_for(pred, timeout=5.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(interval)
    return pred()


# ---------------------------------------------------------------- fake engine

class FakeEngine:
    """Scripted RPC server: one JSON line in, one JSON line out, per connection.

    ``handler(req) -> dict | None`` decides the reply (None = never answer).
    Every request is recorded with its arrival time; ``offline`` is stamped on
    every reply like the real engine does unless the handler sets it.
    """

    def __init__(self, sock_path):
        self.sock_path = sock_path
        self.requests = []
        self.handler = lambda req: {'ok': True, 'results': []}
        self.offline = False
        self.inflight = 0
        self.max_inflight = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._conns = []
        self._srv = None
        self._thread = None

    def start(self):
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._srv.bind(self.sock_path)
        self._srv.listen(64)
        self._srv.settimeout(0.1)
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        for c in list(self._conns):
            try:
                c.close()
            except OSError:
                pass
        if self._thread:
            self._thread.join(2)
        if self._srv:
            self._srv.close()
        try:
            os.unlink(self.sock_path)
        except FileNotFoundError:
            pass

    def ops(self, op=None):
        with self._lock:
            return [r for r in self.requests if op is None or r['op'] == op]

    def _accept_loop(self):
        while not self._stop.is_set():
            try:
                conn, _ = self._srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self._conns.append(conn)
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        try:
            buf = b''
            while b'\n' not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            req = json.loads(buf.split(b'\n', 1)[0])
            with self._lock:
                self.requests.append(dict(req, t=time.monotonic()))
                self.inflight += 1
                self.max_inflight = max(self.max_inflight, self.inflight)
            try:
                resp = self.handler(req)
            finally:
                with self._lock:
                    self.inflight -= 1
            if resp is None:
                self._stop.wait()  # never answer
                return
            resp.setdefault('offline', self.offline)
            conn.sendall((json.dumps(resp) + '\n').encode())
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass


# ---------------------------------------------------------------- fixture

class SidecarFixture:
    def __init__(self, env=None, start_engine=True):
        self.dir = tempfile.mkdtemp(prefix='phnx-sidecar-char-')
        self.tree = os.path.join(self.dir, 'tree')
        self.mount = os.path.join(self.dir, 'mount')
        self.db_path = os.path.join(self.dir, 'state.db')
        self.rpc = os.path.join(self.dir, 'rpc.sock')
        self.mount_ok = os.path.join(self.dir, 'mount-ok')
        self.log_path = os.path.join(self.dir, 'sidecar.log')
        os.makedirs(self.tree)
        self.db = sqlite3.connect(self.db_path, check_same_thread=False, isolation_level=None)
        self.db.executescript(SCHEMA)
        self._db_lock = threading.Lock()
        self.engine = FakeEngine(self.rpc)
        if start_engine:
            self.engine.start()
        self.env = env or {}
        self.proc = None
        self._log = None

    # ---- state.db

    def add_placeholder(self, rel, size, mtime_ms, kind='file', marked=True):
        with self._db_lock:
            self.db.execute('INSERT OR REPLACE INTO sync (path, uid, type, lsize, lmtime, rsize, rmtime) '
                            'VALUES (?, ?, ?, ?, ?, ?, ?)', (rel, 'uid-' + rel, kind, size, mtime_ms, size, mtime_ms))
            if marked:
                self.db.execute('INSERT OR REPLACE INTO online (path) VALUES (?)', (rel,))

    def clear_marker(self, rel):
        with self._db_lock:
            self.db.execute('DELETE FROM online WHERE path = ?', (rel,))

    def move_rows(self, frm, to):
        with self._db_lock:
            self.db.execute('UPDATE sync SET path = ? WHERE path = ?', (to, frm))
            self.db.execute('UPDATE online SET path = ? WHERE path = ?', (to, frm))

    def drop_rows(self, rel):
        with self._db_lock:
            self.db.execute('DELETE FROM sync WHERE path = ?', (rel,))
            self.db.execute('DELETE FROM online WHERE path = ?', (rel,))

    def set_meta(self, key, value):
        with self._db_lock:
            self.db.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', (key, value))

    # ---- tree

    def tree_path(self, rel):
        return os.path.join(self.tree, rel)

    def mnt(self, rel=''):
        return os.path.join(self.mount, rel) if rel else self.mount

    def write_tree(self, rel, data=b''):
        p = self.tree_path(rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(data)
        return p

    def materialize(self, rel, data):
        """What the engine's hydrate does: bytes into the tree, marker cleared."""
        self.write_tree(rel, data)
        self.clear_marker(rel)

    # ---- lifecycle

    def start(self, timeout=15.0):
        if self._log:
            self._log.close()
        self._log = open(self.log_path, 'ab')
        self.proc = subprocess.Popen(
            sidecar_cmd() + ['--mount', self.mount, '--tree', self.tree, '--db', self.db_path,
                             '--rpc', self.rpc, '--mount-ok', self.mount_ok],
            env=sidecar_env(self.env), stdout=self._log, stderr=subprocess.STDOUT,
        )
        ok = wait_for(lambda: os.path.exists(self.mount_ok) and is_mount_point(self.mount)
                      or self.proc.poll() is not None, timeout)
        if not ok or self.proc.poll() is not None:
            raise RuntimeError(f'sidecar did not mount (rc={self.proc.poll()}):\n{self.log()}')

    def log(self):
        try:
            with open(self.log_path, 'rb') as f:
                return f.read().decode(errors='replace')
        except OSError:
            return ''

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        if is_mount_point(self.mount):
            subprocess.run(['fusermount3', '-u', '-z', self.mount],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def close(self):
        try:
            self.stop()
        finally:
            self.engine.stop()
            self.db.close()
            if self._log:
                self._log.close()
            if not is_mount_point(self.mount):
                shutil.rmtree(self.dir, ignore_errors=True)


class SidecarTestCase(unittest.TestCase):
    """One fresh mount per test. Subclasses tune ``ENV`` and ``setUpFixture``."""

    ENV: dict = {}
    AUTOSTART = True

    @classmethod
    def setUpClass(cls):
        reason = fuse_unavailable_reason()
        if reason:
            raise unittest.SkipTest(reason)

    def setUp(self):
        self.fx = SidecarFixture(env=dict(self.ENV))
        self.addCleanup(self._cleanup)
        self.setUpFixture()
        if self.AUTOSTART:
            self.fx.start()

    def setUpFixture(self):
        pass

    def _cleanup(self):
        # a cleanup cannot see the test's own outcome, so dump the log when the
        # sidecar died on its own (signal tests end it deliberately: 0/130/143)
        rc = self.fx.proc.poll() if self.fx.proc else None
        if (rc is not None and rc not in (0, 130, 143)) or os.environ.get('PHNX_SIDECAR_SHOW_LOG'):
            sys.stderr.write(f'\n--- sidecar log ({self.id()}, rc={rc}) ---\n{self.fx.log()}\n')
        self.fx.close()

    def assertErrno(self, err, fn, *args, **kwargs):
        with self.assertRaises(OSError) as cm:
            fn(*args, **kwargs)
        self.assertEqual(cm.exception.errno, err,
                         f'expected {os.strerror(err)}, got {cm.exception!r}')
        return cm.exception
