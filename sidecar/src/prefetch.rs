//! Recall-on-hover / prefetch (default off).
//!
//! When enabled, a lookup of a placeholder queues a background hydrate instead
//! of waiting for an open. Bounded so a listing of a big folder cannot flood
//! the engine with parallel downloads; dropped (never queued) while offline,
//! since the open path already fails fast and a reconnect-flood of downloads is
//! worse than a missed hover recall.

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;

use crate::STOPPING;
use crate::baseline;
use crate::rpc::{Rpc, RpcError};

pub const PREFETCH_MAX: usize = 2;

pub struct Prefetch {
    rpc: Arc<Rpc>,
    env_default: bool,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    queue: VecDeque<String>,
    inflight: HashSet<String>,
}

impl Prefetch {
    pub fn new(rpc: Arc<Rpc>) -> Arc<Self> {
        Arc::new(Prefetch {
            rpc,
            env_default: env_default(),
            state: Mutex::default(),
        })
    }

    /// state.db `meta.prefetch` override, else the PHNX_DRIVE_SYNC_PREFETCH env
    /// default (the legacy DRIVE_SYNC_PREFETCH name still works). Read on every
    /// lookup so a toggle takes effect without a restart.
    pub fn enabled(&self) -> bool {
        baseline::prefetch_override().unwrap_or(self.env_default)
    }

    pub fn schedule(self: &Arc<Self>, rel: &[u8]) {
        if self.rpc.engine_offline() || STOPPING.load(Ordering::Relaxed) {
            return;
        }
        // placeholders are UTF-8 (their paths come from the baseline)
        let Ok(rel) = std::str::from_utf8(rel) else {
            return;
        };
        let mut st = self.state.lock().unwrap();
        if st.inflight.contains(rel) || st.queue.iter().any(|q| q == rel) {
            return;
        }
        st.queue.push_back(rel.to_string());
        self.pump(&mut st);
    }

    fn pump(self: &Arc<Self>, st: &mut State) {
        while st.inflight.len() < PREFETCH_MAX && !STOPPING.load(Ordering::Relaxed) {
            let Some(rel) = st.queue.pop_front() else {
                break;
            };
            st.inflight.insert(rel.clone());
            let me = Arc::clone(self);
            thread::spawn(move || me.job(rel));
        }
    }

    fn job(self: Arc<Self>, rel: String) {
        match self.rpc.call("hydrate", &[&rel]) {
            Ok(_) => log::info!("prefetch: {rel} materialized"),
            // the open path reports these; a hover is not worth a warning
            Err(RpcError::Offline(_) | RpcError::Auth(_) | RpcError::Unreachable(_)) => {}
            Err(e) => log::warn!("prefetch: {rel} failed: {e}"),
        }
        let mut st = self.state.lock().unwrap();
        st.inflight.remove(&rel);
        self.pump(&mut st);
    }
}

fn env_default() -> bool {
    let raw = std::env::var("PHNX_DRIVE_SYNC_PREFETCH")
        .or_else(|_| std::env::var("DRIVE_SYNC_PREFETCH"))
        .unwrap_or_default();
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "on" | "true" | "yes"
    )
}
