import { homedir } from 'node:os';
import path from 'node:path';

export const APP_VERSION = 'external-drive-syncengine@0.1.0-alpha';
export const CLIENT_UID_PREFIX = 'syncengine';

export const localRoot = path.resolve(process.env.DRIVE_SYNC_ROOT || path.join(homedir(), 'Proton Drive'));
export const remoteRootPath = (process.env.DRIVE_SYNC_REMOTE || '').replace(/^\/+|\/+$/g, '');

const stateHome = process.env.DRIVE_SYNC_HOME;
export const shareDir = stateHome ? path.join(stateHome, 'share') : path.join(homedir(), '.local', 'share', 'drive-sync');
export const stateDir = stateHome ? path.join(stateHome, 'state') : path.join(homedir(), '.local', 'state', 'drive-sync');
export const stateDbPath = path.join(shareDir, 'state.db');
export const statusFile = path.join(stateDir, 'status.json');
export const logFile = path.join(stateDir, 'drive-sync.log');
export const lockFile = path.join(stateDir, 'daemon.lock');

export const filtersFile = path.join(localRoot, '.protonignore');
export const partialSuffix = '.drivesync.part';

export const passIntervalMs = Number(process.env.DRIVE_SYNC_INTERVAL_MS || 60_000);
export const fullWalkEvery = Math.max(1, Number(process.env.DRIVE_SYNC_FULL_EVERY || 10));
export const modifyWindowMs = 1_500;
export const seedAdoptWindowMs = 10_000;
export const eventIdleTimeoutMs = Number(process.env.DRIVE_SYNC_EVENT_IDLE_MS || 20_000);
export const watcherDebounceMs = 3_000;

export function isPartial(rel: string): boolean {
    return rel.endsWith(partialSuffix);
}
