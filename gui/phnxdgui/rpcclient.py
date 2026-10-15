"""Unix-socket RPC client for the engine.

The protocol is one JSON line of request per connection, one JSON line of
response, then the engine closes the socket (see src/rpc.ts). Reads and writes
never touch Proton directly; they only ask the running engine.

Blocking calls must never run on the GTK main loop: ``call_async`` runs them on a
daemon thread and marshals the outcome back with GLib.idle_add.
"""

import json
import os
import socket
import threading

from . import paths

# pin/unpin/evict can run a sync pass first and legitimately take minutes.
RPC_TIMEOUT_S = 30 * 60


class RpcError(RuntimeError):
    """Any failure talking to the engine (not running, malformed, op error)."""


def engine_available() -> bool:
    return os.path.exists(paths.rpc_socket())


def call_sync(op: str, path_list, timeout: int = RPC_TIMEOUT_S) -> dict:
    """Blocking one-line round trip. Raises RpcError on any failure."""
    payload = (json.dumps({"op": op, "paths": list(path_list)}) + "\n").encode()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(paths.rpc_socket())
    except OSError as exc:
        sock.close()
        raise RpcError("engine is not running") from exc
    try:
        sock.sendall(payload)
        buf = b""
        while b"\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                raise RpcError("engine closed the connection unexpectedly")
            buf += chunk
    finally:
        sock.close()
    try:
        resp = json.loads(buf.split(b"\n", 1)[0].decode())
    except ValueError as exc:
        raise RpcError("bad response from engine") from exc
    if not resp.get("ok"):
        raise RpcError(resp.get("error") or f"{op} failed")
    return resp


def _deliver(callback, arg):
    callback(arg)
    return False  # one-shot idle source


def call_async(op: str, path_list, on_done, on_error=None, timeout: int = RPC_TIMEOUT_S):
    """Run ``call_sync`` on a worker thread; deliver on the GTK main loop.

    ``on_done`` gets the response dict; ``on_error`` (if given) gets the
    exception. Callbacks run on the main loop and must guard against a
    destroyed window themselves.
    """

    def work():
        try:
            resp = call_sync(op, path_list, timeout)
        except Exception as exc:  # noqa: BLE001 - handed to the UI thread
            if on_error is not None:
                from gi.repository import GLib

                GLib.idle_add(_deliver, on_error, exc)
            return
        from gi.repository import GLib

        GLib.idle_add(_deliver, on_done, resp)

    threading.Thread(target=work, name=f"rpc-{op}", daemon=True).start()


def list_dir(rel: str, on_done, on_error=None):
    call_async("list", [rel], on_done, on_error)


def pin(path_list, on_done, on_error=None):
    call_async("pin", path_list, on_done, on_error)


def unpin(path_list, on_done, on_error=None):
    call_async("unpin", path_list, on_done, on_error)


def evict_all(on_done, on_error=None):
    call_async("evict", ["*"], on_done, on_error)


def sync_now(on_done, on_error=None):
    call_async("sync", [], on_done, on_error)


def prefetch(mode: str, on_done, on_error=None):
    call_async("prefetch", [mode], on_done, on_error)
