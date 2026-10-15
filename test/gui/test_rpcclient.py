"""RPC client tests against a fake unix-socket engine (no real daemon needed)."""

import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "gui")))

from phnxdgui import rpcclient  # noqa: E402


class FakeEngine:
    """Answers exactly one JSON-line request, then closes (the engine protocol)."""

    def __init__(self, tmpdir: str, response: bytes):
        self.sock_path = os.path.join(tmpdir, "state", "rpc.sock")
        os.makedirs(os.path.dirname(self.sock_path), exist_ok=True)
        self._response = response
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(self.sock_path)
        self._server.listen(1)
        self.received = None
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        try:
            conn, _ = self._server.accept()
        except OSError:
            return
        try:
            data = b""
            while b"\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            self.received = json.loads(data.split(b"\n", 1)[0].decode())
            conn.sendall(self._response)
        finally:
            conn.close()

    def close(self):
        try:
            self._server.close()
        except OSError:
            pass


class RpcClient(unittest.TestCase):
    def setUp(self):
        self._home = tempfile.mkdtemp()
        self._old = os.environ.get("DRIVE_SYNC_HOME")
        os.environ["DRIVE_SYNC_HOME"] = self._home
        self._engines = []

    def tearDown(self):
        for engine in self._engines:
            engine.close()
        if self._old is None:
            os.environ.pop("DRIVE_SYNC_HOME", None)
        else:
            os.environ["DRIVE_SYNC_HOME"] = self._old
        shutil.rmtree(self._home, ignore_errors=True)

    def start(self, response: bytes) -> FakeEngine:
        engine = FakeEngine(self._home, response)
        self._engines.append(engine)
        return engine

    def test_list_success_round_trip(self):
        entry = {"path": "a.txt", "name": "a.txt", "type": "file", "presence": "local", "sync": "clean", "pinned": False, "size": 3, "mtime": 0}
        engine = self.start(json.dumps({"ok": True, "entries": [entry]}).encode() + b"\n")
        resp = rpcclient.call_sync("list", [""], timeout=5)
        self.assertEqual(resp["entries"][0]["name"], "a.txt")
        self.assertEqual(engine.received, {"op": "list", "paths": [""]})

    def test_op_error_raises(self):
        self.start(json.dumps({"ok": False, "error": "boom"}).encode() + b"\n")
        with self.assertRaises(rpcclient.RpcError) as ctx:
            rpcclient.call_sync("list", [""], timeout=5)
        self.assertIn("boom", str(ctx.exception))

    def test_malformed_response_raises(self):
        self.start(b"not json\n")
        with self.assertRaises(rpcclient.RpcError):
            rpcclient.call_sync("list", [""], timeout=5)

    def test_engine_not_running(self):
        with self.assertRaises(rpcclient.RpcError) as ctx:
            rpcclient.call_sync("list", [""], timeout=5)
        self.assertIn("not running", str(ctx.exception))

    def test_engine_available_reflects_socket(self):
        self.assertFalse(rpcclient.engine_available())
        self.start(b'{"ok": true}\n')
        self.assertTrue(rpcclient.engine_available())


if __name__ == "__main__":
    unittest.main()
