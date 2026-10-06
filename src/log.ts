import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { logFile, statusFile } from './config';

mkdirSync(path.dirname(logFile), { recursive: true });
mkdirSync(path.dirname(statusFile), { recursive: true });

export interface StorageInfo {
    used: number;
    max: number;
    driveUsed: number;
    fetchedAt: string;
}

export interface StatusShape {
    pid: number;
    state: string;
    lastPassAt: string | null;
    lastPassMs: number;
    lastError: string | null;
    eventsDrained: number;
    storage: StorageInfo | null;
    counts: {
        tracked: number;
        uploads: number;
        downloads: number;
        deletes: number;
        renames: number;
        conflicts: number;
        errors: number;
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
    counts: { tracked: 0, uploads: 0, downloads: 0, deletes: 0, renames: 0, conflicts: 0, errors: 0 },
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
