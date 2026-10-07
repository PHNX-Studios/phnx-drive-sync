import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

import { lockFile, localRoot, passIntervalMs, stateDir, statusFile } from './config';
import { loadFilters } from './filters';
import { log, setStatus, status } from './log';
import * as remote from './remote';
import { rpcClient, startRpcServer, stopRpcServer, type PinResult } from './rpc';
import * as st from './state';
import { fileEq, runPass, steady } from './sync';
import { startWatcher } from './watcher';

let lockHeld = false;
let syncNowHook: (() => void) | null = null;

// Consumed so SIGUSR1 never kills the process (e.g. before the daemon hook exists).
process.on('SIGUSR1', () => syncNowHook?.());

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function acquireLock(): void {
    const attempt = (allowStale: boolean): void => {
        try {
            const fd = openSync(lockFile, 'wx');
            writeSync(fd, String(process.pid));
            closeSync(fd);
            lockHeld = true;
        } catch {
            let pid: number | null = null;
            try {
                pid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10) || null;
            } catch {
                pid = null;
            }
            if (pid && isAlive(pid)) throw new Error(`another instance is already running (pid ${pid})`);
            if (!allowStale) throw new Error(`lock file is stuck: ${lockFile}`);
            try {
                unlinkSync(lockFile);
            } catch {
                /* ignore */
            }
            attempt(false);
        }
    };
    attempt(true);
}

function releaseLock(): void {
    if (!lockHeld) return;
    lockHeld = false;
    try {
        unlinkSync(lockFile);
    } catch {
        /* ignore */
    }
}

