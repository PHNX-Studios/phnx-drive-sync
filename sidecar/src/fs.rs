//! The user-facing mount: the real tree plus the sync baseline.
//!
//! - materialized entries -> direct passthrough reads/writes on the tree
//! - placeholders (online markers in state.db) -> baseline size/mtime at zero
//!   disk cost (st_blocks=0); open() blocks on a hydrate RPC to the engine,
//!   which downloads into the tree and clears the marker, then the real file is
//!   served (OneDrive recall semantics: materializes).
//!
//! Entry/attr TTLs are 0: every op consults tree + baseline, so pin/unpin under
//! the mount is always observed immediately. Operations that may wait on the
//! engine run on their own thread and reply from there, so a download that
//! takes minutes never stalls the rest of the mount.

use std::collections::HashMap;
use std::ffi::{CString, OsStr};
use std::fs::Metadata;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fuser::{
    Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, LockOwner,
    OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty,
    ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, TimeOrNow, WriteFlags,
};

use crate::baseline::{self, Placeholder};
use crate::inodes::{Inodes, ROOT_INO, Rel, is_trash_target, join_rel, parent_rel};
use crate::prefetch::Prefetch;
use crate::rpc::Rpc;

const TTL: Duration = Duration::ZERO;
const GEN: Generation = Generation(0);
const BLKSIZE: u32 = 4096;
/// Tree/baseline check rounds before an entry is reported missing (see fs_attrs).
const ATTR_ROUNDS: usize = 3;

type Res<T> = Result<T, Errno>;

pub struct Shared {
    tree: PathBuf,
    inodes: Mutex<Inodes>,
    dirs: Mutex<HashMap<u64, Rel>>,
    next_dir_fh: AtomicU64,
    rpc: Arc<Rpc>,
    prefetch: Arc<Prefetch>,
    uid: u32,
    gid: u32,
}

pub struct Fs(Arc<Shared>);

impl Fs {
    pub fn new(tree: PathBuf, rpc: Arc<Rpc>) -> Self {
        let prefetch = Prefetch::new(Arc::clone(&rpc));
        // SAFETY: getuid/getgid cannot fail
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        Fs(Arc::new(Shared {
            tree,
            inodes: Mutex::new(Inodes::new()),
            dirs: Mutex::new(HashMap::new()),
            next_dir_fh: AtomicU64::new(1),
            rpc,
            prefetch,
            uid,
            gid,
        }))
    }

    /// Run `f` on its own thread: for work that may wait on the engine.
    fn blocking(&self, f: impl FnOnce(&Shared) + Send + 'static) {
        let sh = Arc::clone(&self.0);
        thread::spawn(move || f(&sh));
    }
}

// ---------------------------------------------------------------- helpers

fn errno_of(e: std::io::Error) -> Errno {
    Errno::from(e)
}

fn last_errno() -> Errno {
    errno_of(std::io::Error::last_os_error())
}

fn cstr(p: &std::path::Path) -> Res<CString> {
    CString::new(p.as_os_str().as_bytes()).map_err(|_| Errno::EINVAL)
}

fn check(rc: libc::c_int) -> Res<()> {
    if rc < 0 { Err(last_errno()) } else { Ok(()) }
}

fn systime(sec: i64, nsec: i64) -> SystemTime {
    let nsec = nsec.clamp(0, 999_999_999) as u32;
    if sec >= 0 {
        UNIX_EPOCH + Duration::new(sec as u64, nsec)
    } else {
        UNIX_EPOCH - Duration::from_secs(sec.unsigned_abs()) + Duration::from_nanos(nsec as u64)
    }
}

fn kind_of(mode: u32) -> FileType {
    match mode & libc::S_IFMT {
        libc::S_IFDIR => FileType::Directory,
        libc::S_IFLNK => FileType::Symlink,
        libc::S_IFIFO => FileType::NamedPipe,
        libc::S_IFCHR => FileType::CharDevice,
        libc::S_IFBLK => FileType::BlockDevice,
        libc::S_IFSOCK => FileType::Socket,
        _ => FileType::RegularFile,
    }
}

