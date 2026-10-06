import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';

import {
    DriveEventType,
    FeatureFlags,
    NodeType,
    type DriveEvent,
    type NodeEntity,
    type ProtonDriveClient,
    type UploadMetadata,
} from '@protontech/drive-sdk';

import {
    APP_VERSION,
    CLIENT_UID_PREFIX,
    eventIdleTimeoutMs,
    isPartial,
    partialSuffix,
    remoteRootPath,
} from './config';
import { isFiltered } from './filters';
import { log, setStatus } from './log';
import * as st from './state';
import { init } from '../vendor/cli/src/init';

type App = Awaited<ReturnType<typeof init>>;

let app: App | null = null;
let sdk: ProtonDriveClient | null = null;

export let remoteRootUid = '';
export let eventScope = '';

const uidIndex = new Map<string, string>();
let forceFull = false;
let eventsDrained = 0;
let loopStop = false;

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function isNotFound(e: unknown): boolean {
    return /404|not[ _-]?found|missing|does not exist|no longer exist/i.test(errMsg(e));
}

export function isAuthError(e: unknown): boolean {
    return /401|403|unauthorized|forbidden|session|refresh.?token|2fa|two.?factor|authentication|login required/i.test(errMsg(e));
}

export function isAbortError(e: unknown): boolean {
    return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
}

export function unwrapName(node: NodeEntity): string | null {
    const n = node.name;
    if (typeof n === 'string') return n;
    if (n && typeof n === 'object' && 'ok' in n) return n.ok ? n.value : null;
    return null;
}

export function nodeFacts(node: NodeEntity): { size: number; mtimeMs: number } {
    const rev = node.activeRevision;
    const size = rev?.claimedSize ?? node.totalStorageSize ?? 0;
    const mtime =
        rev?.claimedModificationTime ??
        node.folder?.claimedModificationTime ??
        node.modificationTime;
    const mtimeMs = mtime instanceof Date ? mtime.getTime() : new Date(mtime as Date).getTime() || 0;
    return { size, mtimeMs };
}

function requireSdk(): ProtonDriveClient {
    if (!sdk) throw new Error('remote not initialized');
    return sdk;
}

// --- storage quota ---

const STORAGE_REFRESH_MS = 5 * 60_000;
let storageFetchedAt = 0;
let storageWarned = false;

interface CoreUserResponse {
    Code?: number;
    User?: {
        UsedSpace?: number;
        MaxSpace?: number;
        ProductUsedSpace?: { Drive?: number };
    };
}

export async function refreshStorage(force = false): Promise<void> {
    if (!app?.apiClient) return;
    if (!force && Date.now() - storageFetchedAt < STORAGE_REFRESH_MS) return;
    try {
        const res = await app.apiClient.authenticatedRequest.get(`${app.apiClient.baseUrlWithProtocol}/core/v4/users`);
        const body = (await res.json()) as CoreUserResponse;
        const u = body?.User;
        if (typeof u?.MaxSpace !== 'number' || typeof u.UsedSpace !== 'number') {
            throw new Error(`unexpected quota payload (Code=${body?.Code})`);
        }
        storageFetchedAt = Date.now();
        setStatus({
            storage: {
                used: u.UsedSpace,
                max: u.MaxSpace,
                driveUsed: u.ProductUsedSpace?.Drive ?? 0,
                fetchedAt: new Date().toISOString(),
            },
        });
    } catch (e) {
        if (!storageWarned) {
            storageWarned = true;
            log('WARN', `storage quota refresh failed (will keep trying quietly): ${errMsg(e)}`);
        }
    }
}

// --- lifecycle ---

