import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

import { stateDbPath } from './config';

export type EntryType = 'file' | 'dir';

/**
 * Last-known-synced baseline. A row exists only when both sides are known:
 * files carry facts for both sides, folders carry nulls (existence only).
 * Rows are written exclusively by successful sync actions and adoptions.
 */
export interface SyncRow {
    path: string;
    uid: string | null;
    type: EntryType;
    lsize: number | null;
    lmtime: number | null;
    rsize: number | null;
    rmtime: number | null;
}

/**
 * Live remote view of the tree, maintained by the event stream and
 * replaced wholesale by full walks. Never used as a sync baseline.
 */
export interface CacheRow {
    path: string;
    uid: string;
    type: EntryType;
    size: number | null;
    mtime: number | null;
}

let db: Database | null = null;

export function openState(): Database {
    if (db) return db;
    mkdirSync(path.dirname(stateDbPath), { recursive: true });
    db = new Database(stateDbPath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS sync (
            path  TEXT PRIMARY KEY,
            uid   TEXT,
            type  TEXT NOT NULL,
            lsize INTEGER,
            lmtime INTEGER,
            rsize INTEGER,
            rmtime INTEGER
        );
        CREATE TABLE IF NOT EXISTS remote_cache (
            path  TEXT PRIMARY KEY,
            uid   TEXT NOT NULL,
            type  TEXT NOT NULL,
            size  INTEGER,
            mtime INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_remote_cache_uid ON remote_cache(uid);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    return db;
}

function q(sql: string) {
    return openState().query(sql);
}

// --- sync baseline ---

export function syncAll(): Map<string, SyncRow> {
    const rows = q('SELECT path, uid, type, lsize, lmtime, rsize, rmtime FROM sync').all() as SyncRow[];
    return new Map(rows.map((r) => [r.path, r]));
}

export function syncGet(p: string): SyncRow | undefined {
    return (q('SELECT path, uid, type, lsize, lmtime, rsize, rmtime FROM sync WHERE path = ?').get(p) as SyncRow | null) ?? undefined;
}

export function syncSet(r: SyncRow): void {
    q(
        `INSERT INTO sync (path, uid, type, lsize, lmtime, rsize, rmtime)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           uid=excluded.uid, type=excluded.type, lsize=excluded.lsize,
           lmtime=excluded.lmtime, rsize=excluded.rsize, rmtime=excluded.rmtime`,
    ).run(r.path, r.uid, r.type, r.lsize, r.lmtime, r.rsize, r.rmtime);
}

export function syncDel(p: string): void {
    q('DELETE FROM sync WHERE path = ?').run(p);
}

// --- remote cache ---

export function cacheAll(): CacheRow[] {
    return q('SELECT path, uid, type, size, mtime FROM remote_cache').all() as CacheRow[];
}

export function cacheGet(p: string): CacheRow | undefined {
    return (q('SELECT path, uid, type, size, mtime FROM remote_cache WHERE path = ?').get(p) as CacheRow | null) ?? undefined;
}

export function cacheSet(r: CacheRow): void {
    q(
        `INSERT INTO remote_cache (path, uid, type, size, mtime)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET uid=excluded.uid, type=excluded.type, size=excluded.size, mtime=excluded.mtime`,
    ).run(r.path, r.uid, r.type, r.size, r.mtime);
}

export function cacheDel(p: string): void {
    q('DELETE FROM remote_cache WHERE path = ?').run(p);
}

export function cacheRename(from: string, to: string): void {
    const row = cacheGet(from);
    if (!row) return;
    cacheDel(from);
    cacheSet({ ...row, path: to });
}

export function cacheReplaceAll(rows: CacheRow[]): void {
    const d = openState();
    d.transaction(() => {
        d.query('DELETE FROM remote_cache').run();
        const ins = d.query('INSERT INTO remote_cache (path, uid, type, size, mtime) VALUES (?, ?, ?, ?, ?)');
        for (const r of rows) ins.run(r.path, r.uid, r.type, r.size, r.mtime);
    })();
}

// --- meta ---

export function metaGet(key: string): string | null {
    const row = q('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
}

export function metaSet(key: string, value: string): void {
    q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