fn timespec_of(t: Option<TimeOrNow>) -> libc::timespec {
    let (tv_sec, tv_nsec) = match t {
        None => (0, libc::UTIME_OMIT),
        Some(TimeOrNow::Now) => (0, libc::UTIME_NOW),
        Some(TimeOrNow::SpecificTime(st)) => match st.duration_since(UNIX_EPOCH) {
            Ok(d) => (
                d.as_secs() as libc::time_t,
                d.subsec_nanos() as libc::c_long,
            ),
            Err(e) => {
                let d = e.duration();
                let (mut s, mut n) = (-(d.as_secs() as i64), -(d.subsec_nanos() as i64));
                if n < 0 {
                    s -= 1;
                    n += 1_000_000_000;
                }
                (s as libc::time_t, n as libc::c_long)
            }
        },
    };
    libc::timespec { tv_sec, tv_nsec }
}

/// The attributes a setattr asked to change (None = leave as is).
#[derive(Clone, Copy)]
struct Changes {
    mode: Option<u32>,
    uid: Option<u32>,
    gid: Option<u32>,
    size: Option<u64>,
    atime: Option<TimeOrNow>,
    mtime: Option<TimeOrNow>,
}

impl Shared {
    fn abspath(&self, rel: &[u8]) -> PathBuf {
        if rel.is_empty() {
            self.tree.clone()
        } else {
            self.tree.join(OsStr::from_bytes(rel))
        }
    }

    fn rel_of(&self, ino: INodeNo) -> Res<Rel> {
        self.inodes
            .lock()
            .unwrap()
            .rel_of(ino.0)
            .ok_or(Errno::ENOENT)
    }

    fn ino_for(&self, rel: &[u8]) -> u64 {
        self.inodes.lock().unwrap().ino_for(rel)
    }

    fn on_tree(&self, rel: &[u8]) -> bool {
        std::fs::symlink_metadata(self.abspath(rel)).is_ok()
    }

    fn attr_from_meta(&self, m: &Metadata, ino: u64) -> FileAttr {
        FileAttr {
            ino: INodeNo(ino),
            size: m.size(),
            blocks: m.blocks(),
            atime: systime(m.atime(), m.atime_nsec()),
            mtime: systime(m.mtime(), m.mtime_nsec()),
            ctime: systime(m.ctime(), m.ctime_nsec()),
            crtime: systime(m.ctime(), m.ctime_nsec()),
            kind: kind_of(m.mode()),
            perm: (m.mode() & 0o7777) as u16,
            nlink: m.nlink() as u32,
            uid: m.uid(),
            gid: m.gid(),
            rdev: m.rdev() as u32,
            blksize: BLKSIZE,
            flags: 0,
        }
    }

    fn placeholder_attr(&self, rel: &[u8], p: Placeholder) -> FileAttr {
        let t = systime(
            p.mtime_ns.div_euclid(1_000_000_000),
            p.mtime_ns.rem_euclid(1_000_000_000),
        );
        FileAttr {
            ino: INodeNo(self.ino_for(rel)),
            size: p.size,
            blocks: 0, // zero disk cost: du shows 0 while stat shows the real size
            atime: t,
            mtime: t,
            ctime: t,
            crtime: t,
            kind: FileType::RegularFile,
            perm: 0o644,
            nlink: 1,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: BLKSIZE,
            flags: 0,
        }
    }

