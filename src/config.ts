import { homedir } from 'node:os';
import path from 'node:path';

// Version lives in the repository root package.json (single source of truth),
// which also drives the package artifacts and `phnx-drive-sync version`.
export { APP_VERSION } from './version';
export const CLIENT_UID_PREFIX = 'syncengine';

const stateHome = process.env.DRIVE_SYNC_HOME;
const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
const stateBase = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
export const shareDir = stateHome ? path.join(stateHome, 'share') : path.join(dataHome, 'drive-sync');
/** Mount point the user sees (Phase 2: served by the FUSE sidecar). */
export const localRoot = path.resolve(process.env.DRIVE_SYNC_ROOT || path.join(homedir(), 'Proton Drive'));
/** Real on-disk tree: what scan/watcher/execute/filters operate on. */
export const treeRoot = path.resolve(process.env.DRIVE_SYNC_TREE || path.join(shareDir, 'tree'));
export const remoteRootPath = (process.env.DRIVE_SYNC_REMOTE || '').replace(/^\/+|\/+$/g, '');

export const stateDir = stateHome ? path.join(stateHome, 'state') : path.join(stateBase, 'drive-sync');
export const stateDbPath = path.join(shareDir, 'state.db');
export const statusFile = path.join(stateDir, 'status.json');
export const logFile = path.join(stateDir, 'drive-sync.log');
export const lockFile = path.join(stateDir, 'daemon.lock');
export const rpcSocket = path.join(stateDir, 'rpc.sock');

export const filtersFile = path.join(treeRoot, '.protonignore');
export const partialSuffix = '.drivesync.part';

export const modifyWindowMs = 1_500;
export const seedAdoptWindowMs = 10_000;
export const eventIdleTimeoutMs = Number(process.env.DRIVE_SYNC_EVENT_IDLE_MS || 20_000);
export const watcherDebounceMs = 3_000;

/**
 * Safety-poll interval (ms). The inotify watcher is the fast path; when it is
 * missing, permanently crashed, or reports only partial coverage (watch limit),
 * the daemon falls back to a low-frequency incremental pass at this interval so
 * local edits still sync. While the watcher is healthy the poll stays silent.
 * 0 disables the safety net entirely (`DRIVE_SYNC_POLL_MS=0`).
 */
export function watcherPollMs(): number {
    const v = Number(process.env.DRIVE_SYNC_POLL_MS || 120_000);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * How long shutdown waits for the in-flight sync pass to finish its current file
 * operation before unmounting and exiting (ms, default 120000). The pass stops
 * at the next action boundary once shutdown is requested, so this only bounds
 * the wait for the operation already running. Keep systemd's `TimeoutStopSec`
 * on phnx-drive-sync.service above this value so the graceful path wins.
 */
export function shutdownGraceMs(): number {
    const v = Number(process.env.DRIVE_SYNC_SHUTDOWN_GRACE_MS || 120_000);
    return Number.isFinite(v) && v >= 0 ? v : 120_000;
}

/**
 * Upper bound (ms) on how long the sliding watcher debounce may postpone a pass
 * while local writes keep arriving. Without it, one continuously-written file
 * (a log, a VM image) could starve every pass, including remote-triggered ones.
 */
export const watcherMaxDebounceMs = 30_000;

/** Newly-appeared remote files: `local` (default, download) or `online` (placeholder). Read per call so tests can flip it. */
export function newFilesMode(): 'local' | 'online' {
    return (process.env.DRIVE_SYNC_NEW_FILES ?? '').trim().toLowerCase() === 'online' ? 'online' : 'local';
}
/** Auto-evict threshold in GiB; 0 (default) disables auto-eviction entirely. */
export function evictFreeGb(): number {
    return Math.max(0, Number(process.env.DRIVE_SYNC_EVICT_FREE_GB || 0));
}
/** Sidecar default for recall-on-hover/prefetch; `drive-sync.sh prefetch on|off` overrides via state.db meta. */
export function prefetchDefault(): boolean {
    return /^(1|on|true|yes)$/i.test((process.env.DRIVE_SYNC_PREFETCH ?? '').trim());
}
/** Nautilus badges (metadata::emblems): on by default; `DRIVE_SYNC_EMBLEMS=off` disables. */
export function emblemsEnabled(): boolean {
    return !/^(0|off|false|no)$/i.test((process.env.DRIVE_SYNC_EMBLEMS ?? '').trim());
}

export function isPartial(rel: string): boolean {
    return rel.endsWith(partialSuffix);
}
