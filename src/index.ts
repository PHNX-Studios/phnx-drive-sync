import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

import { appRoot } from './approot';
import { authRecheckMs, hydrateStallMs, legacyShareDir, legacyStateDir, lockFile, localRoot, prefetchDefault, reconnectInitMaxMs, reconnectInitMinMs, shareDir, shutdownGraceMs, stateDir, statusFile, treeRoot, watcherDebounceMs, watcherMaxDebounceMs, watcherPollMs } from './config';
import { connectAndSync, connectRemote, createWaker, type ConnectDeps } from './boot';
import { isOffline, onOfflineEdge, reportNetworkError, reportSuccess, sdkPaused, sdkResumed, setOffline, startMonitor, stopMonitor } from './connectivity';
import { kickEmblems, syncEmblemsOnce } from './emblems';
import { evictAll, evictSummary, fmtBytes, maybeAutoEvict, notify } from './evict';
import { loadFilters } from './filters';
import { RemoteGate } from './gate';
import { bumpRevision, log, setStatus, status } from './log';
import { isMountPoint, monitorMount, mountOkPath, startMount, stopMount } from './mount';
import * as remote from './remote';
import { AuthRequiredError, OfflineError } from './remote';
import { requestReload, rpcClient, startRpcServer, stopRpcServer, type PinResult } from './rpc';
import { waitForPassEnd } from './shutdown';
import * as st from './state';
import { fileEq, requestStop, runPass, steady } from './sync';
import { absOf, baseName, listDirStatus } from './tree';
import { runUpdate } from './update';
import { VERSION } from './version';
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

    // The old wrapper script used to supply these; bake the same defaults in so
    // the compiled binary behaves identically under systemd and from a shell.
    process.env.PROTON_DRIVE_CACHE_DIR ??= path.join(shareDir, 'proton-cache');
    process.env.PROTON_DRIVE_LOG_LEVEL ??= 'WARN';

    if (mode === 'help' || mode === '--help' || mode === '-h') {
        console.log(usage());
        return;
    }
    if (mode === 'version' || mode === '--version' || mode === '-V') {
        console.log(VERSION);
        return;
    }
    if (mode === 'status') {
        try {
            console.log(readFileSync(statusFile, 'utf8'));
        } catch {
            console.log(JSON.stringify({ state: 'unknown' }));
        }
        return;
    }
    if (mode === 'pin' || mode === 'unpin' || mode === 'evict' || mode === 'prefetch') {
        // client of the running daemon: no lock, no remote connection
        process.exitCode = await rpcClient(mode, process.argv.slice(3));
        return;
    }
    if (mode === 'login') {
        process.exitCode = await login();
        return;
    }
    if (mode === 'restart') {
        process.exitCode = await restartEngine();
        return;
    }
    if (mode === 'update') {
        process.exitCode = await runUpdate(process.argv.slice(3));
        return;
    }
    const dryRun = process.argv.includes('--dry-run');
    if (mode !== 'run' && mode !== 'once') {
        console.error(usage());
        process.exitCode = 64;
        return;
    }
    if (dryRun && mode !== 'once') {
        console.error('--dry-run is only valid with once');
        process.exitCode = 64;
        return;
    }

    ensureLayout();
    st.openState();
    loadFilters();

    acquireLock();
    try {
        if (mode === 'once') {
            // one-shot: no mount, but surface an offline run with a clear message
            // and exit 2 rather than a raw SDK stack / auth exit
            try {
                await remote.initRemote();
            } catch (e) {
                if (remote.isAuthError(e)) {
                    log('ERROR', `auth failure: ${remote.errMsg(e)}`);
                    console.error('phnx-drive-sync: authentication required - run: phnx-drive-sync login');
                    process.exitCode = 3;
                    return;
                }
                if (remote.isNetworkError(e)) {
                    log('WARN', `offline at init: ${remote.errMsg(e)}`);
                    console.error("phnx-drive-sync: offline - can't reach Proton Drive");
                    process.exitCode = 2;
                    return;
                }
                throw e;
            }
            const s = await runPass({ forceFull: true, dry: dryRun });
            if (!dryRun) await syncEmblemsOnce();
            setStatus({ state: dryRun ? 'stopped' : 'idle' });
            process.exitCode = s.authFailed ? 3 : s.errors > 0 ? 2 : 0;
        } else {
            await daemon();
        }
    } finally {
        await stopMount();
        await remote.shutdownRemote();
        releaseLock();
    }
    process.exit(process.exitCode ?? 0);
}

