import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

import { modifyWindowMs, stateDbPath } from './config';

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
        CREATE TABLE IF NOT EXISTS online (
            path   TEXT PRIMARY KEY,
            pinned INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS pinned (path TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS emblem (path TEXT PRIMARY KEY, keyword TEXT NOT NULL);
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
    // choke point: dropping a baseline row also drops its online-only marker
    // and its "keep on this device" mark (no orphans by construction)
    q('DELETE FROM online WHERE path = ?').run(p);
    q('DELETE FROM pinned WHERE path = ?').run(p);
}

/** Row-only rename (baseline + online-only marker + pinned mark ride together; zero fs ops). */
export function syncRename(from: string, to: string, uid?: string | null): void {
    const row = syncGet(from);
    if (!row) return;
    const pinned = onlineGet(from);
    const keep = pinnedHas(from);
    syncDel(from);
    syncSet({ ...row, path: to, uid: uid === undefined ? row.uid : uid });
    if (pinned !== null) onlineSet(to, pinned);
    if (keep) pinnedSet(to);
}

// --- online-only markers (dehydrated files: content absent locally) ---

export function onlineAll(): Map<string, number> {
    const rows = q('SELECT path, pinned FROM online').all() as { path: string; pinned: number }[];
    return new Map(rows.map((r) => [r.path, r.pinned]));
}

export function onlineGet(p: string): number | null {
    const row = q('SELECT pinned FROM online WHERE path = ?').get(p) as { pinned: number } | null;
    return row ? row.pinned : null;
}

export function onlineSet(p: string, pinned = 0): void {
    q('INSERT INTO online (path, pinned) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET pinned=excluded.pinned').run(p, pinned);
}

export function onlineDel(p: string): void {
    q('DELETE FROM online WHERE path = ?').run(p);
}

export function onlineHas(p: string): boolean {
    return q('SELECT 1 FROM online WHERE path = ?').get(p) !== null;
}

export function onlineCount(): number {
    const row = q('SELECT COUNT(*) AS n FROM online').get() as { n: number };
    return row.n;
}

/** Defensive prune: drop markers whose baseline row is gone (syncDel is the primary dropper). */
export function onlinePrune(): number {
    const res = q('DELETE FROM online WHERE path NOT IN (SELECT path FROM sync)').run();
    return Number(res.changes);
}

/**
 * "Keep on this device": files auto-eviction must never touch. Independent of the
 * online table on purpose — an online row disappears when the file is recalled,
 * while the keep-mark must survive materialization (Phase 3).
 */
export function pinnedHas(p: string): boolean {
    return q('SELECT 1 FROM pinned WHERE path = ?').get(p) !== null;
}

export function pinnedAll(): string[] {
    const rows = q('SELECT path FROM pinned').all() as { path: string }[];
    return rows.map((r) => r.path);
}

export function pinnedSet(p: string): void {
    q('INSERT OR IGNORE INTO pinned (path) VALUES (?)').run(p);
}

export function pinnedDel(p: string): void {
    q('DELETE FROM pinned WHERE path = ?').run(p);
}

/** Defensive prune: drop keep-marks whose baseline row is gone (syncDel is the primary dropper). */
export function pinnedPrune(): number {
    const res = q('DELETE FROM pinned WHERE path NOT IN (SELECT path FROM sync)').run();
    return Number(res.changes);
}

/**
 * Bytes "Free up space" could still reclaim: steady baseline rows that are neither
 * online-only nor keep-marked (a not-yet-synced local edit counts — unpin runs a
 * pass first and then frees it). One query, no stat walk: the tray polls this.
 */
export function reclaimableBytes(): number {
    const row = q(
        `SELECT COALESCE(SUM(lsize), 0) AS n FROM sync
         WHERE type = 'file' AND lsize IS NOT NULL AND rsize IS NOT NULL
           AND lmtime IS NOT NULL AND rmtime IS NOT NULL
           AND ABS(lsize - rsize) <= ? AND ABS(lmtime - rmtime) <= ?
           AND path NOT IN (SELECT path FROM online)
           AND path NOT IN (SELECT path FROM pinned)`,
    ).get(modifyWindowMs, modifyWindowMs) as { n: number };
    return Number(row.n);
}

// --- nautilus badges (metadata::emblems last applied per path) ---

export function emblemAll(): Map<string, string> {
    const rows = q('SELECT path, keyword FROM emblem').all() as { path: string; keyword: string }[];
    return new Map(rows.map((r) => [r.path, r.keyword]));
}

export function emblemPut(p: string, keyword: string): void {
    q('INSERT INTO emblem (path, keyword) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET keyword=excluded.keyword').run(p, keyword);
}

export function emblemRemove(p: string): void {
    q('DELETE FROM emblem WHERE path = ?').run(p);
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
