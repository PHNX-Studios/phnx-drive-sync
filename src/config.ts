import { homedir } from 'node:os';
import path from 'node:path';

// Version lives in the repository root package.json (single source of truth),
// which also drives the package artifacts and `phnx-drive-sync version`.
export { APP_VERSION } from './version';
export const CLIENT_UID_PREFIX = 'syncengine';

/**
 * Read an environment override. The canonical prefix is `PHNX_DRIVE_SYNC_`; the
 * historical `DRIVE_SYNC_` names remain as aliases (the new name wins) so an
 * existing env file or script keeps working across the rename.
 */
export function envAlias(suffix: string): string | undefined {
    const v = process.env[`PHNX_DRIVE_SYNC_${suffix}`];
    return v !== undefined ? v : process.env[`DRIVE_SYNC_${suffix}`];
}

/** setTimeout fires immediately for delays above 2^31-1 ms, so every timer-fed knob is clamped to it. */
export const MAX_TIMER_MS = 2_147_483_647;

const stateHome = envAlias('HOME');
const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
const stateBase = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
/** Per-app data/state directory; matches the app, lib, config and unit names. */
const APP_DIR = 'phnx-drive-sync';
/** Pre-rename directory name, migrated once by the engine (see index.ts ensureLayout). */
const LEGACY_APP_DIR = 'drive-sync';
export const shareDir = stateHome ? path.join(stateHome, 'share') : path.join(dataHome, APP_DIR);
/** Mount point the user sees (Phase 2: served by the FUSE sidecar). */
export const localRoot = path.resolve(envAlias('ROOT') || path.join(homedir(), 'Proton Drive'));
/** Real on-disk tree: what scan/watcher/execute/filters operate on. */
export const treeRoot = path.resolve(envAlias('TREE') || path.join(shareDir, 'tree'));
export const remoteRootPath = (envAlias('REMOTE') || '').replace(/^\/+|\/+$/g, '');

export const stateDir = stateHome ? path.join(stateHome, 'state') : path.join(stateBase, APP_DIR);
export const stateDbPath = path.join(shareDir, 'state.db');
export const statusFile = path.join(stateDir, 'status.json');
export const logFile = path.join(stateDir, 'phnx-drive-sync.log');
export const lockFile = path.join(stateDir, 'daemon.lock');
export const rpcSocket = path.join(stateDir, 'rpc.sock');

/** Old state/data dirs, migrated once into the phnx-drive-sync layout; null under PHNX_DRIVE_SYNC_HOME. */
export const legacyShareDir = stateHome ? null : path.join(dataHome, LEGACY_APP_DIR);
export const legacyStateDir = stateHome ? null : path.join(stateBase, LEGACY_APP_DIR);

export const filtersFile = path.join(treeRoot, '.protonignore');
export const partialSuffix = '.drivesync.part';

export const modifyWindowMs = 1_500;
export const seedAdoptWindowMs = 10_000;
export const eventIdleTimeoutMs = Number(envAlias('EVENT_IDLE_MS') || 20_000);
export const watcherDebounceMs = 3_000;

/**
 * Safety-poll interval (ms). The inotify watcher is the fast path; when it is
 * missing, permanently crashed, or reports only partial coverage (watch limit),
 * the daemon falls back to a low-frequency incremental pass at this interval so
 * local edits still sync. While the watcher is healthy the poll stays silent.
 * 0 disables the safety net entirely (`PHNX_DRIVE_SYNC_POLL_MS=0`).
 */
export function watcherPollMs(): number {
    const v = Number(envAlias('POLL_MS') || 120_000);
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
    const v = Number(envAlias('SHUTDOWN_GRACE_MS') || 120_000);
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
    return (envAlias('NEW_FILES') ?? '').trim().toLowerCase() === 'online' ? 'online' : 'local';
}
/** Auto-evict threshold in GiB; 0 (default) disables auto-eviction entirely. */
export function evictFreeGb(): number {
    return Math.max(0, Number(envAlias('EVICT_FREE_GB') || 0));
}
/** Sidecar default for recall-on-hover/prefetch; `phnx-drive-sync.sh prefetch on|off` overrides via state.db meta. */
export function prefetchDefault(): boolean {
    return /^(1|on|true|yes)$/i.test((envAlias('PREFETCH') ?? '').trim());
}
/** Nautilus badges (metadata::emblems): on by default; `PHNX_DRIVE_SYNC_EMBLEMS=off` disables. */
export function emblemsEnabled(): boolean {
    return !/^(0|off|false|no)$/i.test((envAlias('EMBLEMS') ?? '').trim());
}

/**
 * Connectivity poll interval (ms). A cheap kernel-level link probe (default
 * route present + a non-loopback interface with carrier) runs at this cadence so
 * a known-offline placeholder open fails instantly instead of after the SDK's
 * retries. 0 disables the proactive probe (reactive fast-fail still applies).
 */
export function connectivityPollMs(): number {
    const v = Number(envAlias('CONNECTIVITY_POLL_MS') || 5000);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Boot reconnect backoff: first retry delay (ms) and ceiling (ms) while the API is unreachable. */
export function reconnectInitMinMs(): number {
    const v = Number(envAlias('RECONNECT_MIN_MS') || 5000);
    return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMER_MS) : 5000;
}

export function reconnectInitMaxMs(): number {
    const v = Number(envAlias('RECONNECT_MAX_MS') || 120_000);
    const min = reconnectInitMinMs();
    return Number.isFinite(v) && v >= min ? Math.min(v, MAX_TIMER_MS) : Math.max(min, 120_000);
}

/**
 * A hydrate (placeholder download) that receives no bytes for this long (ms,
 * default 60000) is aborted with ETIMEDOUT instead of hanging the open. 0 disables.
 */
export function hydrateStallMs(): number {
    const v = Number(envAlias('HYDRATE_STALL_MS') || 60_000);
    return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMER_MS) : 0;
}

/**
 * How long an op that arrives while the initial pass is still running waits for
 * it before failing with ENOTCONN (ms, default 120000).
 */
export function hydrateReadyWaitMs(): number {
    const v = Number(envAlias('HYDRATE_WAIT_MS') || 120_000);
    return Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_TIMER_MS) : 120_000;
}

/**
 * While waiting for the user to sign in, quietly re-read the credential store
 * this often (ms, default 15 minutes) so a keyring that unlocks late recovers
 * without a login. 0 disables the recheck (login / reload / Sync now only).
 */
export function authRecheckMs(): number {
    const v = Number(envAlias('AUTH_RECHECK_MS') || 15 * 60_000);
    return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMER_MS) : 0;
}

/** Minimum gap between dynamic offline transitions (ms). */
export function offlineNotifyCooldownMs(): number {
    const v = Number(envAlias('OFFLINE_NOTIFY_COOLDOWN_MS') || 30 * 60_000);
    return Number.isFinite(v) && v >= 0 ? v : 30 * 60_000;
}

export function isPartial(rel: string): boolean {
    return rel.endsWith(partialSuffix);
}