async function main(): Promise<void> {
    const mode = process.argv[2] ?? 'run';

    if (mode === 'status') {
        try {
            console.log(readFileSync(statusFile, 'utf8'));
        } catch {
            console.log(JSON.stringify({ state: 'unknown' }));
        }
        return;
    }
    if (mode === 'pin' || mode === 'unpin') {
        // client of the running daemon: no lock, no remote connection
        process.exitCode = await rpcClient(mode, process.argv.slice(3));
        return;
    }
    const dryRun = process.argv.includes('--dry-run');
    if (mode !== 'run' && mode !== 'once') {
        console.error('usage: drive-sync [run|once [--dry-run]|status|pin <path>...|unpin <path>...]');
        process.exitCode = 64;
        return;
    }
    if (dryRun && mode !== 'once') {
        console.error('--dry-run is only valid with once');
        process.exitCode = 64;
        return;
    }

    mkdirSync(localRoot, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    st.openState();
    loadFilters();

    acquireLock();
    try {
        await remote.initRemote();
        if (mode === 'once') {
            const s = await runPass({ forceFull: true, dry: dryRun });
            setStatus({ state: dryRun ? 'stopped' : 'idle' });
            process.exitCode = s.authFailed ? 3 : s.errors > 0 ? 2 : 0;
        } else {
            await daemon();
        }
    } finally {
        await remote.shutdownRemote();
        releaseLock();
    }
    process.exit(process.exitCode ?? 0);
}

function absOf(p: string): string {
    return p === '' ? localRoot : `${localRoot}/${p}`;
}

/** Expand requested paths to the file rows they cover (files only; dirs expand recursively). */
function expandTargets(reqs: string[], rows: Map<string, st.SyncRow>): { targets: string[]; notes: PinResult[] } {
    const targets: string[] = [];
    const notes: PinResult[] = [];
    for (const req of reqs) {
        const hits: string[] = [];
        for (const [rp, row] of rows) {
            if (row.type === 'file' && (rp === req || rp.startsWith(req + '/'))) hits.push(rp);
        }
        if (hits.length > 0) targets.push(...hits);
        else if (rows.has(req)) notes.push({ path: req, ok: true, note: 'nothing to do' });
        else notes.push({ path: req, ok: false, note: 'no such synced file or folder' });
    }
    return { targets: [...new Set(targets)], notes };
}

async function unpinFiles(reqs: string[], ensureFresh: () => Promise<void>): Promise<PinResult[]> {
    const rows = st.syncAll();
    const { targets, notes } = expandTargets(reqs, rows);
    const results: PinResult[] = [...notes];
    const already: string[] = [];
    const absent: string[] = [];
    const clean: string[] = [];
    let dirty: string[] = [];

    for (const p of targets) {
        const marked = st.onlineGet(p) !== null;
        let size = -1;
        let mtimeMs = -1;
        let present = false;
        try {
            const s = statSync(absOf(p));
            size = s.size;
            mtimeMs = s.mtimeMs;
            present = true;
        } catch {
            present = false;
        }
        if (!present) {
            if (marked) already.push(p);
            else absent.push(p);
            continue;
        }
        if (marked) {
            clean.push(p); // resume an interrupted unpin: content was verified before the marker was set
            continue;
        }
        const row = rows.get(p)!;
        const fileClean = row.lsize !== null && row.lmtime !== null && fileEq(size, mtimeMs, row.lsize, row.lmtime);
        if (fileClean && steady(row)) clean.push(p);
        else dirty.push(p);
    }

    if (dirty.length > 0) {
        log('INFO', `unpin: ${dirty.length} file(s) have unsynced local changes; running a sync pass first`);
        try {
            await ensureFresh();
        } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            for (const p of dirty) results.push({ path: p, ok: false, note: `could not sync first: ${why}` });
            dirty = [];
        }
    }
    for (const p of dirty) {
        // re-read the baseline: the sync pass may have updated it
        const row = st.syncGet(p);
        let size = -1;
        let mtimeMs = -1;
        let present = false;
        try {
            const s = statSync(absOf(p));
            size = s.size;
            mtimeMs = s.mtimeMs;
            present = true;
        } catch {
            present = false;
        }
        if (!row || !present) {
            results.push({ path: p, ok: false, note: 'file or baseline row disappeared during sync' });
            continue;
        }
        const fileClean = row.lsize !== null && row.lmtime !== null && fileEq(size, mtimeMs, row.lsize, row.lmtime);
        if (fileClean && steady(row)) clean.push(p);
        else results.push({ path: p, ok: false, note: 'has local changes that are not synced yet' });
    }

    for (const p of clean) {
        // marker BEFORE unlink so a watcher DELETE classifies as a steady placeholder (I1);
        // synchronous back-to-back, so no pass can observe an intermediate state
        st.onlineSet(p, 0);
        try {
            unlinkSync(absOf(p));
            results.push({ path: p, ok: true, note: 'freed' });
        } catch (e) {
            st.onlineDel(p);
            results.push({ path: p, ok: false, note: `cannot remove local file: ${e instanceof Error ? e.message : String(e)}` });
        }
    }
    for (const p of already) results.push({ path: p, ok: true, note: 'already online-only' });
    for (const p of absent) results.push({ path: p, ok: false, note: 'file not present locally' });

    const freed = results.filter((r) => r.note === 'freed').length;
    const failed = results.filter((r) => !r.ok).length;
    log('INFO', `unpin: freed=${freed} failed=${failed} targets=${targets.length}`);
    return results;
}