/** Directories the daemon needs; migrates the pre-rename layout once, then the legacy tree. */
function ensureLayout(): void {
    migrateLegacyLayout();
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(shareDir, { recursive: true });
    if (!existsSync(treeRoot)) {
        let legacyHasData = false;
        try {
            legacyHasData = statSync(localRoot).isDirectory() && readdirSync(localRoot).length > 0;
        } catch {
            legacyHasData = false;
        }
        if (legacyHasData && !isMountPoint(localRoot)) {
            log('INFO', `relocating real tree ${localRoot} -> ${treeRoot}`);
            renameSync(localRoot, treeRoot); // same filesystem; fails loudly otherwise
        }
    }
    mkdirSync(treeRoot, { recursive: true });
    mkdirSync(localRoot, { recursive: true });
}

function fixLegacyLogName(dir: string): void {
    const oldLog = path.join(dir, 'drive-sync.log');
    const newLog = path.join(dir, 'phnx-drive-sync.log');
    try {
        if (existsSync(oldLog) && !existsSync(newLog)) renameSync(oldLog, newLog);
    } catch {
        /* best effort: a stale log name is harmless */
    }
}

/** Move `oldDir`'s entries into a pre-existing `newDir`, recursing into shared subdirs. */
function mergeDir(oldDir: string, newDir: string): void {
    mkdirSync(newDir, { recursive: true });
    for (const entry of readdirSync(oldDir)) {
        const from = path.join(oldDir, entry);
        const to = path.join(newDir, entry);
        if (!existsSync(to)) {
            renameSync(from, to);
        } else if (statSync(from).isDirectory() && statSync(to).isDirectory()) {
            mergeDir(from, to); // e.g. an empty new dir next to a populated legacy one
        }
    }
    try {
        rmdirSync(oldDir); // only removes it if now empty; leftovers stay in place
    } catch {
        /* not empty or in use */
    }
}

/**
 * One-time rename of the pre-rename layout: {share,state}/drive-sync ->
 * {share,state}/phnx-drive-sync. All sync state (baseline db, placeholder and
 * keep marks, the real tree, the SDK cache) moves with it, so an upgrade never
 * re-downloads or re-adopts anything. When the new dir already exists (e.g.
 * created empty at import), its contents are merged in and any leftovers are
 * left in place rather than deleted.
 */
function migrateLegacyLayout(): void {
    const pairs: Array<[string | null, string]> = [
        [legacyShareDir, shareDir],
        [legacyStateDir, stateDir],
    ];
    for (const [oldDir, newDir] of pairs) {
        if (!oldDir || oldDir === newDir || !existsSync(oldDir)) continue;
        try {
            if (!existsSync(newDir)) {
                renameSync(oldDir, newDir); // same filesystem: one atomic rename
            } else {
                mergeDir(oldDir, newDir);
            }
            if (newDir === stateDir) fixLegacyLogName(newDir);
            log('INFO', `migrated legacy layout ${oldDir} -> ${newDir}`);
        } catch (e) {
            log('WARN', `legacy layout migration failed (${oldDir} -> ${newDir}); continuing`, e);
        }
    }
}

function parentRel(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
}

const hydrating = new Map<string, Promise<void>>();
/** In-flight hydrate downloads, so a session loss / going offline / shutdown can cut them loose. */
const hydrateAborts = new Map<string, AbortController>();

function abortHydrates(reason: Error): void {
    for (const ac of [...hydrateAborts.values()]) ac.abort(reason);
}

/** Materialize a placeholder (sidecar open blocks on this): download + clear marker. */
function hydrateOne(p: string): Promise<void> {
    const running = hydrating.get(p);
    if (running) return running;
    const job = (async () => {
        if (existsSync(absOf(p))) {
            st.onlineDel(p); // materialized meanwhile (also done by pass normalization)
            return;
        }
        if (st.onlineGet(p) === null) throw new Error(`not a placeholder: ${p}`);
        // known-offline: fail instantly (no SDK retries) so the sidecar can answer
        // the kernel with ENETDOWN instead of hanging the open path for 10-30s (I5:
        // the marker is untouched, so a retry after reconnect works)
        if (isOffline()) throw new OfflineError(`offline: ${p} needs internet`);
        const row = st.syncGet(p);
        if (!row || row.type !== 'file' || row.uid === null || row.rsize === null || row.rmtime === null) {
            throw new Error(`missing baseline facts: ${p}`);
        }
        const ac = new AbortController();
        hydrateAborts.set(p, ac);
        try {
            await remote.downloadFileRemote({
                uid: row.uid,
                abs: absOf(p),
                expectSize: row.rsize,
                mtimeMs: row.rmtime,
                signal: ac.signal,
                stallMs: hydrateStallMs(),
            });
        } catch (e) {
            // a black-holed link (probe still "up"): classify the real failure so
            // the *next* open fails fast too (auth is not a connectivity problem)
            if (!remote.isAuthError(e)) reportNetworkError(e);
            throw e;
        } finally {
            hydrateAborts.delete(p);
        }
        st.onlineDel(p); // keep the marker if the download failed (I5)
        reportSuccess();
        log('INFO', `hydrate: ${p} materialized`);
    })().finally(() => hydrating.delete(p));
    hydrating.set(p, job);
    return job;
}