    /// Materialized attrs from the tree, else placeholder attrs from the baseline.
    fn fs_attrs(&self, rel: &[u8]) -> Res<FileAttr> {
        if rel.is_empty() {
            let m = std::fs::metadata(&self.tree).map_err(errno_of)?;
            return Ok(self.attr_from_meta(&m, ROOT_INO));
        }
        let path = self.abspath(rel);
        let tree_attr = |res: std::io::Result<Metadata>| match res {
            Ok(m) => Some(Ok(self.attr_from_meta(&m, self.ino_for(rel)))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => Some(Err(errno_of(e))),
        };
        // The engine moves a hydrate's bytes in before clearing the marker, and
        // evict marks before unlinking, so the file is always on one side or the
        // other. A transition landing between the two checks reads as missing on
        // both, so look again before reporting a spurious ENOENT; a few rounds
        // also cover back-to-back flips.
        for _ in 0..ATTR_ROUNDS {
            if let Some(r) = tree_attr(std::fs::symlink_metadata(&path)) {
                return r;
            }
            if let Some(p) = baseline::placeholder_of(rel) {
                return Ok(self.placeholder_attr(rel, p));
            }
        }
        tree_attr(std::fs::symlink_metadata(&path)).unwrap_or(Err(Errno::ENOENT))
    }

    fn rpc(&self, op: &str, paths: &[&[u8]]) -> Res<()> {
        // engine paths are always UTF-8 (they come from the baseline)
        let strs = paths
            .iter()
            .map(|p| std::str::from_utf8(p).map_err(|_| Errno::EINVAL))
            .collect::<Res<Vec<_>>>()?;
        self.rpc.call(op, &strs).map(drop).map_err(|e| {
            log::warn!("{op} {strs:?}: {e}");
            e.errno()
        })
    }

    fn hydrate(&self, rel: &[u8]) -> Res<()> {
        let shown = String::from_utf8_lossy(rel);
        log::info!("hydrate: {shown} (blocking until downloaded)");
        self.rpc("hydrate", &[rel])?;
        log::info!("hydrate: {shown} done");
        Ok(())
    }

    fn open_fd(&self, rel: &[u8], flags: i32) -> Res<u64> {
        let p = cstr(&self.abspath(rel))?;
        // SAFETY: valid NUL-terminated path; the fd is owned by the kernel's file handle
        let fd = unsafe { libc::open(p.as_ptr(), flags | libc::O_CLOEXEC) };
        if fd < 0 {
            Err(last_errno())
        } else {
            Ok(fd as u64)
        }
    }

    fn rename_local(&self, from: &[u8], to: &[u8], flags: RenameFlags) -> Res<()> {
        let (f, t) = (cstr(&self.abspath(from))?, cstr(&self.abspath(to))?);
        // SAFETY: valid NUL-terminated paths; raw syscall since musl may lack the wrapper
        let rc = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                f.as_ptr(),
                libc::AT_FDCWD,
                t.as_ptr(),
                flags.bits(),
            )
        };
        check(rc as libc::c_int)?;
        self.inodes.lock().unwrap().rename(from, to);
        Ok(())
    }

    /// Rename of a placeholder: no bytes to move, so the engine does it.
    fn rename_placeholder(&self, from: &[u8], to: &[u8], flags: RenameFlags) -> Res<()> {
        if is_trash_target(to) {
            // glib/Nautilus trashes on the same fs by renaming into
            // .Trash-<uid>/files; translate it into the trash RPC
            return self.rpc("trash", &[from]);
        }
        let strs = [from, to].map(|p| std::str::from_utf8(p).map_err(|_| Errno::EINVAL));
        let (Ok(f), Ok(t)) = (strs[0], strs[1]) else {
            return Err(Errno::EINVAL);
        };
        match self.rpc.call("mv", &[f, t]) {
            Ok(_) => {
                self.inodes.lock().unwrap().rename(from, to);
                Ok(())
            }
            // offline / engine-gone / auth: report it, never fall back to a local op
            Err(e) if e.is_transport() => Err(e.errno()),
            // engine says the source is no longer a placeholder (race): fall back
            Err(e) if self.on_tree(from) => {
                log::info!("mv {f} -> {t}: {e}; materialized meanwhile, renaming locally");
                self.rename_local(from, to, flags)
            }
            Err(e) => {
                log::warn!("mv {f} -> {t}: {e}");
                Err(Errno::EIO)
            }
        }
    }

    fn setattr_local(&self, rel: &[u8], c: Changes) -> Res<FileAttr> {
        let Changes {
            mode,
            uid,
            gid,
            size,
            atime,
            mtime,
        } = c;
        let p = cstr(&self.abspath(rel))?;
        // SAFETY (all blocks below): valid NUL-terminated path, plain syscalls
        if let Some(mode) = mode {
            check(unsafe { libc::chmod(p.as_ptr(), (mode & 0o7777) as libc::mode_t) })?;
        }
        if uid.is_some() || gid.is_some() {
            // u32::MAX (-1) leaves that id unchanged
            check(unsafe {
                libc::chown(p.as_ptr(), uid.unwrap_or(u32::MAX), gid.unwrap_or(u32::MAX))
            })?;
        }
        if let Some(size) = size {
            check(unsafe { libc::truncate(p.as_ptr(), size as libc::off_t) })?;
        }
        if atime.is_some() || mtime.is_some() {
            let ts = [timespec_of(atime), timespec_of(mtime)];
            check(unsafe { libc::utimensat(libc::AT_FDCWD, p.as_ptr(), ts.as_ptr(), 0) })?;
        }
        self.fs_attrs(rel)
    }
}