export async function initRemote(): Promise<void> {
    app = await init({
        appVersion: APP_VERSION,
        clientUidPrefix: CLIENT_UID_PREFIX,
        enablePersistedEvents: false,
        enableConsoleLog: false,
        enableMetrics: false,
        flags: { [FeatureFlags.DriveSmallFileUpload]: true },
    });
    sdk = app.sdk;
    const root = await app.sdk.getMyFilesRootFolder();
    if (!root.treeEventScopeId) throw new Error('root folder has no tree event scope');
    eventScope = root.treeEventScopeId;
    let uid = root.uid;
    if (remoteRootPath) {
        for (const seg of remoteRootPath.split('/').filter(Boolean)) {
            uid = await resolveChildFolder(uid, seg);
        }
    }
    remoteRootUid = uid;
    st.metaSet('root_uid', remoteRootUid);
    st.metaSet('event_scope', eventScope);
    rebuildIndex();
    await catchUpEvents();
    await refreshStorage(true);
    log('INFO', `remote ready: root=${remoteRootUid} scope=${eventScope}`);
}

// Drain pending tree events before the first walk so the SDK's internal node
// cache (names/facts served on hydrate) reflects external renames/trash made
// while no engine process was running. Without a stored event id there is no
// backlog to replay: purge caches instead so the first hydration is fresh.
async function catchUpEvents(): Promise<void> {
    if (!eventScope) return;
    const hadId = st.metaGet(lastEventKey()) !== null;
    if (!hadId && app) {
        try {
            await app.clearCaches();
        } catch (e) {
            log('WARN', `cache purge failed: ${errMsg(e)}`);
        }
    }
    const ctrl = new AbortController();
    const t0 = Date.now();
    let timer = setTimeout(() => ctrl.abort(), 15_000);
    let drained = 0;
    try {
        const client = requireSdk();
        const lastId = st.metaGet(lastEventKey()) ?? undefined;
        for await (const ev of client.iterateEvents(eventScope, lastId, ctrl.signal)) {
            clearTimeout(timer);
            timer = setTimeout(() => ctrl.abort(), 5_000);
            if (ev.eventId && ev.eventId !== 'none') st.metaSet(lastEventKey(), ev.eventId);
            await applyEvent(ev, lastId !== undefined);
            drained++;
            if (drained > 10_000 || Date.now() - t0 > 120_000) {
                log('WARN', `event catch-up hit cap after ${drained} events; remainder next run`);
                break;
            }
        }
    } catch (e) {
        if (!isAbortError(e)) log('WARN', `event catch-up: ${errMsg(e)}`);
    } finally {
        clearTimeout(timer);
    }
    if (drained > 0) log('INFO', `event catch-up drained ${drained} event(s)${hadId ? '' : ' (seeded id, caches purged)'}`);
}

async function resolveChildFolder(parentUid: string, name: string): Promise<string> {
    const client = requireSdk();
    for await (const node of client.iterateFolderChildren(parentUid, { type: NodeType.Folder })) {
        if (unwrapName(node) === name) return node.uid;
    }
    const created = await client.createFolder(parentUid, name);
    log('INFO', `created remote folder /${name}`);
    return created.uid;
}

export async function shutdownRemote(): Promise<void> {
    stopEventLoop();
    if (app) {
        const disposing = app.dispose();
        // dispose can hang on lingering subscriptions/sockets; never block exit on it
        await Promise.race([disposing, sleep(4000).then(() => log('WARN', 'sdk dispose timed out; exiting anyway'))]);
        app = null;
        sdk = null;
    }
}

// --- remote cache + uid index ---

export function rebuildIndex(): void {
    uidIndex.clear();
    for (const row of st.cacheAll()) uidIndex.set(row.uid, row.path);
}

export function indexGet(uid: string): string | undefined {
    return uidIndex.get(uid);
}

export function cachePut(row: st.CacheRow): void {
    const occupant = st.cacheGet(row.path);
    if (occupant && occupant.uid !== row.uid) {
        if (uidIndex.get(occupant.uid) === row.path) uidIndex.delete(occupant.uid);
    }
    const prevPath = uidIndex.get(row.uid);
    if (prevPath !== undefined && prevPath !== row.path) st.cacheDel(prevPath);
    st.cacheSet(row);
    uidIndex.set(row.uid, row.path);
}