/** Wait for a dir the watcher may be about to sync, else create the remote chain inline. */
async function ensureRemoteParentDir(rel: string): Promise<string | null> {
    if (rel === '') return remote.remoteRootUid;
    const deadline = Date.now() + 2500;
    for (;;) {
        const row = st.cacheGet(rel);
        if (row && row.type === 'dir') return row.uid;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    const parentUid = await ensureRemoteParentDir(parentRel(rel));
    if (!parentUid) return null;
    const uid = await remote.createFolderRemote(parentUid, baseName(rel));
    remote.cachePut({ path: rel, uid, type: 'dir', size: null, mtime: null });
    st.syncSet({ path: rel, uid, type: 'dir', lsize: null, lmtime: null, rsize: null, rmtime: null });
    return uid;
}

/** Move a placeholder (FUSE rename of a not-on-disk file): metadata-only, remote included. */
async function mvPlaceholder(from: string, to: string): Promise<void> {
    const row = st.syncGet(from);
    if (!row || row.type !== 'file') throw new Error(`no such synced file: ${from}`);
    if (!st.onlineHas(from)) throw new Error(`not a placeholder: ${from}`);
    const nameChanged = baseName(to) !== baseName(from);
    const parentChanged = parentRel(to) !== parentRel(from);
    // a placeholder rename with a real move needs the remote API; offline fail
    // fast, before the target checks, and mutate nothing (a local-only row rename
    // would desync the baseline from remote - I3)
    if ((nameChanged || parentChanged) && isOffline()) throw new OfflineError(`offline: cannot rename ${from} until you reconnect`);
    if (st.syncGet(to) || st.onlineHas(to) || existsSync(absOf(to))) throw new Error(`target already exists: ${to}`);
    if (nameChanged || parentChanged) {
        if (row.uid === null) throw new Error(`missing remote id: ${from}`);
        let newParentUid: string | null = null;
        if (parentChanged) newParentUid = await ensureRemoteParentDir(parentRel(to));
        if (parentChanged && !newParentUid) throw new Error(`parent folder not found remotely: ${parentRel(to)}`);
        await remote.moveRemoteUid(row.uid, nameChanged ? baseName(to) : null, newParentUid);
        remote.cacheMovePath(from, to);
    }
    st.syncRename(from, to, row.uid);
    st.onlineDel(from);
    st.onlineSet(to, 0);
    log('INFO', `mv: placeholder ${from} -> ${to}`);
}

/** Trash a placeholder (FUSE unlink of a not-on-disk file): remote + row + marker. */
async function trashPlaceholder(p: string): Promise<void> {
    if (!st.onlineHas(p)) throw new Error(`not a placeholder: ${p}`);
    const row = st.syncGet(p);
    if (row?.type === 'dir') throw new Error(`not a file: ${p}`);
    // trashing a placeholder needs the remote API; offline fail fast with nothing
    // mutated (row + marker + cache all stay, I3/I5) - including a row with no uid
    if (isOffline()) throw new OfflineError(`offline: cannot move ${p} to trash until you reconnect`);
    if (row && row.uid) {
        await remote.trashRemoteUid(row.uid);
        remote.cacheRemoveSubtree(p);
        st.syncDel(p); // single choke point drops row + marker (I3)
    } else {
        st.onlineDel(p);
    }
    log('INFO', `trash: placeholder ${p}`);
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
        // "Free up space" overrides an earlier keep-mark (last explicit instruction wins)
        st.pinnedDel(p);
        try {
            unlinkSync(absOf(p));
            results.push({ path: p, ok: true, note: 'freed' });
        } catch (e) {
            st.onlineDel(p);
            st.pinnedSet(p); // the file is still local: restore its keep-mark
            results.push({ path: p, ok: false, note: `cannot remove local file: ${e instanceof Error ? e.message : String(e)}` });
        }
    }
    for (const p of already) {
        st.pinnedDel(p); // already online-only; drop any stale keep-mark
        results.push({ path: p, ok: true, note: 'already online-only' });
    }
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
    // any placeholder pin needs the remote API to download; offline collapse to
    // one clear "needs internet" per file instead of N SDK-retry failures
    const offline = isOffline();
    for (const p of targets) {
        if (st.onlineGet(p) === null) {
            st.pinnedSet(p); // Keep on This Device, even when it never left
            results.push({ path: p, ok: true, note: 'already on this device' });
            continue;
        }
        if (offline) {
            results.push({ path: p, ok: false, note: 'offline: needs internet' });
            continue;
        }
        const row = st.syncGet(p);
        if (!row || row.type !== 'file' || row.uid === null || row.rsize === null || row.rmtime === null) {
            results.push({ path: p, ok: false, note: 'missing baseline facts' });
            continue;
        }
        try {
            await remote.downloadFileRemote({ uid: row.uid, abs: absOf(p), expectSize: row.rsize, mtimeMs: row.rmtime, stallMs: hydrateStallMs() });
            st.onlineDel(p); // keep the marker if the download failed (I5)
            st.pinnedSet(p); // keep-mark survives materialization; auto-evict must never free this
            reportSuccess();
            results.push({ path: p, ok: true, note: 'restored' });
        } catch (e) {
            const why = remote.errMsg(e);
            if (!remote.isAuthError(e)) reportNetworkError(e);
            results.push({ path: p, ok: false, note: `download failed: ${why}` });
            log('ERROR', `pin ${p}: ${why}`);
        }
    }
    const restored = results.filter((r) => r.note === 'restored').length;
    const failed = results.filter((r) => !r.ok).length;
    log('INFO', `pin: restored=${restored} failed=${failed} targets=${targets.length}`);
    return results;
}

