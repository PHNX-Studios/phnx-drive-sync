#!/usr/bin/env python3
"""FUSE sidecar for drive-sync Phase 2 (visible placeholders).

Serves the user-facing mount (--mount) from the real tree (--tree) plus the
sync baseline (--db, read-only):

- materialized entries  -> direct passthrough reads/writes on --tree
- placeholders (online markers in state.db) -> baseline size/mtime at zero
  disk cost (st_blocks=0); open() blocks on a hydrate RPC to the engine,
  which downloads into --tree and clears the marker, then the real file is
  served (OneDrive recall semantics: materializes).

Must be spawned by the engine under systemd --user (unconfined): AppArmor's
fusermount3 profile cannot inherit a unix socket created under the
snap.opencode.opencode label, so a spawn from a confined shell fails with
"fusermount3: file descriptor N is not a socket".

Metadata policy: sizes/mtimes for placeholders come from the `sync` baseline;
mode/uid/gid are this process's (not stored in state.db). Nothing else is
invented. entry/attr timeouts are 0: every op consults tree + baseline, so
pin/unpin under the mount is always observed immediately.
"""

import argparse
import errno
import hashlib
import json
import logging
import os
import signal
import socket
import sqlite3
import stat as statmod
import sys
import time

import pyfuse3
import trio

ROOT_INO = pyfuse3.ROOT_INODE
TRASH_NAMES = ('.Trash',)

INO_OF: dict = {}   # rel -> ino
PATH_OF: dict = {}  # ino -> rel ('' = root)
DIR_FH: dict = {}   # opendir fh -> rel

MOUNT = TREE = DB = RPC = MOUNT_OK = None  # set in main()
DBCONN = None
STOPPING = False
_dir_fh_next = [1]


# ---------------------------------------------------------------- paths/inos

def ino_for(rel: str) -> int:
    if not rel:
        INO_OF[''] = ROOT_INO
        PATH_OF[ROOT_INO] = ''
        return ROOT_INO
    i = INO_OF.get(rel)
    if i is not None:
        return i
    digest = hashlib.sha1(rel.encode()).hexdigest()
    salt = 0
    while True:
        i = 2 + ((int(digest, 16) ^ (salt << 1)) & ((1 << 62) - 1))
        owner = PATH_OF.get(i)
        if owner is None or owner == rel:
            INO_OF[rel] = i
            PATH_OF[i] = rel
            return i
        salt += 1
        digest = hashlib.sha1(f'{rel}\x00{salt}'.encode()).hexdigest()


def rel_of(ino: int) -> str:
    rel = PATH_OF.get(ino)
    if rel is None:
        raise pyfuse3.FUSEError(errno.ENOENT)
    return rel


def parent_rel(rel: str) -> str:
    return rel.rsplit('/', 1)[0] if '/' in rel else ''


def join_rel(parent: str, name: str) -> str:
    return f'{parent}/{name}' if parent else name


def _s(x) -> str:
    return x.decode('utf-8', 'surrogateescape') if isinstance(x, (bytes, bytearray)) else x


def abspath(rel: str) -> str:
    return TREE if not rel else os.path.join(TREE, rel)


def on_tree(rel: str) -> bool:
    try:
        os.lstat(abspath(rel))
        return True
    except OSError:
        return False


def _is_trash_target(rel: str) -> bool:
    """True if any component is a trash dir; mirrors filters.ts isFiltered."""
    return any(seg == '.Trash' or (seg.startswith('.Trash-') and seg[7:].isdigit())
               for seg in rel.split('/'))


def fuse_err(e: OSError) -> pyfuse3.FUSEError:
    return pyfuse3.FUSEError(e.errno or errno.EIO)


def _move_ino(frm: str, to: str):
    i = INO_OF.pop(frm, None)
    if i is not None:
        PATH_OF[i] = to
        INO_OF[to] = i


# ---------------------------------------------------------------- baseline db

def placeholder_of(rel: str):
    """Baseline (size, mtime_ms) for a marked file, or None."""
    return DBCONN.execute(
        'SELECT s.rsize, s.rmtime FROM online o JOIN sync s ON s.path = o.path '
        'WHERE o.path = ? AND s.type = ?',
        (rel, 'file'),
    ).fetchone()