export function cacheRemovePath(p: string): void {
    const row = st.cacheGet(p);
    if (row && uidIndex.get(row.uid) === p) uidIndex.delete(row.uid);
    st.cacheDel(p);
}

export function cacheRemoveUid(uid: string): void {
    const p = uidIndex.get(uid);
    if (p !== undefined) st.cacheDel(p);
    uidIndex.delete(uid);
}

export function cacheMovePath(from: string, to: string): void {
    const row = st.cacheGet(from);
    if (!row) return;
    st.cacheRename(from, to);
    uidIndex.set(row.uid, to);
}

export function incrementalRemoteMap(): Map<string, st.CacheRow> {
    return new Map(st.cacheAll().map((r) => [r.path, r]));
}

export function commitRemoteMap(rows: Map<string, st.CacheRow>): void {
    st.cacheReplaceAll([...rows.values()]);
    rebuildIndex();
}

export function requestForceFull(): void {
    forceFull = true;
}

export function takeForceFull(): boolean {
    const v = forceFull;
    forceFull = false;
    return v;
}

export function drainedCount(): number {
    return eventsDrained;
}

// --- full remote walk ---

export async function walkRemoteMap(): Promise<Map<string, st.CacheRow>> {
    const client = requireSdk();
    const out = new Map<string, st.CacheRow>();
    const errors: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ uid: string; rel: string }> = [{ uid: remoteRootUid, rel: '' }];
    let visited = 0;
    while (queue.length > 0) {
        const cur = queue.shift()!;
        if (seen.has(cur.uid)) continue;
        seen.add(cur.uid);
        visited++;
        if (visited % 50 === 0) log('INFO', `remote walk: ${visited} folders, ${out.size} nodes, ${queue.length} queued`);
        try {
            for await (const node of client.iterateFolderChildren(cur.uid)) {
                const name = unwrapName(node);
                if (!name) {
                    errors.push(`undecryptable name under ${cur.rel || '/'}`);
                    continue;
                }
                const rel = cur.rel === '' ? name : `${cur.rel}/${name}`;
                if (rel === '.protonignore' || isPartial(rel) || isFiltered(rel)) continue;
                if (node.type === NodeType.Folder) {
                    out.set(rel, { path: rel, uid: node.uid, type: 'dir', size: null, mtime: null });
                    queue.push({ uid: node.uid, rel });
                } else if (node.type === NodeType.File) {
                    const f = nodeFacts(node);
                    out.set(rel, { path: rel, uid: node.uid, type: 'file', size: f.size, mtime: f.mtimeMs });
                }
            }
        } catch (e) {
            errors.push(`${cur.rel || '/'}: ${errMsg(e)}`);
        }
    }
    if (errors.length > 0) {
        throw new Error(`remote listing incomplete (${errors.length} errors): ${errors.slice(0, 5).join('; ')}`);
    }
    return out;
}

export function sanityCheckRemoteMap(map: Map<string, st.CacheRow>, baselineCount: number): void {
    if (map.size === 0 && baselineCount > 5) {
        throw new Error(`remote walk returned 0 nodes but ${baselineCount} synced rows exist; refusing to trust`);
    }
    if (baselineCount > 20 && map.size < baselineCount * 0.5) {
        throw new Error(`remote walk returned only ${map.size} of ~${baselineCount} expected nodes; refusing to trust`);
    }
}

// --- event loop ---

let loopAbort: AbortController | null = null;

function lastEventKey(): string {
    return `last_event_id:${eventScope}`;
}