/** Effective recall-on-hover/prefetch state: state.db meta override, else the env default. */
function prefetchEffective(): boolean {
    const m = st.metaGet('prefetch');
    if (m === 'on') return true;
    if (m === 'off') return false;
    return prefetchDefault();
}

async function daemon(): Promise<void> {
    let stopping = false;
    let passing = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let watch: ReturnType<typeof startWatcher> | null = null;
    let eventsStarted = false;
    let rpcStarted = false;
    let timerArmedAt = 0;
    let lastPassStartedAt = 0;

    // Initial-pass barrier + shutdown signals, declared here so the signal handlers
    // below can resolve them (unblocking handlers waiting on startup/retry).
    const gate = new RemoteGate();
    const waker = createWaker();
    let stopInitResolve: () => void = () => {};
    const stopInit = new Promise<void>((resolve) => {
        stopInitResolve = resolve;
    });

    // --- graceful shutdown: finish the in-flight file, then unwind ----------
    // Handlers are registered before the mount and initial pass so a SIGTERM at
    // login also drains instead of hard-killing the process mid-upload.
    let shutdownResolve: () => void = () => {};
    const shutdownDone = new Promise<void>((resolve) => {
        shutdownResolve = resolve;
    });
    let draining = false;
    const drainAndStop = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        // runPass checks requestStop() between actions, so the file operation
        // already running finishes before the pass unwinds; this just waits for it.
        const grace = shutdownGraceMs();
        if (passing) log('INFO', `finishing the in-flight operation before shutdown (up to ${Math.round(grace / 1000)}s)`);
        const drained = await waitForPassEnd({ isPassing: () => passing, graceMs: grace, sleep: (ms) => remote.sleep(ms) });
        if (!drained) log('WARN', 'shutdown grace elapsed with a pass still running; unmounting and exiting anyway');
        await stopMount();
        setStatus({ state: 'stopped' });
        setTimeout(shutdownResolve, 500);
    };
    const shutdown = (sig: string): void => {
        if (stopping) return;
        stopping = true;
        syncNowHook = null;
        log('INFO', `${sig} received; shutting down`);
        if (timer) clearTimeout(timer);
        if (pollTimer) clearInterval(pollTimer);
        if (watch) watch.stop();
        stopMonitor();
        if (eventsStarted) remote.stopEventLoop();
        if (rpcStarted) stopRpcServer();
        requestStop();
        // unblock any handler awaiting the initial pass or a download, wake a parked
        // boot loop, and abandon an in-flight initRemote attempt so shutdown never
        // waits on a stuck connection
        gate.stop();
        abortHydrates(new Error('engine is stopping'));
        waker.wake();
        stopInitResolve();
        void drainAndStop();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // reload: retry the remote connection now (e.g. after `phnx-drive-sync login`).
    // Once the initial pass is done the session is held in memory, so there is
    // nothing to re-read (returns false: a restart is needed). Before that the wake
    // is always sent, so a login that lands during the initial pass is not lost.
    const reload = (via: string): boolean => {
        if (stopping) return false;
        if (gate.state === 'ready' && gate.initialPassDone) {
            log('INFO', `${via}: engine already connected; restart it to pick up a new login`);
            return false;
        }
        log('INFO', `${via}: retrying the connection to Proton Drive`);
        waker.wake();
        return true;
    };
    process.on('SIGHUP', () => reload('SIGHUP'));
    syncNowHook = () => {
        if (stopping) return;
        log('INFO', 'SIGUSR1: sync now');
        if (!gate.initialPassDone) reload('sync now');
        else schedule(0);
    };

    /**
     * Debounce a sync pass. Non-sliding callers coalesce (the first event wins);
     * watcher wakes slide, so the pass runs only once writes go quiet, capped at
     * watcherMaxDebounceMs so continuous churn cannot starve the pass forever.
     */
    const schedule = (delayMs: number, slide = false): void => {
        if (stopping) return;
        if (passing) {
            pending = true;
            return;
        }
        if (timer) {
            // slide (watcher churn): postpone, but keep the burst's start time so
            // the cap still bounds total latency; otherwise the first event wins
            if (!slide || Date.now() - timerArmedAt >= watcherMaxDebounceMs) return;
            clearTimeout(timer);
        } else {
            timerArmedAt = Date.now();
        }
        timer = setTimeout(() => {
            timer = null;
            void doPass();
        }, delayMs);
    };

    // Initial-pass barrier + offline hooks (declared at the top of daemon()).
    const doPass = async (): Promise<void> => {
        if (stopping) return;
        if (passing) {
            pending = true;
            return;
        }
        // offline: never schedule a pass that would just spam scan/upload errors;
        // the reconnect hook runs a forced full pass once connectivity returns
        if (isOffline()) return;
        passing = true;
        lastPassStartedAt = Date.now();
        setStatus({ state: 'passing' });
        try {
            // reload per pass (not per watcher event) so a burst of changes does
            // not re-read/compile .protonignore thousands of times, while an edit
            // to .protonignore still takes effect on the pass it triggers
            loadFilters();
            const s = await runPass({ forceFull: false });
            if (s.authFailed) log('ERROR', 'authentication required; will retry on the next change (run: phnx-drive-sync login if this persists)');
            else if (!s.errors) reportSuccess();
            maybeAutoEvict(new Set(hydrating.keys()));
            kickEmblems();
        } catch (e) {
            log('ERROR', 'pass crashed', e);
            reportNetworkError(e);
            setStatus({ state: 'running', progress: null, lastError: e instanceof Error ? e.message : String(e) });
        } finally {
            passing = false;
            if (pending) {
                pending = false;
                schedule(2000);
            }
        }
    };

    // Ensure at least one pass has *started and finished* after the call time.
    const ensureFresh = async (): Promise<void> => {
        if (gate.state !== 'ready') throw new Error('not connected to Proton Drive');
        if (isOffline()) throw new Error('offline');
        const t0 = Date.now();
        schedule(0);
        while (!(lastPassStartedAt >= t0 && !passing)) {
            if (stopping) throw new Error('engine is stopping');
            if (Date.now() - t0 > 10 * 60_000) throw new Error('timed out waiting for a sync pass');
            await remote.sleep(250);
        }
    };

    const afterRpc = (): void => {
        kickEmblems();
        // Every mutating RPC can change a file's status (pin/unpin/evict/hydrate/
        // mv/trash): advance the revision so the GUI refreshes the visible folder.
        bumpRevision();
        setStatus({
            prefetch: prefetchEffective(),
            counts: { ...status.counts, placeholders: st.onlineCount(), reclaimable: st.reclaimableBytes() },
        });
    };

    // --- startup: mount first, then reach the API (offline must not crash) ---
    //
    // The mount is independent of connectivity (placeholders are served from the
    // baseline db), so the folder stays browsable offline. initRemote is retried
    // with backoff instead of triggering a systemd crash loop, and the RPC surface
    // opens immediately so the sidecar can fast-fail opens with ENETDOWN.
    log('INFO', 'starting FUSE mount...');
    const mounted = await startMount();
    if (!mounted.ok) log('ERROR', 'mount degraded: users see an empty folder until the mount comes up');
    monitorMount();

    let ready = false;
    remote.onConnectivity({ paused: sdkPaused, resumed: sdkResumed });
    // going offline cuts in-flight hydrates loose: they fail with ENETDOWN at once
    // instead of riding out the SDK's retries (markers are kept, I5)
    onOfflineEdge(() => abortHydrates(new OfflineError('offline: connection lost during download')));
    startMonitor(() => {
        // connectivity returned: wake the boot retry loop immediately, then (once
        // the daemon is live) reconcile with one forced full pass (safe: I5 keeps
        // every marker)
        remote.requestForceFull();
        if (ready) schedule(0);
        else waker.wake();
    });

    // shutdown requested while bringing the mount up: skip the initial walk
    if (stopping) {
        stopMonitor();
        await shutdownDone;
        return;
    }

    let rpcStartedLocal = false;
    const startRpc = (): void => {
        if (rpcStartedLocal) return;
        startRpcServer({
            pin: async (paths) => {
                await gate.readyForRemoteOp();
                const results = await pinFiles(paths); // offline -> 'offline: needs internet' per file
                afterRpc();
                return results;
            },
            unpin: async (paths) => {
                // freeing local bytes is a local op; offline still works for the
                // files whose baseline is steady (dirty ones fail cleanly)
                await gate.readyForLocalOp();
                const results = await unpinFiles(paths, ensureFresh);
                afterRpc();
                return results;
            },
            evict: async (paths) => {
                // evictAll re-verifies clean+steady itself, so the ensureFresh
                // pass (which needs the network) is only needed while online
                await gate.readyForLocalOp();
                if (gate.state === 'ready' && !isOffline()) {
                    // never free unsynced bytes: run/await a pass first (I4)
                    await ensureFresh();
                }
                const all = paths.length === 1 && paths[0] === '*';
                let targets: string[] | null = null;
                const notes: PinResult[] = [];
                if (!all) {
                    const exp = expandTargets(paths, st.syncAll());
                    targets = exp.targets;
                    notes.push(...exp.notes);
                }
                const out = evictAll({ targets, busy: new Set(hydrating.keys()) });
                log('INFO', `evict: ${evictSummary(out)}`);
                notify(
                    out.freed > 0
                        ? `Freed ${fmtBytes(out.bytes)} — ${out.freed} file(s) are now online-only.\n` +
                              (out.kept > 0 || out.dirty > 0
                                  ? `${out.kept} kept on this device and ${out.dirty} with unsynced changes were left local.`
                                  : '')
                        : 'Nothing to free: files are already online-only, unsynced, or kept on this device.',
                );
                afterRpc();
                return [...notes, { path: all ? 'all local copies' : `${targets?.length ?? 0} file(s)`, ok: true, note: evictSummary(out) }];
            },
            prefetch: async (paths) => {
                const v = paths[0];
                if (v === 'status') return [{ path: 'prefetch', ok: true, note: prefetchEffective() ? 'on' : 'off' }];
                if (v !== 'on' && v !== 'off') throw new Error('usage: prefetch on|off|status');
                st.metaSet('prefetch', v);
                log(
                    'INFO',
                    v === 'on'
                        ? 'prefetch on: looking up a placeholder now triggers a background recall (materializes)'
                        : 'prefetch off: placeholders recall only on open (default)',
                );
                afterRpc();
                return [{ path: 'prefetch', ok: true, note: `now ${v}` }];
            },
            hydrate: async (paths) => {
                await gate.readyForRemoteOp();
                const p = paths[0];
                await hydrateOne(p); // offline -> OfflineError -> ENETDOWN
                afterRpc();
                return [{ path: p, ok: true, note: 'hydrated' }];
            },
            mv: async (paths) => {
                await gate.readyForRemoteOp();
                const [from, to] = paths;
                await mvPlaceholder(from, to); // offline -> OfflineError
                afterRpc();
                return [{ path: from, ok: true, note: `moved to ${to}` }];
            },
            trash: async (paths) => {
                await gate.readyForRemoteOp();
                const p = paths[0];
                await trashPlaceholder(p); // offline -> OfflineError
                afterRpc();
                return [{ path: p, ok: true, note: 'trashed' }];
            },
            list: async (paths) => listDirStatus(paths[0]),
            sync: async () => {
                // the GUI "Sync now": same as SIGUSR1, but without assuming systemd
                if (!gate.initialPassDone) reload('sync now');
                else schedule(0);
                return [{ path: 'sync', ok: true, note: 'scheduled' }];
            },
            reload: async () => {
                // sent by `login`: a fresh init re-reads the keyring session
                const note = reload('login') ? 'reconnecting' : 'restart-required';
                return [{ path: 'reload', ok: true, note }];
            },
        });
        rpcStartedLocal = true;
        rpcStarted = true;
    };
    startRpc(); // available during init and offline so opens fast-fail with ENETDOWN

    // connect to Proton Drive: back off on network failures, park (no timer retry)
    // on a rejected session until login / reload / Sync now wakes us
    const recheckMs = authRecheckMs();
    const connectDeps: ConnectDeps = {
        init: () => remote.initRemote(),
        isStopping: () => stopping,
        stopSignal: stopInit,
        waitForWake: (ms) => waker.wait(ms),
        minMs: reconnectInitMinMs(),
        maxMs: reconnectInitMaxMs(),
        authRecheckMs: recheckMs,
        onAuth: (e) => parkForSignIn(remote.errMsg(e)),
        onOffline: (e, retryMs) => {
            gate.setState('connecting');
            leaveAuthState(remote.errMsg(e));
            log('WARN', `offline: cannot reach Proton Drive (retrying in ${Math.round(retryMs / 1000)}s): ${remote.errMsg(e)}`);
            setOffline(true, 'boot');
        },
        onError: (e, retryMs) => {
            // not a connectivity problem: retry without claiming to be offline
            gate.setState('connecting');
            leaveAuthState(remote.errMsg(e));
            log('ERROR', `remote init failed (retrying in ${Math.round(retryMs / 1000)}s): ${remote.errMsg(e)}`);
        },
    };
    // A retry that fails for another reason must not leave a stale "sign in" status.
    function leaveAuthState(why: string): void {
        if (status.state === 'auth-required') setStatus({ state: 'starting', lastError: why });
    }
    // The session was rejected: say so once, fail online-only opens at once
    // (EACCES) and cut loose anything already downloading.
    function parkForSignIn(why: string): void {
        const err = new AuthRequiredError();
        gate.setState('auth-required');
        gate.fail(err);
        abortHydrates(err);
        log(
            'WARN',
            `authentication required: ${why}; waiting for a sign-in (run: phnx-drive-sync login)` +
                (recheckMs > 0 ? `, rechecking every ${Math.round(recheckMs / 60_000)} min` : ''),
        );
        setStatus({ state: 'auth-required', lastError: why });
    }

    const outcome = await connectAndSync({
        connect: () => connectRemote(connectDeps),
        isStopping: () => stopping,
        onReady: () => {
            gate.setState('ready');
            reportSuccess();
        },
        pass: async () => {
            log('INFO', 'initial full pass...');
            passing = true;
            lastPassStartedAt = Date.now();
            setStatus({ state: 'passing', lastError: null });
            try {
                const s = await runPass({ forceFull: true });
                if (s.authFailed && !s.scanAuthFailed) {
                    // one file's transfer was refused: stays per-file, the engine keeps going
                    log('WARN', `authentication error during the initial pass: ${s.lastError}`);
                } else if (!s.authFailed && !s.errors) {
                    reportSuccess();
                }
                return { scanAuthFailed: s.scanAuthFailed, lastError: s.lastError };
            } finally {
                passing = false;
            }
        },
        onPassDone: () => gate.markPassDone(),
        sessionKept: () => remote.sessionKept(),
        // the session died between connecting and the first listing: wait for a
        // sign-in, then connect and walk again (waiters are released with EACCES)
        onAuth: (why) => parkForSignIn(why),
        onTransient: (why, retryMs) => {
            gate.setState('connecting');
            leaveAuthState(why);
            log('ERROR', `session refresh failed but the stored session is kept (retrying in ${Math.round(retryMs / 1000)}s): ${why}`);
        },
        waitForWake: (ms) => waker.wait(ms),
        minMs: connectDeps.minMs,
        maxMs: connectDeps.maxMs,
        authRecheckMs: recheckMs,
    });
    if (outcome === 'stopped') {
        stopMonitor();
        await shutdownDone;
        return;
    }

    // shutdown requested during the initial pass: do not start the pumps
    if (stopping) {
        stopMonitor();
        await shutdownDone;
        return;
    }

    setStatus({ state: 'running', prefetch: prefetchEffective() });
    maybeAutoEvict(new Set(hydrating.keys()));
    kickEmblems();
    ready = true;
    log('INFO', 'initial pass done; starting event loop and watcher (no periodic full walk)');


    remote.startEventLoop(() => schedule(1000));
    eventsStarted = true;
    watch = startWatcher(() => schedule(watcherDebounceMs, true));
    // Safety net: the watcher is a fast path, not a guarantee. If it is missing,
    // permanently crashed, or reports partial coverage (inotify watch limit), fall
    // back to a low-frequency incremental pass so local edits still sync. While the
    // watcher is healthy the poll stays silent (no periodic full walk).
    const pollMs = watcherPollMs();
    pollTimer =
        pollMs > 0
            ? setInterval(() => {
                  if (stopping) return;
                  // only act when nothing is already queued or running, so a busy
                  // engine does not log a warning on every tick
                  if (!watch.healthy() && !passing && !pending && !timer) {
                      log('WARN', 'file watcher not healthy; running a safety sync pass');
                      schedule(0);
                  }
              }, pollMs)
            : null;
    if (pollTimer) pollTimer.unref();

    await shutdownDone;
    log('INFO', 'stopped cleanly');
}

