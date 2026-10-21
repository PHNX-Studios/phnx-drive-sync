/**
 * bun test preload: point the whole config surface (share dir, state.db, tree,
 * mount, log/status) at a throwaway home BEFORE any src/ module is imported —
 * config.ts reads the env once at module load.
 *
 * Ordering matters: clear every override (canonical and legacy spellings) FIRST,
 * then set the sandbox home. Clearing after setting would delete the sandbox and
 * the suite would open the developer's real state.db.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SUFFIXES = [
    'HOME',
    'ROOT',
    'TREE',
    'REMOTE',
    'NEW_FILES',
    'EVICT_FREE_GB',
    'PREFETCH',
    'POLL_MS',
    'SHUTDOWN_GRACE_MS',
    'EMBLEMS',
    'EVENT_IDLE_MS',
    'CONNECTIVITY_POLL_MS',
    'RECONNECT_MIN_MS',
    'RECONNECT_MAX_MS',
    'OFFLINE_NOTIFY_COOLDOWN_MS',
    'HYDRATE_STALL_MS',
    'HYDRATE_WAIT_MS',
    'AUTH_RECHECK_MS',
    'LIBDIR',
    'RELEASE_URL',
];

for (const suffix of SUFFIXES) {
    delete process.env[`PHNX_DRIVE_SYNC_${suffix}`];
    delete process.env[`DRIVE_SYNC_${suffix}`];
}

const dir = mkdtempSync(path.join(tmpdir(), 'phnx-drive-sync-test-'));
process.env.PHNX_DRIVE_SYNC_HOME = dir;
process.env.PHNX_DRIVE_SYNC_ROOT = path.join(dir, 'mnt');
process.env.PHNX_DRIVE_SYNC_TREE = path.join(dir, 'tree');

process.on('exit', () => {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
});