export function startEventLoop(onChange: () => void): void {
    loopStop = false;
    void (async () => {
        let consecErrors = 0;
        while (!loopStop) {
            const ctrl = new AbortController();
            loopAbort = ctrl;
            let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => ctrl.abort(), eventIdleTimeoutMs);
            const resetIdle = () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => ctrl.abort(), eventIdleTimeoutMs);
            };
            try {
                const client = requireSdk();
                const lastId = st.metaGet(lastEventKey()) ?? undefined;
                for await (const ev of client.iterateEvents(eventScope, lastId, ctrl.signal)) {
                    resetIdle();
                    if (ev.eventId && ev.eventId !== 'none') st.metaSet(lastEventKey(), ev.eventId);
                    const relevant = await applyEvent(ev, lastId !== undefined);
                    eventsDrained++;
                    if (relevant && !loopStop) onChange();
                }
                consecErrors = 0;
                if (!loopStop) await sleep(1000);
            } catch (e) {
                if (ctrl.signal.aborted || isAbortError(e)) {
                    // idle window elapsed: normal reconnect
                } else {
                    consecErrors++;
                    log('WARN', `event stream error (${consecErrors}): ${errMsg(e)}`);
                    if (consecErrors >= 3) {
                        requestForceFull();
                        setStatus({ lastError: `event stream: ${errMsg(e)}` });
                    }
                    await sleep(Math.min(30_000, 1000 * 2 ** Math.min(consecErrors, 5)));
                }
            } finally {
                if (timer) clearTimeout(timer);
                loopAbort = null;
            }
        }
    })();
}

export function stopEventLoop(): void {
    loopStop = true;
    loopAbort?.abort();
}

async function applyEvent(ev: DriveEvent, hadLastId: boolean): Promise<boolean> {
    if (ev.type === DriveEventType.NodeCreated || ev.type === DriveEventType.NodeUpdated) {
        if (ev.isTrashed) {
            cacheRemoveUid(ev.nodeUid);
            return true;
        }
        let node: NodeEntity | { missingUid: string };
        try {
            node = await requireSdk().getNode(ev.nodeUid);
        } catch (e) {
            if (isNotFound(e)) {
                cacheRemoveUid(ev.nodeUid);
                return true;
            }
            log('WARN', `getNode failed for event ${ev.nodeUid}: ${errMsg(e)}`);
            requestForceFull();
            return true;
        }
        if ('missingUid' in node) {
            cacheRemoveUid(ev.nodeUid);
            return true;
        }
        return placeNode(node, ev.parentNodeUid);
    }
    if (ev.type === DriveEventType.NodeDeleted) {
        cacheRemoveUid(ev.nodeUid);
        return true;
    }
    if (ev.type === DriveEventType.TreeRefresh || ev.type === DriveEventType.TreeRemove) {
        requestForceFull();
        return true;
    }
    if (ev.type === DriveEventType.FastForward) {
        if (hadLastId) {
            log('WARN', 'fast-forward while processing events (possible gap); scheduling full refresh');
            requestForceFull();
            return true;
        }
        return false;
    }
    return false;
}

function placeNode(node: NodeEntity, parentNodeUid?: string): boolean {
    if (node.type !== NodeType.File && node.type !== NodeType.Folder) return false;
    const name = unwrapName(node);
    if (!name) {
        requestForceFull();
        return true;
    }
    const parent = parentNodeUid ?? node.parentUid;
    let parentRel = '';
    if (parent && parent !== remoteRootUid) {
        const p = uidIndex.get(parent);
        if (p === undefined) {
            requestForceFull();
            return true;
        }
        parentRel = p;
    }
    const rel = parentRel === '' ? name : `${parentRel}/${name}`;
    if (rel === '.protonignore' || isPartial(rel) || isFiltered(rel)) {
        cacheRemoveUid(node.uid);
        return true;
    }
    if (node.type === NodeType.Folder) {
        cachePut({ path: rel, uid: node.uid, type: 'dir', size: null, mtime: null });
    } else {
        const f = nodeFacts(node);
        cachePut({ path: rel, uid: node.uid, type: 'file', size: f.size, mtime: f.mtimeMs });
    }
    return true;
}

// --- operations ---

