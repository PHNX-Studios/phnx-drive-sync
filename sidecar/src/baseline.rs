//! Read-only view of the engine's sync baseline (state.db).
//!
//! The engine owns the database (WAL mode) and writes it concurrently, so
//! every thread keeps its own read-only connection with a busy timeout.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, OptionalExtension};

static DB_PATH: OnceLock<PathBuf> = OnceLock::new();

thread_local! {
    static CONN: RefCell<Option<Connection>> = const { RefCell::new(None) };
}

/// Baseline facts of a placeholder: remote size and mtime.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placeholder {
    pub size: u64,
    pub mtime_ns: i64,
}

/// Set the database path and check that it opens; call once at startup.
pub fn init(path: PathBuf) -> rusqlite::Result<()> {
    let _ = DB_PATH.set(path);
    with_conn(|_| Ok(()))
}

fn open() -> rusqlite::Result<Connection> {
    let path = DB_PATH.get().expect("baseline::init not called");
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(2))?;
    conn.pragma_update(None, "query_only", 1)?;
    Ok(conn)
}

fn with_conn<T>(f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
    CONN.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(open()?);
        }
        f(slot.as_ref().unwrap())
    })
}

/// Baseline facts for a marked (online-only) file, or None.
///
/// A database error reads as "not a placeholder": the tree stays authoritative
/// and the caller reports ENOENT rather than inventing attributes.
pub fn placeholder_of(rel: &[u8]) -> Option<Placeholder> {
    let rel = std::str::from_utf8(rel).ok()?; // baseline paths are always UTF-8
    let row = with_conn(|c| {
        c.prepare_cached(
            "SELECT s.rsize, s.rmtime FROM online o JOIN sync s ON s.path = o.path \
             WHERE o.path = ?1 AND s.type = 'file'",
        )?
        .query_row([rel], |r| {
            Ok((r.get::<_, Value>(0)?, r.get::<_, Value>(1)?))
        })
        .optional()
    });
    match row {
        Ok(Some((size, mtime))) => Some(Placeholder {
            size: size_of(&size),
            mtime_ns: mtime_ns_of(&mtime),
        }),
        Ok(None) => None,
        Err(e) => {
            log::warn!("baseline lookup failed: {e}");
            None
        }
    }
}

/// Names of the placeholders directly under `parent` ('' = root), unsorted.
pub fn placeholder_children(parent: &[u8]) -> Vec<Vec<u8>> {
    let Ok(parent) = std::str::from_utf8(parent) else {
        return Vec::new();
    };
    let prefix = if parent.is_empty() {
        String::new()
    } else {
        format!("{parent}/")
    };
    // ['<parent>/', '<parent>0') is exactly the paths under parent: '0' follows '/'
    let upper = if parent.is_empty() {
        None
    } else {
        Some(format!("{parent}0"))
    };
    let rows = with_conn(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT o.path FROM online o JOIN sync s ON s.path = o.path \
             WHERE s.type = 'file' AND o.path >= ?1 AND (?2 IS NULL OR o.path < ?2)",
        )?;
        stmt.query_map(rusqlite::params![prefix, upper], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
    });
    match rows {
        Ok(paths) => paths
            .into_iter()
            .filter_map(|p| {
                let name = p.strip_prefix(prefix.as_str())?;
                (!name.is_empty() && !name.contains('/')).then(|| name.as_bytes().to_vec())
            })
            .collect(),
        Err(e) => {
            log::warn!("baseline listing failed: {e}");
            Vec::new()
        }
    }
}

/// The `meta.prefetch` override: Some(true/false) when set, None when absent.
pub fn prefetch_override() -> Option<bool> {
    with_conn(|c| {
        c.prepare_cached("SELECT value FROM meta WHERE key = 'prefetch'")?
            .query_row([], |r| r.get::<_, String>(0))
            .optional()
    })
    .ok()
    .flatten()
    .map(|v| v == "on")
}

fn size_of(v: &Value) -> u64 {
    match *v {
        Value::Integer(i) => i.max(0) as u64,
        Value::Real(f) if f > 0.0 => f as u64,
        _ => 0,
    }
}

/// Baseline mtimes are epoch milliseconds (integer, occasionally fractional).
fn mtime_ns_of(v: &Value) -> i64 {
    match *v {
        Value::Integer(ms) => ms.saturating_mul(1_000_000),
        Value::Real(ms) => (ms * 1_000_000.0) as i64,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_mtime_is_exact() {
        assert_eq!(
            mtime_ns_of(&Value::Integer(1_700_000_000_123)),
            1_700_000_000_123_000_000
        );
    }

    #[test]
    fn null_facts_read_as_zero() {
        assert_eq!(size_of(&Value::Null), 0);
        assert_eq!(mtime_ns_of(&Value::Null), 0);
    }
}
