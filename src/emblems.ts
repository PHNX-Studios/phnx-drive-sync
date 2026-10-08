import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { emblemsEnabled, localRoot } from './config';
import { log } from './log';
import * as st from './state';

/**
 * Nautilus file badges via the gvfs metadata store (`metadata::emblems` keyword list
 * -> `emblem-<keyword>` icon). Online-only files get the cloud, materialized files the
 * star. state.db is the source of truth; the `emblem` table remembers what was last
 * applied so restarts and no-op passes spawn nothing.
 *
 * Notes for the next reader:
 * - `gio set` must run WITHOUT GIO_MODULE_DIR (the VS Code snap points it at a private
 *   cache without libgvfsdbus.so, which is the gvfs half that serves `metadata::`).
 * - Emblems are keyed by the mount path the user's Nautilus sees (localRoot), not the
 *   real tree; gvfs stores them by path, so a badge set while the mount is down still
 *   appears once the mount is back.
 * - Nautilus has no live-refresh for metadata: badges appear after F5 / re-entering
 *   the folder.
 */
export function emblemFor(type: st.EntryType, online: boolean): string | null {
    if (type !== 'file') return null; // no badges on folders
    return online ? 'cloud' : 'favorite';
}

/** Desired badge per synced path (files only). */
export function desiredEmblems(): Map<string, string> {
    const desired = new Map<string, string>();
    const online = st.onlineAll();
    for (const [p, row] of st.syncAll()) {
        const kw = emblemFor(row.type, online.has(p));
        if (kw) desired.set(p, kw);
    }
    return desired;
}

export type ApplyResult = 'ok' | 'skip' | 'fail';
export type ApplyFn = (rel: string, keyword: string | null) => Promise<ApplyResult>;

const assetSource = path.join(import.meta.dir, '..', 'assets', 'emblem-cloud.svg');
const iconDestDir = path.join(homedir(), '.local', 'share', 'icons', 'hicolor', 'scalable', 'emblems');

/** Keep the custom cloud badge present in the user's icon theme (Nautilus resolves `emblem-cloud` there). */
export function ensureEmblemIcon(): void {
    try {
        if (!existsSync(assetSource)) return;
        mkdirSync(iconDestDir, { recursive: true });
        const dest = path.join(iconDestDir, 'emblem-cloud.svg');
        if (existsSync(dest) && readFileSync(dest).equals(readFileSync(assetSource))) return;
        copyFileSync(assetSource, dest);
        // the cached theme index would hide the new file until someone refreshes it
        try {
            rmSync(path.join(homedir(), '.local', 'share', 'icons', 'hicolor', 'icon-theme.cache'), { force: true });
        } catch {
            /* ignore */
        }
        log('INFO', `installed Nautilus badge icon ${dest}`);
    } catch (e) {
        log('WARN', `could not install emblem icon: ${e instanceof Error ? e.message : String(e)}`);
    }
}

let gioMissing = false;

async function gioApply(rel: string, keyword: string | null): Promise<ApplyResult> {
    const abs = path.join(localRoot, rel);
    if (!existsSync(abs)) {
        // mount down or the file is gone: nothing for Nautilus to badge either way
        return keyword === null ? 'ok' : 'skip';
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    delete env.GIO_MODULE_DIR;
    delete env.GIO_EXTRA_MODULES;
    const cmd = keyword
        ? ['gio', 'set', '-t', 'stringv', abs, 'metadata::emblems', keyword]
        : ['gio', 'set', '-d', abs, 'metadata::emblems'];
    try {
        const code = await new Promise<number>((resolve) => {
            const child = spawn(cmd[0], cmd.slice(1), { env, stdio: ['ignore', 'ignore', 'ignore'] });
            child.on('error', () => resolve(127));
            child.on('close', (c) => resolve(c ?? 1));
        });
        if (code === 127 && !gioMissing) {
            gioMissing = true;
            log('ERROR', 'gio not found; Nautilus badges disabled until it is available');
        }
        return code === 0 ? 'ok' : 'fail';
    } catch {
        return 'fail';
    }
}

export interface EmblemStats {
    set: number;
    unset: number;
    failed: number;
    skipped: number;
}

/** Apply the diff between desired badges and what state.db says was last applied. */
export async function syncEmblems(apply: ApplyFn = gioApply): Promise<EmblemStats> {
    const desired = desiredEmblems();
    const stored = st.emblemAll();
    const jobs: { p: string; kw: string | null }[] = [];
    for (const [p, kw] of desired) if (stored.get(p) !== kw) jobs.push({ p, kw });
    for (const p of stored.keys()) if (!desired.has(p)) jobs.push({ p, kw: null });

    const stats: EmblemStats = { set: 0, unset: 0, failed: 0, skipped: 0 };
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= jobs.length) return;
            const { p, kw } = jobs[i];
            const res = await apply(p, kw);
            if (res === 'ok') {
                if (kw) {
                    st.emblemPut(p, kw);
                    stats.set++;
                } else {
                    st.emblemRemove(p);
                    stats.unset++;
                }
            } else if (res === 'fail') stats.failed++;
            else stats.skipped++;
        }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return stats;
}

async function runEmblems(): Promise<void> {
    ensureEmblemIcon();
    const s = await syncEmblems();
    if (s.set > 0 || s.unset > 0 || s.failed > 0) {
        log('INFO', `emblems: set=${s.set} unset=${s.unset} failed=${s.failed} skipped=${s.skipped}`);
    }
}

let running = false;
let queued = false;

/** Serialized kick: safe to call after every pass/RPC; overlapping requests coalesce. */
export function kickEmblems(): void {
    if (!emblemsEnabled() || gioMissing) return;
    if (running) {
        queued = true;
        return;
    }
    running = true;
    void (async () => {
        try {
            do {
                queued = false;
                await runEmblems();
            } while (queued && !gioMissing);
        } catch (e) {
            log('ERROR', 'emblem sync failed', e);
        } finally {
            running = false;
        }
    })();
}

/** One-shot run (CLI `once` mode): same work, awaited before exit. */
export async function syncEmblemsOnce(): Promise<void> {
    if (!emblemsEnabled() || gioMissing) return;
    await runEmblems();
}