export async function createFolderRemote(parentUid: string, name: string): Promise<string> {
    const node = await requireSdk().createFolder(parentUid, name);
    return node.uid;
}

export async function uploadFileRemote(o: {
    abs: string;
    parentUid: string;
    name: string;
    size: number;
    mtimeMs: number;
    existingUid?: string;
}): Promise<{ nodeUid: string }> {
    const client = requireSdk();
    const meta: UploadMetadata = {
        mediaType: Bun.file(o.abs).type || 'application/octet-stream',
        expectedSize: o.size,
        modificationTime: new Date(o.mtimeMs),
        overrideExistingDraftByOtherClient: true,
    };
    const run = async (fresh: boolean) => {
        const uploader =
            !fresh && o.existingUid
                ? await client.getFileRevisionUploader(o.existingUid, meta)
                : await client.getFileUploader(o.parentUid, o.name, meta);
        const ctrl = await uploader.uploadFromStream(Bun.file(o.abs).stream(), []);
        return await ctrl.completion();
    };
    if (o.existingUid) {
        try {
            const { nodeUid } = await run(false);
            return { nodeUid };
        } catch (e) {
            if (!(await nodeGone(o.existingUid))) throw e;
            log('INFO', `remote node vanished, uploading fresh: ${o.name}`);
        }
    }
    const { nodeUid } = await run(true);
    return { nodeUid };
}

async function nodeGone(uid: string): Promise<boolean> {
    try {
        const n = (await requireSdk().getNode(uid)) as NodeEntity | { missingUid: string };
        if (n && typeof n === 'object' && 'missingUid' in n) return true;
        return false;
    } catch (e) {
        return isNotFound(e);
    }
}

export async function downloadFileRemote(o: {
    uid: string;
    abs: string;
    expectSize: number | null;
    mtimeMs: number;
}): Promise<void> {
    mkdirSync(path.dirname(o.abs), { recursive: true });
    const tmp = o.abs + partialSuffix;
    if (existsSync(tmp)) {
        try {
            unlinkSync(tmp);
        } catch {
            /* ignore */
        }
    }
    const sink = Bun.file(tmp).writer();
    let ended = false;
    const endSink = () => {
        if (!ended) {
            ended = true;
            try {
                sink.end();
            } catch {
                /* ignore */
            }
        }
    };
    const ws = new WritableStream<Uint8Array>({
        write: (chunk) => {
            sink.write(chunk);
        },
        close: endSink,
        abort: () => {
            endSink();
            try {
                unlinkSync(tmp);
            } catch {
                /* ignore */
            }
        },
    });
    try {
        const downloader = await requireSdk().getFileDownloader(o.uid);
        const ctrl = downloader.downloadToStream(ws);
        await ctrl.completion();
        if (ctrl.isDownloadCompleteWithSignatureIssues()) throw new Error('download completed with signature issues');
        endSink();
        const size = statSync(tmp).size;
        if (o.expectSize !== null && o.expectSize > 0 && size !== o.expectSize) {
            throw new Error(`download size mismatch: got ${size}, expected ${o.expectSize}`);
        }
        renameSync(tmp, o.abs);
        utimesSync(o.abs, new Date(o.mtimeMs), new Date(o.mtimeMs));
    } catch (e) {
        try {
            if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        throw e;
    }
}

export async function trashRemoteUid(uid: string): Promise<void> {
    for await (const res of requireSdk().trashNodes([uid])) {
        if (res.ok) return;
        if (isNotFound(res.error)) return;
        throw res.error;
    }
}

export async function moveRemoteUid(uid: string, newName: string | null, newParentUid: string | null): Promise<void> {
    const client = requireSdk();
    if (newName !== null) await client.renameNode(uid, newName);
    if (newParentUid !== null) {
        for await (const res of client.moveNodes([uid], newParentUid)) {
            if (!res.ok && !isNotFound(res.error)) throw res.error;
        }
    }
}
