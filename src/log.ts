import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { logFile, prefetchDefault, statusFile } from './config';

mkdirSync(path.dirname(logFile), { recursive: true });
mkdirSync(path.dirname(statusFile), { recursive: true });

export interface StorageInfo {
    used: number;
    max: number;
    driveUsed: number;
    fetchedAt: string;
}

/** Live sync progress: the item being worked on and how far through the pass we are. */
export interface SyncProgress {
    /** Human-readable description of the current item (e.g. "Uploading photos/a.jpg"). */
    current: string;
    /** 1-based position of the current item; 0 while still scanning for changes. */
    done: number;
    /** Total items queued for this pass; 0 while still scanning for changes. */
    total: number;
}

export interface StatusShape {
    pid: number;
    state: string;
    lastPassAt: string | null;
    lastPassMs: number;
    lastError: string | null;
    eventsDrained: number;
    storage: StorageInfo | null;
    /** current item + item-count progress of the in-flight pass; null when idle */
    progress: SyncProgress | null;
    /** recall-on-hover/prefetch toggle (state.db meta override, else DRIVE_SYNC_PREFETCH) */
    prefetch: boolean;
    /** FUSE mount health: the sidecar can die while the engine keeps running */
    mount: 'ok' | 'degraded';
    counts: {
        tracked: number;
        uploads: number;
        downloads: number;
        deletes: number;
        renames: number;
        conflicts: number;
        errors: number;
        placeholders: number;
        reclaimable: number;
    };
}

export const status: StatusShape = {
    pid: process.pid,
    state: 'starting',
    lastPassAt: null,
    lastPassMs: 0,
    lastError: null,
    eventsDrained: 0,
    storage: null,
    progress: null,
    prefetch: prefetchDefault(),
    mount: 'ok',
    counts: { tracked: 0, uploads: 0, downloads: 0, deletes: 0, renames: 0, conflicts: 0, errors: 0, placeholders: 0, reclaimable: 0 },
};

export function setStatus(patch: Partial<StatusShape>): void {
    Object.assign(status, patch);
    try {
        const tmp = statusFile + '.tmp';
        writeFileSync(tmp, JSON.stringify(status, null, 2));
        renameSync(tmp, statusFile);
    } catch {
        /* status is best-effort */
    }
}

type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export function log(level: Level, msg: string, extra?: unknown): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}${extra === undefined ? '' : ' ' + safe(extra)}`;
    if (level !== 'DEBUG') console.log(line);
    try {
        appendFileSync(logFile, line + '\n');
    } catch {
        /* logging is best-effort */
    }
}

function safe(v: unknown): string {
    if (v instanceof Error) return v.stack || v.message;
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}