// ---------------------------------------------------------------- filesystem

impl Filesystem for Fs {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let sh = &self.0;
        let res = (|| {
            let prel = sh.rel_of(parent)?;
            let name = name.as_bytes();
            match name {
                b"." => return sh.fs_attrs(&prel),
                b".." => return sh.fs_attrs(parent_rel(&prel)),
                _ if name.is_empty() || name.contains(&b'/') => return Err(Errno::ENOENT),
                _ => {}
            }
            let rel = join_rel(&prel, name);
            let attr = sh.fs_attrs(&rel)?;
            // recall-on-hover/prefetch (default off): any lookup of a placeholder
            // (hover, preview, a directory stat) queues a background download
            if attr.blocks == 0 && !sh.on_tree(&rel) && sh.prefetch.enabled() {
                sh.prefetch.schedule(&rel);
            }
            Ok(attr)
        })();
        match res {
            Ok(attr) => reply.entry(&TTL, &attr, GEN),
            Err(e) => reply.error(e),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        match self.0.rel_of(ino).and_then(|rel| self.0.fs_attrs(&rel)) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        }
    }

    fn setattr(
        &self,
        _req: &Request,
        ino: INodeNo,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        _fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<fuser::BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let rel = match self.0.rel_of(ino) {
            Ok(r) => r,
            Err(e) => return reply.error(e),
        };
        let done = |res: Res<FileAttr>, reply: ReplyAttr| match res {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        };
        let changes = Changes {
            mode,
            uid,
            gid,
            size,
            atime,
            mtime,
        };
        if self.0.on_tree(&rel) {
            return done(self.0.setattr_local(&rel, changes), reply);
        }
        if baseline::placeholder_of(&rel).is_none() {
            return reply.error(Errno::ENOENT);
        }
        // a placeholder has no bytes to change: materialize it first
        self.blocking(move |sh| {
            let res = sh
                .hydrate(&rel)
                .and_then(|()| sh.setattr_local(&rel, changes));
            done(res, reply);
        });
    }

    fn readlink(&self, _req: &Request, ino: INodeNo, reply: ReplyData) {
        match self
            .0
            .rel_of(ino)
            .and_then(|rel| std::fs::read_link(self.0.abspath(&rel)).map_err(errno_of))
        {
            Ok(target) => reply.data(target.as_os_str().as_bytes()),
            Err(e) => reply.error(e),
        }
    }

    fn mkdir(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        let sh = &self.0;
        let res = (|| {
            let rel = join_rel(&sh.rel_of(parent)?, name.as_bytes());
            let p = cstr(&sh.abspath(&rel))?;
            // SAFETY: valid NUL-terminated path
            check(unsafe { libc::mkdir(p.as_ptr(), mode as libc::mode_t) })?;
            sh.fs_attrs(&rel)
        })();
        match res {
            Ok(attr) => reply.entry(&TTL, &attr, GEN),
            Err(e) => reply.error(e),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let rel = match self.0.rel_of(parent) {
            Ok(p) => join_rel(&p, name.as_bytes()),
            Err(e) => return reply.error(e),
        };
        if self.0.on_tree(&rel) {
            return match std::fs::remove_file(self.0.abspath(&rel)) {
                Ok(()) => reply.ok(),
                Err(e) => reply.error(errno_of(e)),
            };
        }
        if baseline::placeholder_of(&rel).is_none() {
            return reply.error(Errno::ENOENT);
        }
        self.blocking(move |sh| match sh.rpc("trash", &[&rel]) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        });
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let res = self.0.rel_of(parent).and_then(|p| {
            std::fs::remove_dir(self.0.abspath(&join_rel(&p, name.as_bytes()))).map_err(errno_of)
        });
        match res {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn rename(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let sh = &self.0;
        let (from, to) = match (sh.rel_of(parent), sh.rel_of(newparent)) {
            (Ok(p), Ok(np)) => (
                join_rel(&p, name.as_bytes()),
                join_rel(&np, newname.as_bytes()),
            ),
            (Err(e), _) | (_, Err(e)) => return reply.error(e),
        };
        let done = |res: Res<()>, reply: ReplyEmpty| match res {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        };
        if sh.on_tree(&from) {
            return done(sh.rename_local(&from, &to, flags), reply);
        }
        if baseline::placeholder_of(&from).is_none() {
            return reply.error(Errno::ENOENT);
        }
        if flags.intersects(RenameFlags::RENAME_EXCHANGE | RenameFlags::RENAME_WHITEOUT) {
            return reply.error(Errno::EINVAL); // nothing on disk to exchange
        }
        if flags.contains(RenameFlags::RENAME_NOREPLACE) && sh.fs_attrs(&to).is_ok() {
            return reply.error(Errno::EEXIST);
        }
        self.blocking(move |sh| done(sh.rename_placeholder(&from, &to, flags), reply));
    }

    fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let rel = match self.0.rel_of(ino) {
            Ok(r) => r,
            Err(e) => return reply.error(e),
        };
        let done = |res: Res<u64>, reply: ReplyOpen| match res {
            Ok(fd) => reply.opened(FileHandle(fd), FopenFlags::empty()),
            Err(e) => reply.error(e),
        };
        if self.0.on_tree(&rel) {
            return done(self.0.open_fd(&rel, flags.0), reply);
        }
        if baseline::placeholder_of(&rel).is_none() {
            return reply.error(Errno::ENOENT);
        }
        self.blocking(move |sh| {
            let res = sh
                .hydrate(&rel)
                .and_then(|()| {
                    if sh.on_tree(&rel) {
                        Ok(())
                    } else {
                        Err(Errno::EIO)
                    }
                })
                .and_then(|()| sh.open_fd(&rel, flags.0));
            done(res, reply);
        });
    }

    fn read(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let mut buf = vec![0u8; size as usize];
        // SAFETY: fh is an fd this process opened; buf is valid for `size` bytes
        let n = unsafe {
            libc::pread(
                fh.0 as i32,
                buf.as_mut_ptr().cast(),
                buf.len(),
                offset as libc::off_t,
            )
        };
        if n < 0 {
            return reply.error(last_errno());
        }
        reply.data(&buf[..n as usize]);
    }

    fn write(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: WriteFlags,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        let mut written = 0usize;
        while written < data.len() {
            let rest = &data[written..];
            // SAFETY: fh is an fd this process opened; rest is a valid slice
            let n = unsafe {
                libc::pwrite(
                    fh.0 as i32,
                    rest.as_ptr().cast(),
                    rest.len(),
                    (offset + written as u64) as libc::off_t,
                )
            };
            match n {
                n if n < 0 => return reply.error(last_errno()),
                0 => return reply.error(Errno::EIO),
                n => written += n as usize,
            }
        }
        reply.written(written as u32);
    }

    /// close() is not a durability point: syncing here made every close through
    /// the mount 5-7x slower (even read-only ones). fsync/fdatasync pass through.
    fn flush(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _fh: FileHandle,
        _lock_owner: LockOwner,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn release(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        // SAFETY: fh is an fd this process opened and the kernel is done with it
        unsafe { libc::close(fh.0 as i32) };
        reply.ok();
    }

    fn fsync(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        datasync: bool,
        reply: ReplyEmpty,
    ) {
        let fd = fh.0 as i32;
        // SAFETY: fh is an fd this process opened
        let rc = unsafe {
            if datasync {
                libc::fdatasync(fd)
            } else {
                libc::fsync(fd)
            }
        };
        match check(rc) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        match self.0.rel_of(ino) {
            Ok(rel) => {
                let fh = self.0.next_dir_fh.fetch_add(1, Ordering::Relaxed);
                self.0.dirs.lock().unwrap().insert(fh, rel);
                reply.opened(FileHandle(fh), FopenFlags::empty());
            }
            Err(e) => reply.error(e),
        }
    }

    fn readdir(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        let sh = &self.0;
        let Some(rel) = sh.dirs.lock().unwrap().get(&fh.0).cloned() else {
            return reply.ok();
        };
        let mut names: Vec<Vec<u8>> = std::fs::read_dir(sh.abspath(&rel))
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .map(|e| e.file_name().as_bytes().to_vec())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        let mut entries: Vec<(Vec<u8>, Rel)> = vec![
            (b".".to_vec(), rel.clone()),
            (b"..".to_vec(), parent_rel(&rel).to_vec()),
        ];
        let mut seen: std::collections::HashSet<Vec<u8>> =
            entries.iter().map(|e| e.0.clone()).collect();
        for n in names {
            if n == b".Trash" || n.starts_with(b".Trash-") {
                continue; // gvfs trash dirs: passthrough but hidden
            }
            if seen.insert(n.clone()) {
                let child = join_rel(&rel, &n);
                entries.push((n, child));
            }
        }
        let mut remote = baseline::placeholder_children(&rel);
        remote.sort();
        for n in remote {
            let child = join_rel(&rel, &n);
            if seen.contains(&n) || sh.on_tree(&child) {
                continue;
            }
            seen.insert(n.clone());
            entries.push((n, child));
        }
        for (pos, (name, child)) in entries
            .into_iter()
            .enumerate()
            .map(|(i, e)| (i as u64 + 1, e))
        {
            if pos <= offset {
                continue;
            }
            let Ok(attr) = sh.fs_attrs(&child) else {
                continue;
            };
            if reply.add(attr.ino, pos, attr.kind, OsStr::from_bytes(&name)) {
                break;
            }
        }
        reply.ok();
    }

    fn releasedir(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        reply: ReplyEmpty,
    ) {
        self.0.dirs.lock().unwrap().remove(&fh.0);
        reply.ok();
    }

    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        let res = cstr(&self.0.tree).and_then(|p| {
            let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
            // SAFETY: valid path, st is a properly sized out-parameter
            check(unsafe { libc::statvfs(p.as_ptr(), &mut st) }).map(|()| st)
        });
        match res {
            Ok(st) => reply.statfs(
                st.f_blocks,
                st.f_bfree,
                st.f_bavail,
                st.f_files,
                st.f_ffree,
                st.f_bsize as u32,
                st.f_namemax as u32,
                st.f_frsize as u32,
            ),
            Err(e) => reply.error(e),
        }
    }

    fn create(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        flags: i32,
        reply: ReplyCreate,
    ) {
        let sh = &self.0;
        let res = (|| {
            let rel = join_rel(&sh.rel_of(parent)?, name.as_bytes());
            let p = cstr(&sh.abspath(&rel))?;
            // SAFETY: valid NUL-terminated path
            let fd = unsafe {
                libc::open(
                    p.as_ptr(),
                    flags | libc::O_CREAT | libc::O_CLOEXEC,
                    mode as libc::c_uint,
                )
            };
            if fd < 0 {
                return Err(last_errno());
            }
            match sh.fs_attrs(&rel) {
                Ok(attr) => Ok((fd as u64, attr)),
                Err(e) => {
                    // SAFETY: fd was just opened above and is not handed to the kernel
                    unsafe { libc::close(fd) };
                    Err(e)
                }
            }
        })();
        match res {
            Ok((fd, attr)) => reply.created(&TTL, &attr, GEN, FileHandle(fd), FopenFlags::empty()),
            Err(e) => reply.error(e),
        }
    }
}