def placeholder_children(parent: str):
    rows = DBCONN.execute(
        'SELECT o.path FROM online o JOIN sync s ON s.path = o.path WHERE s.type = ?',
        ('file',),
    ).fetchall()
    prefix = parent + '/' if parent else ''
    out = []
    for (p,) in rows:
        if not p.startswith(prefix):
            continue
        name = p[len(prefix):]
        if '/' not in name:
            out.append(name)
    return out


# ---------------------------------------------------------------- attributes

def attr_from_stat(st, ino: int):
    a = pyfuse3.EntryAttributes()
    a.st_ino = ino
    a.st_mode = st.st_mode
    a.st_nlink = st.st_nlink
    a.st_uid = st.st_uid
    a.st_gid = st.st_gid
    a.st_rdev = st.st_rdev
    a.st_size = st.st_size
    a.st_blksize = 4096
    a.st_blocks = st.st_blocks
    a.st_atime_ns = st.st_atime_ns
    a.st_mtime_ns = st.st_mtime_ns
    a.st_ctime_ns = st.st_ctime_ns
    a.st_birthtime_ns = st.st_ctime_ns
    a.entry_timeout = 0
    a.attr_timeout = 0
    return a


def placeholder_attr(rel: str, size, mtime_ms):
    a = pyfuse3.EntryAttributes()
    a.st_ino = ino_for(rel)
    a.st_mode = statmod.S_IFREG | 0o644
    a.st_nlink = 1
    a.st_uid = os.getuid()
    a.st_gid = os.getgid()
    a.st_rdev = 0
    a.st_size = int(size or 0)
    a.st_blksize = 4096
    a.st_blocks = 0  # zero disk cost: du shows 0 while stat shows real size
    mtime_ns = int((mtime_ms or 0) * 1_000_000)
    a.st_atime_ns = a.st_mtime_ns = a.st_ctime_ns = mtime_ns
    a.st_birthtime_ns = mtime_ns
    a.entry_timeout = 0
    a.attr_timeout = 0
    return a


def fs_attrs(rel: str):
    """Materialized attrs from tree, else placeholder attrs from baseline."""
    if not rel:
        return attr_from_stat(os.stat(TREE), ROOT_INO)
    try:
        st = os.lstat(abspath(rel))
    except FileNotFoundError:
        row = placeholder_of(rel)
        if row is not None:
            return placeholder_attr(rel, row[0], row[1])
        raise pyfuse3.FUSEError(errno.ENOENT)
    except OSError as e:
        raise fuse_err(e)
    return attr_from_stat(st, ino_for(rel))


# ---------------------------------------------------------------- engine rpc

def rpc(op: str, paths: list):
    """One JSON-line request; blocks (minutes) until the engine answers.

    Retries connect until the engine's RPC socket exists (it opens after the
    initial pass) unless the sidecar is stopping.
    """
    payload = (json.dumps({'op': op, 'paths': paths}) + '\n').encode()
    while True:
        if STOPPING:
            raise RuntimeError('sidecar is stopping')
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.connect(RPC)
            break
        except OSError:
            sock.close()
            time.sleep(1)
    try:
        sock.sendall(payload)
        buf = b''
        while b'\n' not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                raise RuntimeError('engine closed the connection')
            buf += chunk
    finally:
        sock.close()
    resp = json.loads(buf.split(b'\n', 1)[0].decode())
    if not resp.get('ok'):
        raise RuntimeError(resp.get('error') or f'{op} failed')


async def hydrate(rel: str):
    logging.info('hydrate: %s (blocking until downloaded)', rel)
    await trio.to_thread.run_sync(lambda: rpc('hydrate', [rel]))
    logging.info('hydrate: %s done', rel)


# ---------------------------------------------------------------- filesystem

