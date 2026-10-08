/**
 * bun test preload: point the whole config surface (share dir, state.db, tree,
 * mount, log/status) at a throwaway home BEFORE any src/ module is imported —
 * config.ts reads the env once at module load.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'drive-sync-test-'));

process.env.DRIVE_SYNC_HOME = dir;
process.env.DRIVE_SYNC_ROOT = path.join(dir, 'mnt');
process.env.DRIVE_SYNC_TREE = path.join(dir, 'tree');
delete process.env.DRIVE_SYNC_NEW_FILES;
delete process.env.DRIVE_SYNC_EVICT_FREE_GB;
delete process.env.DRIVE_SYNC_PREFETCH;

process.on('exit', () => {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
});
