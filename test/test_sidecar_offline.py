"""Unit tests for the sidecar's offline/RPC error mapping (no FUSE mount needed).

pyfuse3/trio are not importable off a real install, so they are stubbed before the
sidecar is imported. The pieces under test - ``fuse_err_for``, the structured
offline handling in ``rpc`` and the ``ENGINE_OFFLINE`` prefetch gate - are pure
stdlib and never touch a real mount.
"""

import errno
import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import types
import unittest

SIDECAR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "python", "sidecar.py"))


class _FUSEError(Exception):
    def __init__(self, err_no):
        super().__init__(err_no)
        self.errno = err_no


def _stub_modules() -> None:
    if "pyfuse3" not in sys.modules:
        pyfuse3 = types.ModuleType("pyfuse3")
        pyfuse3.ROOT_INODE = 1
        pyfuse3.FUSEError = _FUSEError
        pyfuse3.EntryAttributes = type("EntryAttributes", (), {})
        pyfuse3.FileInfo = type("FileInfo", (), {"__init__": lambda self, fh=None: setattr(self, "fh", fh)})
        pyfuse3.Operations = object
        pyfuse3.StatvfsData = type("StatvfsData", (), {})
        pyfuse3.readdir_reply = lambda *a, **k: False
        pyfuse3.default_options = set()
        pyfuse3.init = lambda *a, **k: None
        pyfuse3.main = lambda *a, **k: None
        pyfuse3.close = lambda *a, **k: None
        sys.modules["pyfuse3"] = pyfuse3
    if "trio" not in sys.modules:
        trio = types.ModuleType("trio")
        trio.to_thread = types.SimpleNamespace(run_sync=lambda fn, *a, **k: fn())
        trio.sleep = lambda *a, **k: None
        sys.modules["trio"] = trio


def _load_sidecar():
    _stub_modules()
    spec = importlib.util.spec_from_file_location("phnx_sidecar", SIDECAR)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _serve_one(response: dict):
    """Start a one-shot unix-socket server; returns (socket_path, thread)."""
    directory = tempfile.mkdtemp(prefix="sidecar-test-")
    sock_path = os.path.join(directory, "rpc.sock")
    ready = threading.Event()

    def worker():
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(sock_path)
        srv.listen(1)
        ready.set()
        conn, _ = srv.accept()
        try:
            conn.recv(65536)  # request line
            conn.sendall((json.dumps(response) + "\n").encode())
        finally:
            conn.close()
            srv.close()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    ready.wait(2)
    return sock_path, thread


class FuseErrFor(unittest.TestCase):
    def setUp(self):
        self.mod = _load_sidecar()

    def test_offline_maps_to_enetdown(self):
        self.assertEqual(self.mod.fuse_err_for(self.mod.SidecarOffline("x")).errno, errno.ENETDOWN)

    def test_unreachable_maps_to_enotconn(self):
        self.assertEqual(self.mod.fuse_err_for(self.mod.EngineUnreachable("x")).errno, errno.ENOTCONN)

    def test_auth_maps_to_eacces(self):
        self.assertEqual(self.mod.fuse_err_for(self.mod.EngineAuth("x")).errno, errno.EACCES)

    def test_generic_runtime_maps_to_eio(self):
        self.assertEqual(self.mod.fuse_err_for(RuntimeError("boom")).errno, errno.EIO)

    def test_oserror_keeps_its_errno(self):
        self.assertEqual(self.mod.fuse_err_for(OSError(errno.EACCES, "denied")).errno, errno.EACCES)

    def test_offline_subclasses_are_runtime_errors(self):
        # callers use `except RuntimeError`, so the mapped classes must be catchable
        self.assertTrue(issubclass(self.mod.SidecarOffline, RuntimeError))
        self.assertTrue(issubclass(self.mod.EngineUnreachable, RuntimeError))


class RpcContract(unittest.TestCase):
    def setUp(self):
        self.mod = _load_sidecar()
        self.mod.ENGINE_OFFLINE = False
        self.mod.RPC_CONNECT_TIMEOUT_S = 2.0
        self.mod.RPC_RESPONSE_TIMEOUT_S = 2.0

    def test_offline_response_raises_sidecar_offline(self):
        path, _ = _serve_one({"ok": False, "code": "offline", "offline": True, "error": "offline: a.txt needs internet"})
        self.mod.RPC = path
        with self.assertRaises(self.mod.SidecarOffline):
            self.mod.rpc("hydrate", ["a.txt"])
        self.assertTrue(self.mod.ENGINE_OFFLINE)

    def test_success_response_sets_engine_offline_flag(self):
        path, _ = _serve_one({"ok": True, "offline": True, "results": []})
        self.mod.RPC = path
        self.mod.rpc("list", [""])
        self.assertTrue(self.mod.ENGINE_OFFLINE)

    def test_plain_error_response_raises_runtime_error(self):
        path, _ = _serve_one({"ok": False, "error": "missing baseline facts"})
        self.mod.RPC = path
        with self.assertRaises(RuntimeError):
            self.mod.rpc("hydrate", ["a.txt"])

    def test_auth_response_raises_engine_auth(self):
        path, _ = _serve_one({"ok": False, "code": "auth", "error": "401 Unauthorized"})
        self.mod.RPC = path
        with self.assertRaises(self.mod.EngineAuth):
            self.mod.rpc("trash", ["a.txt"])

    def test_connect_budget_expiry_raises_engine_unreachable(self):
        self.mod.RPC = os.path.join(tempfile.mkdtemp(prefix="sidecar-test-"), "absent.sock")
        self.mod.RPC_CONNECT_TIMEOUT_S = 0.3
        with self.assertRaises(self.mod.EngineUnreachable):
            self.mod.rpc("hydrate", ["a.txt"])


class PrefetchGate(unittest.TestCase):
    def setUp(self):
        self.mod = _load_sidecar()
        self.mod.NURSERY = types.SimpleNamespace(start_soon=lambda *a, **k: None)
        self.mod.PREFETCH_QUEUE.clear()
        self.mod.PREFETCH_INFLIGHT.clear()

    def test_offline_drops_without_queueing(self):
        self.mod.ENGINE_OFFLINE = True
        self.mod._schedule_prefetch("a/b.txt")
        self.assertEqual(self.mod.PREFETCH_QUEUE, [])

    def test_online_queues(self):
        self.mod.ENGINE_OFFLINE = False
        self.mod.PREFETCH_MAX = 0  # keep the pump from draining the queue under the stub
        self.mod._schedule_prefetch("a/b.txt")
        self.assertIn("a/b.txt", self.mod.PREFETCH_QUEUE)


if __name__ == "__main__":
    unittest.main()