class Ops(pyfuse3.Operations):
    supports_dot_lookup = True

    async def getattr(self, inode, ctx=None):
        return fs_attrs(rel_of(inode))

    async def lookup(self, parent_inode, name, ctx=None):
        name = _s(name)
        prel = rel_of(parent_inode)
        if name == '.':
            return fs_attrs(prel)
        if name == '..':
            return fs_attrs(parent_rel(prel))
        if '/' in name or name == '':
            raise pyfuse3.FUSEError(errno.ENOENT)
        return fs_attrs(join_rel(prel, name))

    async def opendir(self, inode, ctx=None):
        rel = rel_of(inode)
        _dir_fh_next[0] += 1
        fh = _dir_fh_next[0]
        DIR_FH[fh] = rel
        return fh

    async def releasedir(self, fh):
        DIR_FH.pop(fh, None)

    async def readdir(self, fh, start_id, token):
        rel = DIR_FH.get(fh)
        if rel is None:
            return
        try:
            names = os.listdir(abspath(rel))
        except OSError:
            names = []
        entries = [('.', rel), ('..', parent_rel(rel))]
        seen = {ent[0] for ent in entries}
        for n in sorted(names):
            if n in TRASH_NAMES or n.startswith('.Trash-'):
                continue  # gvfs trash dirs: passthrough but hidden
            if n not in seen:
                entries.append((n, join_rel(rel, n)))
                seen.add(n)
        for n in sorted(placeholder_children(rel)):
            if n in seen or on_tree(join_rel(rel, n)):
                continue
            entries.append((n, join_rel(rel, n)))
            seen.add(n)
        for pos, (name, child) in enumerate(entries, start=1):
            if pos <= start_id:
                continue
            try:
                attrs = fs_attrs(child)
            except pyfuse3.FUSEError:
                continue
            if not pyfuse3.readdir_reply(token, name.encode(), attrs, pos):
                return

    async def open(self, inode, flags, ctx=None):
        rel = rel_of(inode)
        if not on_tree(rel):
            if placeholder_of(rel) is None:
                raise pyfuse3.FUSEError(errno.ENOENT)
            await hydrate(rel)
            if not on_tree(rel):
                raise pyfuse3.FUSEError(errno.EIO)
        try:
            fd = os.open(abspath(rel), flags)
        except OSError as e:
            raise fuse_err(e)
        return pyfuse3.FileInfo(fh=fd)

    async def create(self, parent_inode, name, mode, flags, ctx=None):
        rel = join_rel(rel_of(parent_inode), _s(name))
        try:
            fd = os.open(abspath(rel), flags | os.O_CREAT, mode)
        except OSError as e:
            raise fuse_err(e)
        return pyfuse3.FileInfo(fh=fd), fs_attrs(rel)

    async def read(self, fh, off, size):
        try:
            return os.pread(fh, size, off)
        except OSError as e:
            raise fuse_err(e)

    async def write(self, fh, off, buf):
        written = 0
        while written < len(buf):
            try:
                n = os.pwrite(fh, buf[written:], off + written)
            except OSError as e:
                raise fuse_err(e)
            if n == 0:
                raise pyfuse3.FUSEError(errno.EIO)
            written += n
        return written

    async def release(self, fh):
        try:
            os.close(fh)
        except OSError:
            pass

    async def flush(self, fh):
        try:
            os.fsync(fh)
        except OSError:
            pass

    async def fsync(self, fh, datasync):
        try:
            (os.fdatasync if datasync else os.fsync)(fh)
        except OSError as e:
            raise fuse_err(e)

    async def unlink(self, parent_inode, name, ctx=None):
        rel = join_rel(rel_of(parent_inode), _s(name))
        if on_tree(rel):
            try:
                os.unlink(abspath(rel))
                return
            except OSError as e:
                raise fuse_err(e)
        if placeholder_of(rel) is not None:
            await trio.to_thread.run_sync(lambda: rpc('trash', [rel]))
            return
        raise pyfuse3.FUSEError(errno.ENOENT)

    async def rename(self, parent_inode_old, name_old, parent_inode_new, name_new, flags, ctx=None):
        frm = join_rel(rel_of(parent_inode_old), _s(name_old))
        to = join_rel(rel_of(parent_inode_new), _s(name_new))
        if on_tree(frm):
            try:
                os.rename(abspath(frm), abspath(to))
            except OSError as e:
                raise fuse_err(e)
            _move_ino(frm, to)
            return
        if placeholder_of(frm) is not None:
            if _is_trash_target(to):
                # glib/Nautilus trashes on the same fs by renaming into
                # .Trash-<uid>/files; a placeholder has no bytes to move, so
                # translate it into the trash RPC (remote trash + row + marker)
                await trio.to_thread.run_sync(lambda: rpc('trash', [frm]))
                return
            try:
                await trio.to_thread.run_sync(lambda: rpc('mv', [frm, to]))
            except RuntimeError as e:
                # engine reports source is no longer a placeholder (race): fall back
                if on_tree(frm):
                    try:
                        os.rename(abspath(frm), abspath(to))
                    except OSError as e2:
                        raise fuse_err(e2)
                    _move_ino(frm, to)
                    return
                raise pyfuse3.FUSEError(errno.EIO) from e
            _move_ino(frm, to)
            return
        raise pyfuse3.FUSEError(errno.ENOENT)

    async def mkdir(self, parent_inode, name, mode, ctx=None):
        rel = join_rel(rel_of(parent_inode), _s(name))
        try:
            os.mkdir(abspath(rel), mode)
        except OSError as e:
            raise fuse_err(e)
        return fs_attrs(rel)

    async def rmdir(self, parent_inode, name, ctx=None):
        rel = join_rel(rel_of(parent_inode), _s(name))
        try:
            os.rmdir(abspath(rel))
        except OSError as e:
            raise fuse_err(e)

    async def setattr(self, inode, attr, fields, fh, ctx=None):
        rel = rel_of(inode)
        if not on_tree(rel):
            if placeholder_of(rel) is None:
                raise pyfuse3.FUSEError(errno.ENOENT)
            await hydrate(rel)
        p = abspath(rel)
        try:
            if fields.update_mode:
                os.chmod(p, statmod.S_IMODE(attr.st_mode))
            if fields.update_uid or fields.update_gid:
                os.chown(p, attr.st_uid, attr.st_gid)
            if fields.update_size:
                os.truncate(p, attr.st_size)
            if fields.update_mtime or fields.update_atime:
                st = os.stat(p)
                atime_ns = attr.st_atime_ns if fields.update_atime else st.st_atime_ns
                mtime_ns = attr.st_mtime_ns if fields.update_mtime else st.st_mtime_ns
                os.utime(p, ns=(atime_ns, mtime_ns))
        except OSError as e:
            raise fuse_err(e)
        return fs_attrs(rel)

    async def readlink(self, inode, ctx=None):
        rel = rel_of(inode)
        try:
            return os.readlink(abspath(rel)).encode()
        except OSError as e:
            raise fuse_err(e)

    async def statfs(self, ctx):
        st = os.statvfs(TREE)
        s = pyfuse3.StatvfsData()
        s.f_bsize = st.f_bsize
        s.f_frsize = st.f_frsize
        s.f_blocks = st.f_blocks
        s.f_bfree = st.f_bfree
        s.f_bavail = st.f_bavail
        s.f_files = st.f_files
        s.f_ffree = st.f_ffree
        s.f_favail = st.f_favail
        s.f_namemax = st.f_namemax
        return s

    async def forget(self, inode_list):
        # mappings are kept deliberately: re-lookups reuse the same ino
        pass


