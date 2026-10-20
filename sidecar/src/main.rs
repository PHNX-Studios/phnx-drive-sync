//! FUSE sidecar for PHNX Drive Sync (files on demand).
//!
//! Serves the user-facing mount (--mount) from the real tree (--tree) plus the
//! sync baseline (--db, read-only); placeholders hydrate through the engine's
//! RPC socket (--rpc). A heartbeat file (--mount-ok, holding the pid) is
//! refreshed every 2s while mounted; the engine's mount monitor watches it.
//!
//! Must be spawned by the engine under systemd --user (unconfined): AppArmor's
//! fusermount3 profile cannot inherit a unix socket created under a snap
//! label, so a spawn from a confined shell fails with
//! "fusermount3: file descriptor N is not a socket".
//!
//! Offline policy: when the engine knows it is offline, a hydrate/mv/trash RPC
//! fails fast with a structured `code: "offline"` and maps to ENETDOWN rather
//! than EIO. A missing/unresponsive engine socket is bounded by a connect
//! budget and maps to ENOTCONN, so an open never blocks indefinitely.

mod baseline;
mod fs;
mod inodes;
mod prefetch;
mod rpc;

use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use fuser::{Config, MountOption, Session};
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

/// Set once the mount is going away: in-flight RPC retries and prefetch bail.
pub static STOPPING: AtomicBool = AtomicBool::new(false);

/// FUSE worker threads. Engine-bound ops run on their own threads, so these
/// only ever do local filesystem work.
const SESSION_THREADS: usize = 4;
const HEARTBEAT: Duration = Duration::from_secs(2);
/// How long a signalled shutdown waits for in-flight requests before exiting.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

struct Args {
    mount: PathBuf,
    tree: PathBuf,
    db: PathBuf,
    rpc: PathBuf,
    mount_ok: PathBuf,
}

fn parse_args() -> Result<Args, lexopt::Error> {
    use lexopt::prelude::*;
    let (mut mount, mut tree, mut db, mut rpc, mut mount_ok) = (None, None, None, None, None);
    let mut p = lexopt::Parser::from_env();
    while let Some(arg) = p.next()? {
        let slot: &mut Option<OsString> = match arg {
            Long("mount") => &mut mount,
            Long("tree") => &mut tree,
            Long("db") => &mut db,
            Long("rpc") => &mut rpc,
            Long("mount-ok") => &mut mount_ok,
            _ => return Err(arg.unexpected()),
        };
        *slot = Some(p.value()?);
    }
    let need = |v: Option<OsString>, name: &str| {
        v.map(PathBuf::from)
            .ok_or_else(|| lexopt::Error::from(format!("--{name} is required")))
    };
    Ok(Args {
        mount: need(mount, "mount")?,
        tree: need(tree, "tree")?,
        db: need(db, "db")?,
        rpc: need(rpc, "rpc")?,
        mount_ok: need(mount_ok, "mount-ok")?,
    })
}

// ---------------------------------------------------------------- logging

/// `<local time> sidecar <LEVEL> <message>` on stderr (the engine forwards it
/// to the journal), matching the Python sidecar's format.
struct StderrLog;

impl log::Log for StderrLog {
    fn enabled(&self, m: &log::Metadata<'_>) -> bool {
        // fuser logs every unimplemented op at warn: keep its noise at error
        m.level()
            <= if m.target().starts_with("fuser") {
                log::Level::Error
            } else {
                log::Level::Info
            }
    }

    fn log(&self, r: &log::Record<'_>) {
        if self.enabled(r.metadata()) {
            let _ = writeln!(
                std::io::stderr(),
                "{} sidecar {} {}",
                timestamp(),
                r.level(),
                r.args()
            );
        }
    }

    fn flush(&self) {}
}

fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as libc::time_t;
    // SAFETY: localtime_r writes into the zeroed tm we own
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02},{:03}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        now.subsec_millis()
    )
}

// ---------------------------------------------------------------- lifecycle

fn touch_mount_ok(path: &PathBuf) -> std::io::Result<()> {
    std::fs::write(path, std::process::id().to_string())
}

