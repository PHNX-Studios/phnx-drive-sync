//! Client for the engine's RPC socket: one JSON line in, one JSON line out.
//!
//! A hydrate can legitimately take minutes for a large file, so the response
//! timeout is generous; the connect budget is short so a dead engine cannot
//! block an open forever (it maps to ENOTCONN).

use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use fuser::Errno;
use serde_json::{Value, json};

use crate::STOPPING;

#[derive(Debug)]
pub enum RpcError {
    /// The engine knows the network is down.
    Offline(String),
    /// The engine socket is absent, unresponsive or hung up.
    Unreachable(String),
    /// The engine session is invalid; never fall back to a local op.
    Auth(String),
    /// Any other engine-reported failure.
    Failed(String),
}

impl RpcError {
    /// The errno the kernel should report: never hang, never a bare EIO for
    /// a condition the user can act on.
    pub fn errno(&self) -> Errno {
        match self {
            RpcError::Offline(_) => Errno::from_i32(libc::ENETDOWN),
            RpcError::Unreachable(_) => Errno::from_i32(libc::ENOTCONN),
            RpcError::Auth(_) => Errno::EACCES,
            RpcError::Failed(_) => Errno::EIO,
        }
    }

    /// Offline / unreachable / auth: conditions where a local fallback is wrong.
    pub fn is_transport(&self) -> bool {
        !matches!(self, RpcError::Failed(_))
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Offline(m)
            | RpcError::Unreachable(m)
            | RpcError::Auth(m)
            | RpcError::Failed(m) => f.write_str(m),
        }
    }
}

pub struct Rpc {
    socket: PathBuf,
    connect_timeout: Duration,
    response_timeout: Duration,
    /// Last connectivity the engine reported (stamped on every response).
    offline: AtomicBool,
}

impl Rpc {
    pub fn new(socket: PathBuf) -> Self {
        Rpc {
            socket,
            connect_timeout: env_seconds(
                &[
                    "PHNX_DRIVE_SYNC_RPC_CONNECT_TIMEOUT_S",
                    "DRIVE_SYNC_RPC_CONNECT_TIMEOUT_S",
                ],
                10.0,
            ),
            response_timeout: env_seconds(
                &[
                    "PHNX_DRIVE_SYNC_RPC_RESPONSE_TIMEOUT_S",
                    "DRIVE_SYNC_RPC_RESPONSE_TIMEOUT_S",
                ],
                1800.0,
            ),
            offline: AtomicBool::new(false),
        }
    }

    pub fn engine_offline(&self) -> bool {
        self.offline.load(Ordering::Relaxed)
    }

    /// One request; blocks until the engine answers or a budget runs out.
    pub fn call(&self, op: &str, paths: &[&str]) -> Result<Value, RpcError> {
        let mut stream = self.connect()?;
        let mut payload = json!({ "op": op, "paths": paths }).to_string();
        payload.push('\n');
        let line = (|| {
            stream.set_write_timeout(Some(self.response_timeout))?;
            stream.write_all(payload.as_bytes())?;
            stream.set_read_timeout(Some(self.response_timeout))?;
            let mut line = Vec::new();
            BufReader::new(&stream).read_until(b'\n', &mut line)?;
            Ok::<_, std::io::Error>(line)
        })()
        .map_err(|e| match e.kind() {
            ErrorKind::WouldBlock | ErrorKind::TimedOut => RpcError::Unreachable(format!(
                "engine did not respond within {}s",
                self.response_timeout.as_secs_f64()
            )),
            _ => RpcError::Unreachable(format!("engine connection failed: {e}")),
        })?;
        if !line.ends_with(b"\n") {
            return Err(RpcError::Unreachable("engine closed the connection".into()));
        }
        let resp: Value = serde_json::from_slice(&line)
            .map_err(|e| RpcError::Failed(format!("malformed engine response: {e}")))?;
        self.offline.store(
            resp["offline"].as_bool().unwrap_or(false),
            Ordering::Relaxed,
        );
        if resp["ok"].as_bool() == Some(true) {
            return Ok(resp);
        }
        let msg = |fallback: &str| {
            resp["error"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback)
                .to_string()
        };
        Err(match resp["code"].as_str() {
            Some("offline") => RpcError::Offline(msg("offline")),
            Some("auth") => RpcError::Auth(msg("authentication required")),
            _ => RpcError::Failed(msg(&format!("{op} failed"))),
        })
    }