# ---------------------------------------------------------------- lifecycle

def touch_mount_ok():
    with open(MOUNT_OK, 'w') as f:
        f.write(str(os.getpid()))


def remove_mount_ok():
    try:
        os.unlink(MOUNT_OK)
    except FileNotFoundError:
        pass


async def heartbeat():
    while True:
        try:
            touch_mount_ok()
        except OSError:
            pass
        await trio.sleep(2)


async def run():
    async with trio.open_nursery() as n:
        n.start_soon(heartbeat)
        await pyfuse3.main()


def main():
    global MOUNT, TREE, DB, RPC, MOUNT_OK, DBCONN, STOPPING
    ap = argparse.ArgumentParser()
    ap.add_argument('--mount', required=True)
    ap.add_argument('--tree', required=True)
    ap.add_argument('--db', required=True)
    ap.add_argument('--rpc', required=True)
    ap.add_argument('--mount-ok', required=True)
    args = ap.parse_args()
    MOUNT, TREE, DB, RPC, MOUNT_OK = args.mount, args.tree, args.db, args.rpc, args.mount_ok

    logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                        format='%(asctime)s sidecar %(levelname)s %(message)s')
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(143))
    signal.signal(signal.SIGINT, lambda *a: sys.exit(130))
    ino_for('')  # register the root inode before any request arrives
    DBCONN = sqlite3.connect(f'file:{DB}?mode=ro', uri=True, check_same_thread=False)
    DBCONN.execute('PRAGMA query_only=1')

    os.makedirs(MOUNT, exist_ok=True)
    options = set(pyfuse3.default_options)
    options.add('fsname=drive-sync')
    pyfuse3.init(Ops(), MOUNT, options)
    touch_mount_ok()
    logging.info('mounted %s (tree=%s)', MOUNT, TREE)
    try:
        trio.run(run)
    finally:
        STOPPING = True
        remove_mount_ok()
        try:
            pyfuse3.close(unmount=True)
        except Exception:
            pass
        logging.info('unmounted %s', MOUNT)


if __name__ == '__main__':
    main()
