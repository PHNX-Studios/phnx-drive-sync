import { homedir } from 'node:os';
import path from 'node:path';

export const APP_VERSION = 'external-drive-syncengine@0.1.0-alpha';
export const CLIENT_UID_PREFIX = 'syncengine';

const stateHome = process.env.DRIVE_SYNC_HOME;
export const shareDir = stateHome ? path.join(stateHome, 'share') : path.join(homedir(), '.local', 'share', 'drive-sync');
/** Mount point the user sees (Phase 2: served by the FUSE sidecar). */
export const localRoot = path.resolve(process.env.DRIVE_SYNC_ROOT || path.join(homedir(), 'Proton Drive'));
/** Real on-disk tree: what scan/watcher/execute/filters operate on. */
export const treeRoot = path.resolve(process.env.DRIVE_SYNC_TREE || path.join(shareDir, 'tree'));
export const remoteRootPath = (process.env.DRIVE_SYNC_REMOTE || '').replace(/^\/+|\/+$/g, '');

export const stateDir = stateHome ? path.join(stateHome, 'state') : path.join(homedir(), '.local', 'state', 'drive-sync');
export const stateDbPath = path.join(shareDir, 'state.db');
export const statusFile = path.join(stateDir, 'status.json');
export const logFile = path.join(stateDir, 'drive-sync.log');
export const lockFile = path.join(stateDir, 'daemon.lock');
export const rpcSocket = path.join(stateDir, 'rpc.sock');

export const filtersFile = path.join(treeRoot, '.protonignore');
export const partialSuffix = '.drivesync.part';

export const passIntervalMs = Number(process.env.DRIVE_SYNC_INTERVAL_MS || 60_000);
export const fullWalkEvery = Math.max(1, Number(process.env.DRIVE_SYNC_FULL_EVERY || 10));
export const modifyWindowMs = 1_500;
export const seedAdoptWindowMs = 10_000;
export const eventIdleTimeoutMs = Number(process.env.DRIVE_SYNC_EVENT_IDLE_MS || 20_000);
export const watcherDebounceMs = 3_000;

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