async function pinFiles(reqs: string[]): Promise<PinResult[]> {
    const rows = st.syncAll();
    const { targets, notes } = expandTargets(reqs, rows);
    const results: PinResult[] = [...notes];
    for (const p of targets) {
        if (st.onlineGet(p) === null) {
            results.push({ path: p, ok: true, note: 'already on this device' });
            continue;
        }
        const row = st.syncGet(p);
        if (!row || row.type !== 'file' || row.uid === null || row.rsize === null || row.rmtime === null) {
            results.push({ path: p, ok: false, note: 'missing baseline facts' });
            continue;
        }
        try {
            await remote.downloadFileRemote({ uid: row.uid, abs: absOf(p), expectSize: row.rsize, mtimeMs: row.rmtime });
            st.onlineDel(p); // keep the marker if the download failed (I5)
            results.push({ path: p, ok: true, note: 'restored' });
        } catch (e) {
            const why = remote.errMsg(e);
            results.push({ path: p, ok: false, note: `download failed: ${why}` });
            log('ERROR', `pin ${p}: ${why}`);
        }
    }
    const restored = results.filter((r) => r.note === 'restored').length;
    const failed = results.filter((r) => !r.ok).length;
    log('INFO', `pin: restored=${restored} failed=${failed} targets=${targets.length}`);
    return results;
}

async function daemon(): Promise<void> {
    let stopping = false;
    let passing = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPassStartedAt = 0;

    const schedule = (delayMs: number): void => {
        if (stopping) return;
        if (passing) {
            pending = true;
            return;
        }
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            void doPass();
        }, delayMs);
    };

    const doPass = async (): Promise<void> => {
        if (stopping) return;
        if (passing) {
            pending = true;
            return;
        }
        passing = true;
        lastPassStartedAt = Date.now();
        setStatus({ state: 'passing' });
        try {
            const s = await runPass({ forceFull: false });
            if (s.authFailed) log('ERROR', 'authentication required; will retry each interval (re-login via the official proton-drive CLI if this persists)');
        } catch (e) {
            log('ERROR', 'pass crashed', e);
            setStatus({ state: 'running', lastError: e instanceof Error ? e.message : String(e) });
        } finally {
            passing = false;
            if (pending) {
                pending = false;
                schedule(2000);
            }
        }
    };

    log('INFO', 'initial full pass...');
    passing = true;
    lastPassStartedAt = Date.now();
    try {
        const s = await runPass({ forceFull: true });
        if (s.authFailed) throw new Error(`initial sync failed: ${s.lastError}`);
    } finally {
        passing = false;
    }
    setStatus({ state: 'running' });
    log('INFO', 'initial pass done; starting event loop, watcher and interval');

    // Ensure at least one pass has *started and finished* after the call time.
    const ensureFresh = async (): Promise<void> => {
        const t0 = Date.now();
        schedule(0);
        while (!(lastPassStartedAt >= t0 && !passing)) {
            if (stopping) throw new Error('engine is stopping');
            if (Date.now() - t0 > 10 * 60_000) throw new Error('timed out waiting for a sync pass');
            await remote.sleep(250);
        }
    };

    const afterRpc = (): void => setStatus({ counts: { ...status.counts, placeholders: st.onlineCount() } });
    startRpcServer({
        pin: async (paths) => {
            const results = await pinFiles(paths);
            afterRpc();
            return results;
        },
        unpin: async (paths) => {
            const results = await unpinFiles(paths, ensureFresh);
            afterRpc();
            return results;
        },
    });

    syncNowHook = () => {
        if (stopping) return;
        log('INFO', 'SIGUSR1: sync now');
        schedule(0);
    };
    remote.startEventLoop(() => schedule(1000));
    const stopWatch = startWatcher(() => {
        loadFilters();
        schedule(3000);
    });
    const interval = setInterval(() => schedule(0), passIntervalMs);

    await new Promise<void>((resolve) => {
        const shutdown = (sig: string): void => {
            if (stopping) return;
            stopping = true;
            syncNowHook = null;
            log('INFO', `${sig} received; shutting down`);
            if (timer) clearTimeout(timer);
            clearInterval(interval);
            stopWatch();
            remote.stopEventLoop();
            stopRpcServer();
            setStatus({ state: 'stopped' });
            setTimeout(resolve, 500);
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
    log('INFO', 'stopped cleanly');
}

main().catch((e) => {
    log('ERROR', `fatal: ${e instanceof Error ? e.stack : String(e)}`);
    releaseLock();
    process.exitCode = 1;
});