fn remove_mount_ok(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

fn main() -> ExitCode {
    let _ = log::set_logger(&StderrLog).map(|()| log::set_max_level(log::LevelFilter::Info));
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("phnx-drive-sync-fuse: {e}");
            eprintln!(
                "usage: phnx-drive-sync-fuse --mount DIR --tree DIR --db FILE --rpc SOCKET --mount-ok FILE"
            );
            return ExitCode::from(2);
        }
    };
    match run(args) {
        Ok(code) => code,
        Err(e) => {
            log::error!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: Args) -> Result<ExitCode, String> {
    // claim the signals before mounting, so an early SIGTERM is never fatal mid-mount
    let mut signals = Signals::new([SIGTERM, SIGINT]).map_err(|e| format!("signal setup: {e}"))?;
    baseline::init(args.db.clone())
        .map_err(|e| format!("cannot open {}: {e}", args.db.display()))?;
    std::fs::create_dir_all(&args.mount)
        .map_err(|e| format!("cannot create {}: {e}", args.mount.display()))?;

    let rpc = Arc::new(rpc::Rpc::new(args.rpc.clone()));
    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName("phnx-drive-sync".into()),
        MountOption::DefaultPermissions,
    ];
    config.n_threads = Some(SESSION_THREADS);
    let mut session = Session::new(fs::Fs::new(args.tree.clone(), rpc), &args.mount, &config)
        .map_err(|e| format!("mount {} failed: {e}", args.mount.display()))?;
    touch_mount_ok(&args.mount_ok)
        .map_err(|e| format!("cannot write {}: {e}", args.mount_ok.display()))?;
    log::info!(
        "mounted {} (tree={})",
        args.mount.display(),
        args.tree.display()
    );

    // heartbeat: stopped through the condvar so shutdown never waits out a tick
    let beat = Arc::new((Mutex::new(false), Condvar::new()));
    let heartbeat = {
        let (beat, path) = (Arc::clone(&beat), args.mount_ok.clone());
        thread::spawn(move || {
            let (lock, cv) = &*beat;
            let mut stop = lock.lock().unwrap();
            while !*stop {
                let _ = touch_mount_ok(&path);
                stop = cv.wait_timeout(stop, HEARTBEAT).unwrap().0;
            }
        })
    };

    // SIGTERM/SIGINT: stop RPC retries, then unmount, which ends session.run().
    // The unmount is lazy, so a caller blocked in a hydrate keeps the kernel
    // connection (and session.run()) alive; past a short grace period, exit
    // anyway: closing /dev/fuse aborts the connection and fails that caller.
    let caught = Arc::new(AtomicI32::new(0));
    let handle = signals.handle();
    {
        let (caught, mut unmounter) = (Arc::clone(&caught), session.unmount_callable());
        let mount_ok = args.mount_ok.clone();
        thread::spawn(move || {
            if let Some(sig) = signals.forever().next() {
                caught.store(sig, Ordering::SeqCst);
                STOPPING.store(true, Ordering::SeqCst);
                if let Err(e) = unmounter.unmount() {
                    log::warn!("unmount on signal failed: {e}");
                }
                thread::sleep(SHUTDOWN_GRACE);
                remove_mount_ok(&mount_ok);
                log::warn!(
                    "session still busy {}s after signal {sig}; exiting",
                    SHUTDOWN_GRACE.as_secs()
                );
                std::process::exit(128 + sig);
            }
        });
    }

    let result = session.run();
    STOPPING.store(true, Ordering::SeqCst);
    handle.close();
    *beat.0.lock().unwrap() = true;
    beat.1.notify_all();
    let _ = heartbeat.join();
    remove_mount_ok(&args.mount_ok);
    log::info!("unmounted {}", args.mount.display());

    // blocked engine calls may still hold threads; the exit ends them
    match caught.load(Ordering::SeqCst) {
        SIGTERM => Ok(ExitCode::from(143)),
        SIGINT => Ok(ExitCode::from(130)),
        _ => result
            .map(|()| ExitCode::SUCCESS)
            .map_err(|e| format!("session ended: {e}")),
    }
}
