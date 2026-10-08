import { existsSync, mkdirSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';

import { fullWalkEvery, modifyWindowMs, newFilesMode, seedAdoptWindowMs, treeRoot } from './config';
import { log, setStatus } from './log';
import * as remote from './remote';
import * as st from './state';
import { walkLocal, type LocalNode } from './scan';

export type Action =
    | { phase: 'mkdirLocal'; p: string }
    | { phase: 'mkdirRemote'; p: string }
    | { phase: 'renameLocal'; from: string; to: string }
    | { phase: 'renameRemote'; from: string; to: string }
    | { phase: 'download'; p: string; uid: string; size: number; mtimeMs: number }
    | { phase: 'adoptOnline'; p: string; uid: string; size: number; mtimeMs: number }
    | { phase: 'conflict'; p: string; uid: string; size: number; mtimeMs: number; conflictRel: string }
    | { phase: 'upload'; p: string; existingUid: string | null }
    | { phase: 'rmLocal'; p: string; dir: boolean }
    | { phase: 'trashRemote'; p: string; uid: string; dir: boolean };

export interface PassStats {
    uploads: number;
    downloads: number;
    deletes: number;
    renames: number;
    conflicts: number;
    adopts: number;
    errors: number;
    lastError: string | null;
    authFailed: boolean;
}

const totals = { uploads: 0, downloads: 0, deletes: 0, renames: 0, conflicts: 0, errors: 0 };
let passCount = 0;

function parentRel(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
}

function baseName(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
}

function depthOf(p: string): number {
    return p.split('/').length;
}

function abs(p: string): string {
    return p === '' ? treeRoot : `${treeRoot}/${p}`;
}

function baseOk(se: st.SyncRow | undefined, dir: boolean): se is st.SyncRow {
    if (!se) return false;
    if (dir) return se.type === 'dir';
    return se.type === 'file' && se.lsize !== null && se.rsize !== null && se.lmtime !== null && se.rmtime !== null;
}

export function steady(se: st.SyncRow): boolean {
    return (
        se.lsize !== null &&
        se.rsize !== null &&
        se.lmtime !== null &&
        se.rmtime !== null &&
        Math.abs(se.lsize - se.rsize) <= modifyWindowMs &&
        Math.abs(se.lmtime - se.rmtime) <= modifyWindowMs
    );
}

export function fileEq(sizeA: number, mtimeA: number, sizeB: number, mtimeB: number): boolean {
    return sizeA === sizeB && Math.abs(mtimeA - mtimeB) <= modifyWindowMs;
}


function rSize(r: st.CacheRow): number {
    return r.size ?? 0;
}

function rMtime(r: st.CacheRow): number {
    return r.mtime ?? 0;
}

function rIsDir(r: st.CacheRow): boolean {
    return r.type === 'dir';
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

function conflictRelFor(p: string, remoteMtimeMs: number, L: Map<string, LocalNode>, R: Map<string, st.CacheRow>): string {
    const dir = parentRel(p);
    const base = baseName(p);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    const d = new Date(remoteMtimeMs);
    const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    const joinRel = (name: string) => (dir === '' ? name : `${dir}/${name}`);
    let candidate = joinRel(`${stem} (conflict ${ts})${ext}`);
    if (st.syncGet(candidate) || L.has(candidate) || R.has(candidate) || existsSync(abs(candidate))) {
        return candidate;
    }
    let i = 2;
    for (;;) {
        candidate = joinRel(`${stem} (conflict ${ts}-${i})${ext}`);
        if (!st.syncGet(candidate) && !L.has(candidate) && !R.has(candidate) && !existsSync(abs(candidate))) {
            return candidate;
        }
        i++;
    }
}

export function classify(
    L: Map<string, LocalNode>,
    R: Map<string, st.CacheRow>,
    S: Map<string, st.SyncRow>,
    online: Map<string, number>,
    s: PassStats,
    dry: boolean,
): Action[] {
    const actions: Action[] = [];
    const used = new Set<string>();

    // Pairing: local renames (file moved locally -> move remote node)
    // online-only files are absent locally; they are never rename sources (I2)
    {
        const gone: string[] = [];
        for (const [p, row] of S) {
            if (row.type === 'file' && !L.has(p) && R.has(p) && steady(row) && !online.has(p)) gone.push(p);
        }
        const fresh: string[] = [];
        for (const [p, ln] of L) {
            if (!ln.dir && !S.has(p) && !R.has(p)) fresh.push(p);
        }
        fresh.sort();
        const claimed = new Set<string>();
        gone.sort();
        for (const from of gone) {
            const row = S.get(from)!;
            const cands = fresh.filter(
                (to) =>
                    !claimed.has(to) &&
                    L.get(to)!.size === row.lsize &&
                    Math.abs(L.get(to)!.mtimeMs - row.lmtime!) <= modifyWindowMs,
            );
            if (cands.length === 1) {
                const to = cands[0];
                claimed.add(to);
                used.add(from);
                used.add(to);
                actions.push({ phase: 'renameRemote', from, to });
                s.renames++;
            }
        }
    }

    // Pairing: remote renames (node moved remotely -> move local file)
    // online-only files qualify too: execute() applies those as metadata-only renames
    {
        const gone: string[] = [];
        for (const [p, row] of S) {
            if (row.type === 'file' && !R.has(p) && steady(row) && (L.has(p) || online.has(p))) gone.push(p);
        }
        const fresh: string[] = [];
        for (const [p, rn] of R) {
            if (rn.type === 'file' && !S.has(p) && !L.has(p)) fresh.push(p);
        }
        fresh.sort();
        const claimed = new Set<string>();
        gone.sort();
        for (const from of gone) {
            const row = S.get(from)!;
            const cands = fresh.filter(
                (to) =>
                    !claimed.has(to) &&
                    rSize(R.get(to)!) === row.rsize &&
                    Math.abs(rMtime(R.get(to)!) - row.rmtime!) <= modifyWindowMs,
            );
            if (cands.length === 1) {
                const to = cands[0];
                claimed.add(to);
                used.add(from);
                used.add(to);
                actions.push({ phase: 'renameLocal', from, to });
                s.renames++;
            }
        }
    }

    const paths = new Set<string>([...L.keys(), ...R.keys(), ...S.keys()]);
    for (const p of paths) {
        if (used.has(p)) continue;
        const ln = L.get(p);
        const rn = R.get(p);
        const se = S.get(p);

        if (ln && rn) {
            if (ln.dir !== rIsDir(rn)) {
                s.errors++;
                log('ERROR', `type mismatch at ${p}: local=${ln.dir ? 'dir' : 'file'} remote=${rIsDir(rn) ? 'dir' : 'file'}`);
                continue;
            }
            if (ln.dir) {
                if (!baseOk(se, true)) {
                    if (!dry) st.syncSet({ path: p, uid: rn.uid, type: 'dir', lsize: null, lmtime: null, rsize: null, rmtime: null });
                    s.adopts++;
                } else if (se!.uid !== rn.uid) {
                    if (!dry) st.syncSet({ ...se!, uid: rn.uid });
                }
                continue;
            }
            // files, both sides present
            if (!baseOk(se, false)) {
                if (ln.size === rSize(rn) && Math.abs(ln.mtimeMs - rMtime(rn)) <= seedAdoptWindowMs) {
                    if (!dry) {
                        st.syncSet({
                            path: p,
                            uid: rn.uid,
                            type: 'file',
                            lsize: ln.size,
                            lmtime: ln.mtimeMs,
                            rsize: rSize(rn),
                            rmtime: rMtime(rn),
                        });
                    }
                    s.adopts++;
                } else {
                    actions.push({ phase: 'conflict', p, uid: rn.uid, size: rSize(rn), mtimeMs: rMtime(rn), conflictRel: conflictRelFor(p, rMtime(rn), L, R) });
                    s.conflicts++;
                }
                continue;
            }
            const base = se!;
            const sameL = fileEq(ln.size, ln.mtimeMs, base.lsize!, base.lmtime!);
            const sameR = fileEq(rSize(rn), rMtime(rn), base.rsize!, base.rmtime!);
            const contentEq = fileEq(ln.size, ln.mtimeMs, rSize(rn), rMtime(rn));
            if (sameL && sameR) {
                if (!contentEq) {
                    actions.push({ phase: 'conflict', p, uid: rn.uid, size: rSize(rn), mtimeMs: rMtime(rn), conflictRel: conflictRelFor(p, rMtime(rn), L, R) });
                    s.conflicts++;
                }
            } else if (sameL && !sameR) {
                actions.push({ phase: 'download', p, uid: rn.uid, size: rSize(rn), mtimeMs: rMtime(rn) });
                s.downloads++;
            } else if (!sameL && sameR) {
                actions.push({ phase: 'upload', p, existingUid: rn.uid });
                s.uploads++;
            } else if (contentEq) {
                if (!dry) st.syncSet({ path: p, uid: rn.uid, type: 'file', lsize: ln.size, lmtime: ln.mtimeMs, rsize: rSize(rn), rmtime: rMtime(rn) });
                s.adopts++;
            } else {
                actions.push({ phase: 'conflict', p, uid: rn.uid, size: rSize(rn), mtimeMs: rMtime(rn), conflictRel: conflictRelFor(p, rMtime(rn), L, R) });
                s.conflicts++;
            }
            continue;
        }

        if (ln && !rn) {
            if (!baseOk(se, ln.dir)) {
                if (ln.dir) {
                    actions.push({ phase: 'mkdirRemote', p });
                } else {
                    actions.push({ phase: 'upload', p, existingUid: null });
                    s.uploads++;
                }
                continue;
            }
            if (ln.dir) {
                actions.push({ phase: 'rmLocal', p, dir: true });
                s.deletes++;
                continue;
            }
            const sameL = fileEq(ln.size, ln.mtimeMs, se!.lsize!, se!.lmtime!);
            if (sameL) {
                actions.push({ phase: 'rmLocal', p, dir: false });
                s.deletes++;
            } else {
                actions.push({ phase: 'upload', p, existingUid: null });
                s.uploads++;
            }
            continue;
        }

        if (!ln && rn) {
            if (!baseOk(se, rIsDir(rn))) {
                if (rIsDir(rn)) {
                    actions.push({ phase: 'mkdirLocal', p });
                } else if (newFilesMode() === 'online') {
                    // DRIVE_SYNC_NEW_FILES=online: a remote file with no local history
                    // becomes a placeholder instead of a download (dirs still materialize).
                    actions.push({ phase: 'adoptOnline', p, uid: rn.uid, size: rSize(rn), mtimeMs: rMtime(rn) });
                    s.adopts++;
                } else {
                    actions.push({ phase: 'download', p, uid: rn.uid, size: rSize(rn), mtimeMs: rMtime(rn) });
                    s.downloads++;
                }
                continue;
            }
            if (rIsDir(rn)) {
                actions.push({ phase: 'trashRemote', p, uid: rn.uid, dir: true });
                s.deletes++;
                continue;
            }
            if (online.has(p)) {
                // online-only file: content is intentionally absent locally.
                // steady remote -> no action (never trashRemote: that is the file-eater, I1);
                // changed remote -> metadata-only adopt, mirroring remote facts (l := r)
                // so the baseline stays steady and a later pin hydrates the current bytes.
                const sameR = fileEq(rSize(rn), rMtime(rn), se!.rsize!, se!.rmtime!);
                if (!sameR || se!.uid !== rn.uid) {
                    if (!dry) {
                        st.syncSet({ path: p, uid: rn.uid, type: 'file', lsize: rSize(rn), lmtime: rMtime(rn), rsize: rSize(rn), rmtime: rMtime(rn) });
                    }
                    s.adopts++;
                }
                continue;
            }
            const sameR = fileEq(rSize(rn), rMtime(rn), se!.rsize!, se!.rmtime!);
            if (sameR) {
                actions.push({ phase: 'trashRemote', p, uid: rn.uid, dir: false });
                s.deletes++;
            } else {
                actions.push({ phase: 'download', p, uid: rn.uid, size: rSize(rn), mtimeMs: rMtime(rn) });
                s.downloads++;
            }
            continue;
        }
        // !ln && !rn: cleanup handled after execution
    }

    return actions;
}

const PHASE_ORDER: Record<Action['phase'], number> = {
    mkdirLocal: 0,
    mkdirRemote: 1,
    renameLocal: 2,
    renameRemote: 3,
    download: 4,
    adoptOnline: 4,
    upload: 4,
    conflict: 4,
    rmLocal: 5,
    trashRemote: 6,
};

function actionDepth(a: Action): number {
    if (a.phase === 'renameLocal' || a.phase === 'renameRemote') return depthOf(a.to);
    return depthOf(a.p);
}

function sortActions(actions: Action[]): Action[] {
    return actions.slice().sort((a, b) => {
        const pa = PHASE_ORDER[a.phase];
        const pb = PHASE_ORDER[b.phase];
        if (pa !== pb) return pa - pb;
        const depthDiff =
            a.phase === 'rmLocal' && b.phase === 'rmLocal'
                ? actionDepth(b) - actionDepth(a) // deepest first
                : actionDepth(a) - actionDepth(b);
        if (depthDiff !== 0) return depthDiff;
        const ka = 'p' in a ? a.p : `${a.from}->${a.to}`;
        const kb = 'p' in b ? b.p : `${b.from}->${b.to}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

function resolveParentUid(rel: string, s: PassStats): string | null {
    if (rel === '') return remote.remoteRootUid;
    const row = st.cacheGet(rel);
    if (row && row.type === 'dir') return row.uid;
    s.errors++;
    s.lastError = `parent folder not found remotely: ${rel || '/'}`;
    log('ERROR', s.lastError);
    return null;
}

async function doUpload(p: string, existingUid: string | null, s: PassStats): Promise<void> {
    const absP = abs(p);
    const local = statSync(absP);
    const parentUid = resolveParentUid(parentRel(p), s);
    if (!parentUid) return;
    const { nodeUid } = await remote.uploadFileRemote({
        abs: absP,
        parentUid,
        name: baseName(p),
        size: local.size,
        mtimeMs: local.mtimeMs,
        existingUid: existingUid ?? undefined,
    });
    remote.cachePut({ path: p, uid: nodeUid, type: 'file', size: local.size, mtime: local.mtimeMs });
    st.syncSet({
        path: p,
        uid: nodeUid,
        type: 'file',
        lsize: local.size,
        lmtime: local.mtimeMs,
        rsize: local.size,
        rmtime: local.mtimeMs,
    });
}

function isEnoent(e: unknown): boolean {
    return e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT';
}

function isEnotempty(e: unknown): boolean {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOTEMPTY' || code === 'EEXIST';
}

async function execute(
    actions: Action[],
    R: Map<string, st.CacheRow>,
    s: PassStats,
): Promise<void> {
    const trashedDirs: string[] = [];
    for (const a of sortActions(actions)) {
        try {
            switch (a.phase) {
                case 'mkdirLocal': {
                    mkdirSync(abs(a.p), { recursive: true });
                    break;
                }
                case 'mkdirRemote': {
                    const parentUid = resolveParentUid(parentRel(a.p), s);
                    if (!parentUid) break;
                    const uid = await remote.createFolderRemote(parentUid, baseName(a.p));
                    remote.cachePut({ path: a.p, uid, type: 'dir', size: null, mtime: null });
                    st.syncSet({ path: a.p, uid, type: 'dir', lsize: null, lmtime: null, rsize: null, rmtime: null });
                    break;
                }
                case 'renameLocal': {
                    // local file moves from -> to; the remote node is already at `to`
                    if (st.onlineHas(a.from)) {
                        // online-only: no bytes on disk — row-only rename, zero fs ops
                        st.syncRename(a.from, a.to, R.get(a.to)?.uid);
                        break;
                    }
                    mkdirSync(abs(parentRel(a.to)), { recursive: true });
                    renameSync(abs(a.from), abs(a.to));
                    const local = statSync(abs(a.to));
                    const rn = R.get(a.to);
                    const keep = st.pinnedHas(a.from);
                    st.syncDel(a.from);
                    if (rn) {
                        st.syncSet({
                            path: a.to,
                            uid: rn.uid,
                            type: 'file',
                            lsize: local.size,
                            lmtime: local.mtimeMs,
                            rsize: rSize(rn),
                            rmtime: rMtime(rn),
                        });
                        // keep-mark rides the rename (syncDel dropped it for from)
                        if (keep) st.pinnedSet(a.to);
                    }
                    break;
                }
                case 'renameRemote': {
                    // local file is already at `to`; move the remote node from -> to
                    const rnFrom = R.get(a.from);
                    if (!rnFrom) break;
                    const toParentRel = parentRel(a.to);
                    const parentChanged = toParentRel !== parentRel(a.from);
                    let newParentUid: string | null = null;
                    if (parentChanged) {
                        newParentUid = resolveParentUid(toParentRel, s);
                        if (!newParentUid) break;
                    }
                    const rename = baseName(a.from) !== baseName(a.to);
                    await remote.moveRemoteUid(rnFrom.uid, rename ? baseName(a.to) : null, newParentUid);
                    remote.cacheMovePath(a.from, a.to);
                    const local = statSync(abs(a.to));
                    const keep = st.pinnedHas(a.from);
                    st.syncDel(a.from);
                    st.syncSet({
                        path: a.to,
                        uid: rnFrom.uid,
                        type: 'file',
                        lsize: local.size,
                        lmtime: local.mtimeMs,
                        rsize: rSize(rnFrom),
                        rmtime: rMtime(rnFrom),
                    });
                    if (keep) st.pinnedSet(a.to);
                    break;
                }
                case 'download': {
                    await remote.downloadFileRemote({ uid: a.uid, abs: abs(a.p), expectSize: a.size, mtimeMs: a.mtimeMs });
                    st.syncSet({
                        path: a.p,
                        uid: a.uid,
                        type: 'file',
                        lsize: a.size,
                        lmtime: a.mtimeMs,
                        rsize: a.size,
                        rmtime: a.mtimeMs,
                    });
                    break;
                }
                case 'adoptOnline': {
                    // placeholder-only: no bytes fetched (same convention as hydrate's
                    // post-download syncSet + onlineDel, mirrored as syncSet + onlineSet)
                    st.syncSet({
                        path: a.p,
                        uid: a.uid,
                        type: 'file',
                        lsize: a.size,
                        lmtime: a.mtimeMs,
                        rsize: a.size,
                        rmtime: a.mtimeMs,
                    });
                    st.onlineSet(a.p, 0);
                    break;
                }
                case 'upload': {
                    await doUpload(a.p, a.existingUid, s);
                    break;
                }
                case 'conflict': {
                    // 1. preserve remote content as a local conflict copy
                    if (!st.syncGet(a.conflictRel) && !existsSync(abs(a.conflictRel))) {
                        await remote.downloadFileRemote({
                            uid: a.uid,
                            abs: abs(a.conflictRel),
                            expectSize: a.size,
                            mtimeMs: a.mtimeMs,
                        });
                    }
                    if (!st.syncGet(a.conflictRel)) {
                        await doUpload(a.conflictRel, null, s);
                    }
                    // 2. local wins: upload local content to the main path
                    await doUpload(a.p, a.uid, s);
                    break;
                }
                case 'rmLocal': {
                    try {
                        if (a.dir) rmdirSync(abs(a.p));
                        else unlinkSync(abs(a.p));
                        st.syncDel(a.p);
                    } catch (e) {
                        if (a.dir && isEnotempty(e)) {
                            const parentUid = resolveParentUid(parentRel(a.p), s);
                            if (parentUid) {
                                const uid = await remote.createFolderRemote(parentUid, baseName(a.p));
                                remote.cachePut({ path: a.p, uid, type: 'dir', size: null, mtime: null });
                                st.syncSet({ path: a.p, uid, type: 'dir', lsize: null, lmtime: null, rsize: null, rmtime: null });
                                log('INFO', `kept non-empty local dir and re-created it remotely: ${a.p}`);
                            }
                        } else if (isEnoent(e)) {
                            st.syncDel(a.p);
                        } else {
                            throw e;
                        }
                    }
                    break;
                }
                case 'trashRemote': {
                    if (trashedDirs.some((d) => a.p === d || a.p.startsWith(d + '/'))) {
                        st.syncDel(a.p);
                        break;
                    }
                    await remote.trashRemoteUid(a.uid);
                    // a dir cascade trashes every descendant server-side: drop the whole
                    // subtree from the cache, or the next incremental pass sees "remote
                    // present" children and resurrects them (local gone + no baseline → download)
                    remote.cacheRemoveSubtree(a.p);
                    st.syncDel(a.p);
                    if (a.dir) trashedDirs.push(a.p);
                    break;
                }
            }
        } catch (e) {
            s.errors++;
            s.lastError = `${a.phase} ${'p' in a ? a.p : `${a.from} -> ${a.to}`}: ${remote.errMsg(e)}`;
            log('ERROR', s.lastError, e);
            if (remote.isAuthError(e)) {
                s.authFailed = true;
                break;
            }
        }
    }
}

export async function runPass(opts: { forceFull: boolean; dry?: boolean }): Promise<PassStats> {
    const dry = opts.dry === true;
    const t0 = Date.now();
    const s: PassStats = { uploads: 0, downloads: 0, deletes: 0, renames: 0, conflicts: 0, adopts: 0, errors: 0, lastError: null, authFailed: false };

    let R: Map<string, st.CacheRow>;
    const wantFull = opts.forceFull || remote.takeForceFull() || passCount % fullWalkEvery === 0;
    try {
        if (wantFull) {
            const walked = await remote.walkRemoteMap();
            const baseline = st.syncAll();
            remote.sanityCheckRemoteMap(walked, baseline.size);
            R = walked;
            remote.commitRemoteMap(R);
        } else {
            R = remote.incrementalRemoteMap();
        }
    } catch (e) {
        s.lastError = remote.errMsg(e);
        if (remote.isAuthError(e)) {
            s.authFailed = true;
            setStatus({ state: 'auth-required', lastError: s.lastError });
            log('ERROR', `auth failure during remote scan: ${s.lastError}`);
            return s;
        }
        log('WARN', `remote scan failed, using cached remote view: ${s.lastError}`);
        R = remote.incrementalRemoteMap();
    }

    const L = await walkLocal();
    if (wantFull) log('INFO', `scan: local=${L.size} remote=${R.size} baseline=${st.syncAll().size}`);
    const S = st.syncAll();

    // online-only marker normalization (defense on top of the syncDel choke point):
    // a marker whose file is back on disk is stale; a marker with no baseline row
    // has no facts to pin from, so drop it here rather than let classify act on it.
    // (The `marked ∧ ∉ baseline` backstop also runs post-pass as onlinePrune.)
    const online = st.onlineAll();
    if (!dry) {
        for (const [p] of online) {
            if (L.has(p) || !S.has(p)) {
                st.onlineDel(p);
                online.delete(p);
            }
        }
    }

    const actions = classify(L, R, S, online, s, dry);
    if (dry) {
        reportDry(actions);
    } else {
        await execute(actions, R, s);

        // rows whose both sides are gone
        for (const [p] of S) {
            if (!L.has(p) && !R.has(p)) st.syncDel(p);
        }

        // post-pass prune: markers whose baseline row vanished (I3: syncDel is the
        // primary dropper; this is the defensive backstop)
        st.onlinePrune();
        st.pinnedPrune();

        totals.uploads += s.uploads;
        totals.downloads += s.downloads;
        totals.deletes += s.deletes;
        totals.renames += s.renames;
        totals.conflicts += s.conflicts;
        totals.errors += s.errors;
    }
    passCount++;

    setStatus({
        state: s.authFailed ? 'auth-required' : 'running',
        lastPassAt: new Date().toISOString(),
        lastPassMs: Date.now() - t0,
        lastError: s.lastError,
        eventsDrained: remote.drainedCount(),
        counts: {
            tracked: st.syncAll().size,
            ...totals,
            placeholders: st.onlineCount(),
            reclaimable: st.reclaimableBytes(),
        },
    });
    void remote.refreshStorage();
    log(
        'INFO',
        `pass#${passCount}${dry ? ' [DRY]' : ''} full=${wantFull ? 1 : 0} ${Date.now() - t0}ms ` +
            `up=${s.uploads} dl=${s.downloads} del=${s.deletes} ren=${s.renames} con=${s.conflicts} ` +
            (dry ? `adopt=${s.adopts} ` : '') +
            `err=${s.errors}`,
    );
    return s;
}

// Dry-run detail: group planned actions by type, sample paths per type.
function reportDry(actions: Action[]): void {
    const byPhase = new Map<string, string[]>();
    for (const a of actions) {
        const desc =
            a.phase === 'renameLocal' || a.phase === 'renameRemote'
                ? `${a.from} -> ${a.to}`
                : a.phase === 'conflict'
                  ? `${a.p}  (remote kept as: ${a.conflictRel})`
                  : a.p;
        const list = byPhase.get(a.phase);
        if (list) list.push(desc);
        else byPhase.set(a.phase, [desc]);
    }
    if (byPhase.size === 0) {
        log('INFO', 'dry: no changes needed');
        return;
    }
    const order = ['mkdirLocal', 'mkdirRemote', 'renameLocal', 'renameRemote', 'download', 'adoptOnline', 'upload', 'conflict', 'rmLocal', 'trashRemote'];
    for (const phase of order) {
        const list = byPhase.get(phase);
        if (!list) continue;
        const shown = list.slice(0, 15);
        log(
            'INFO',
            `dry ${phase} (${list.length}): ${shown.join(', ')}${list.length > shown.length ? ` ... +${list.length - shown.length} more` : ''}`,
        );
    }
}