    /// Retry until the engine's socket accepts (it opens before the initial
    /// pass), but only within the connect budget.
    fn connect(&self) -> Result<UnixStream, RpcError> {
        let deadline = Instant::now() + self.connect_timeout;
        loop {
            if STOPPING.load(Ordering::Relaxed) {
                return Err(RpcError::Failed("sidecar is stopping".into()));
            }
            match UnixStream::connect(&self.socket) {
                Ok(s) => return Ok(s),
                Err(e) if Instant::now() >= deadline => {
                    return Err(RpcError::Unreachable(format!(
                        "engine socket unavailable: {} ({e})",
                        self.socket.display()
                    )));
                }
                Err(_) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    thread::sleep(left.min(Duration::from_millis(500)));
                }
            }
        }
    }
}

fn env_seconds(names: &[&str], default: f64) -> Duration {
    names
        .iter()
        .filter_map(|n| std::env::var(n).ok())
        .filter(|v| !v.is_empty())
        .find_map(|v| {
            v.trim()
                .parse::<f64>()
                .ok()
                .filter(|s| s.is_finite() && *s >= 0.0)
        })
        .map_or(Duration::from_secs_f64(default), Duration::from_secs_f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn serve_one(reply: &'static str) -> (tempdir::Dir, thread::JoinHandle<String>) {
        let dir = tempdir::Dir::new();
        let listener = UnixListener::bind(dir.path.join("rpc.sock")).unwrap();
        let h = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = String::new();
            BufReader::new(&s).read_line(&mut req).unwrap();
            s.write_all(reply.as_bytes()).unwrap();
            req
        });
        (dir, h)
    }

    fn client(dir: &tempdir::Dir) -> Rpc {
        let mut r = Rpc::new(dir.path.join("rpc.sock"));
        r.connect_timeout = Duration::from_millis(300);
        r.response_timeout = Duration::from_secs(2);
        r
    }

    #[test]
    fn request_shape_and_success() {
        let (dir, h) = serve_one("{\"ok\":true,\"offline\":true}\n");
        let rpc = client(&dir);
        rpc.call("hydrate", &["a/b.txt"]).unwrap();
        let req: Value = serde_json::from_str(&h.join().unwrap()).unwrap();
        assert_eq!(req, json!({"op": "hydrate", "paths": ["a/b.txt"]}));
        assert!(rpc.engine_offline());
    }

    #[test]
    fn error_classes_map_to_errnos() {
        for (reply, errno) in [
            (
                "{\"ok\":false,\"code\":\"offline\",\"offline\":true}\n",
                libc::ENETDOWN,
            ),
            (
                "{\"ok\":false,\"code\":\"auth\",\"error\":\"401\"}\n",
                libc::EACCES,
            ),
            (
                "{\"ok\":false,\"error\":\"missing baseline facts\"}\n",
                libc::EIO,
            ),
        ] {
            let (dir, _h) = serve_one(reply);
            let err = client(&dir).call("hydrate", &["a"]).unwrap_err();
            assert_eq!(err.errno().code(), errno, "{reply}");
        }
    }

    #[test]
    fn missing_socket_is_unreachable_within_the_budget() {
        let dir = tempdir::Dir::new();
        let started = Instant::now();
        let err = client(&dir).call("hydrate", &["a"]).unwrap_err();
        assert!(matches!(err, RpcError::Unreachable(_)), "{err:?}");
        assert_eq!(err.errno().code(), libc::ENOTCONN);
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn hang_up_without_reply_is_unreachable() {
        let (dir, _h) = serve_one("");
        let err = client(&dir).call("trash", &["a"]).unwrap_err();
        assert!(matches!(err, RpcError::Unreachable(_)), "{err:?}");
    }

    #[test]
    fn env_seconds_prefers_the_first_valid_name() {
        // SAFETY: test-local variable names, not read by any other test
        unsafe {
            std::env::set_var("PHNX_T_A", "nope");
            std::env::set_var("PHNX_T_B", "2.5");
        }
        assert_eq!(
            env_seconds(&["PHNX_T_A", "PHNX_T_B"], 9.0),
            Duration::from_millis(2500)
        );
        assert_eq!(env_seconds(&["PHNX_T_UNSET"], 9.0), Duration::from_secs(9));
    }

    /// Minimal self-cleaning temp dir (keeps the crate free of dev-deps).
    mod tempdir {
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU32, Ordering};

        pub struct Dir {
            pub path: PathBuf,
        }

        impl Dir {
            pub fn new() -> Self {
                static N: AtomicU32 = AtomicU32::new(0);
                let path = std::env::temp_dir().join(format!(
                    "phnx-rpc-test-{}-{}",
                    std::process::id(),
                    N.fetch_add(1, Ordering::Relaxed)
                ));
                std::fs::create_dir_all(&path).unwrap();
                Dir { path }
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
    }
}