function usage(): string {
    return [
        'usage: phnx-drive-sync <command> [options]',
        '',
        'commands:',
        '  run                        daemon: initial full pass, then events + watcher (default)',
        '  once [--dry-run]           single full pass (exit 0 ok, 2 errors, 3 auth)',
        '  status                     print status.json',
        '  pin <path>...              download online-only files and keep them on this device',
        '  unpin <path>...            free local space (files stay on Proton Drive)',
        '  evict [path...]            bulk "free up space" (no paths = every local file)',
        '  prefetch on|off|status     recall-on-hover toggle (default off)',
        '  login                      sign in to Proton Drive (the only manual setup step)',
        '  restart                    restart the engine service and wait for the FUSE mount',
        '  update [--check] [--url U] check for and install a newer release',
        '  version                    print the version',
    ].join('\n');
}

/** Sign in via the bundled official CLI (or a system `proton-drive` fallback). */
async function login(): Promise<number> {
    // Proton requires a clear third-party disclosure when prompting for account
    // details (see vendor/README.md, "Product and legal requirements").
    console.error(
        'PHNX Drive Sync is an independent, unofficial application.\n' +
            'This is a third-party application not officially supported by Proton.',
    );
    const bundled = path.join(appRoot, 'proton-drive');
    const bin = existsSync(bundled) ? bundled : 'proton-drive';
    const r = spawnSync(bin, ['auth', 'login', ...process.argv.slice(3)], { stdio: 'inherit' });
    if (r.error) {
        if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') {
            console.error(
                'proton-drive CLI not found. Reinstall phnx-drive-sync, or install the official\n' +
                    'proton-drive CLI and run: proton-drive auth login',
            );
            return 127;
        }
        console.error(`login failed: ${r.error.message}`);
        return 1;
    }
    if (r.status !== 0) return r.status ?? 1;
    // tell a running engine to pick the new session up (it re-reads the keyring on
    // its next connection attempt); no automatic restart
    const outcome = await requestReload();
    if (outcome === 'reconnecting') console.error('The engine was waiting for a sign-in and is reconnecting now.');
    else console.error('If the engine was already running with an expired session, run: phnx-drive-sync restart');
    return 0;
}

