import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { treeRoot } from '../src/config';
import * as st from '../src/state';

/**
 * Wipe every table: the daemon and all test files share one state.db per run
 * (state.ts caches the connection, and config resolved the temp home at import).
 */
export function resetState(): void {
    const db = st.openState();
    for (const table of ['sync', 'online', 'pinned', 'remote_cache', 'meta', 'emblem']) {
        db.query(`DELETE FROM ${table}`).run();
    }
}

/** Insert a baseline row with Phase-1 defaults (steady file facts unless overridden). */
export function seedRow(over: Partial<st.SyncRow> & { path: string }): st.SyncRow {
    const row: st.SyncRow = { uid: null, type: 'file', lsize: null, lmtime: null, rsize: null, rmtime: null, ...over };
    st.syncSet(row);
    return row;
}

export interface Seeded {
    rel: string;
    abs: string;
    size: number;
    mtimeMs: number;
}

/**
 * Materialized, clean, steady file: on disk under the temp tree with a baseline
 * row that mirrors its actual bytes — the evict candidate shape.
 */
export function seedLocalFile(
    rel: string,
    content: string | Buffer,
    opts: { keep?: boolean; online?: boolean; uid?: string } = {},
): Seeded {
    const abs = path.join(treeRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const s = statSync(abs);
    seedRow({ path: rel, uid: opts.uid ?? `uid:${rel}`, type: 'file', lsize: s.size, lmtime: s.mtimeMs, rsize: s.size, rmtime: s.mtimeMs });
    if (opts.online) st.onlineSet(rel);
    if (opts.keep) st.pinnedSet(rel);
    return { rel, abs, size: s.size, mtimeMs: s.mtimeMs };
}

/** Make a seeded file dirty: local bytes drift from the baseline (unsynced edit). */
export function mutate(seeded: Seeded): void {
    writeFileSync(seeded.abs, Buffer.alloc(seeded.size + 1, 0x61)); // +1 byte, new mtime
    statSync(seeded.abs);
}