/**
 * `phnx-drive-sync restart`: restart the engine unit and report success only
 * once the FUSE sidecar heartbeat is beating again. Used by the desktop
 * launcher; the tray heals a degraded mount on its own.
 */
async function restartEngine(): Promise<number> {
    const r = spawnSync('systemctl', ['--user', 'restart', 'phnx-drive-sync.service'], { stdio: 'inherit' });
    if (r.error || r.status !== 0) {
        notify('Engine restart failed - check: systemctl --user status phnx-drive-sync');
        return 1;
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try {
            if (Date.now() - statSync(mountOkPath).mtimeMs <= 15_000) {
                notify('Engine restarted - Proton Drive mounted');
                return 0;
            }
        } catch {
            /* sidecar is not beating yet */
        }
        if (spawnSync('systemctl', ['--user', 'is-active', '--quiet', 'phnx-drive-sync.service']).status !== 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    notify('Engine restarted, but the FUSE mount did not come up - check: journalctl --user -u phnx-drive-sync.service');
    return 1;
}

main()
    .then(() => {
        // `fetch` (self-update) and other async resources can keep the event loop
        // alive after the command is done; exit deterministically.
        process.exit(process.exitCode ?? 0);
    })
    .catch((e) => {
        log('ERROR', `fatal: ${e instanceof Error ? e.stack : String(e)}`);
        releaseLock();
        process.exit(1);
    });
