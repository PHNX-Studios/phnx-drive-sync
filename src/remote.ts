import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';

import {
    ConnectionError,
    DriveEventType,
    FeatureFlags,
    NodeType,
    SDKEvent,
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

// "Failed to load session from secrets/pass": the keyring or gpg-agent is locked or
// missing. That is transient (it can unlock later), not a rejected session.
const KEYRING_UNAVAILABLE_RE = /failed to (load|save) session (from|in) (secrets|pass)/i;
const AUTH_MESSAGE_RE =
    /401|403|unauthorized|forbidden|session|refresh.?token|invalid (access|refresh) token|access token|not logged in|2fa|two.?factor|authentication|login required/i;

function isAuthStatus(n: unknown): boolean {
    return n === 401 || n === 403;
}

/**
 * Classify a throwable as "the session is not usable": structural signals first
 * (SDK `APIHTTPError.statusCode`, `APICodeError.code`, `AccountApiError.httpCode`,
 * an HTTP `response.status`, the `cause` chain), then the message wording.
 */
export function isAuthError(e: unknown, depth = 0): boolean {
    if (e instanceof AuthRequiredError) return true;
    // checked before any structural/cause signal: these are never a rejected session
    if (e instanceof SessionKeptError || KEYRING_UNAVAILABLE_RE.test(errMsg(e))) return false;
    if (e && typeof e === 'object') {
        const o = e as {
            name?: unknown;
            statusCode?: unknown;
            httpCode?: unknown;
            code?: unknown;
            response?: { status?: unknown } | null;
            cause?: unknown;
        };
        if (o.name === 'AuthRequiredError') return true;
        if (isAuthStatus(o.statusCode) || isAuthStatus(o.httpCode) || isAuthStatus(o.code)) return true;
        if (isAuthStatus(o.response?.status)) return true;
        if (o.cause !== undefined && depth < 4 && isAuthError(o.cause, depth + 1)) return true;
    }
    return AUTH_MESSAGE_RE.test(errMsg(e));
}

/** The credential store still holds a session (so an auth-looking failure was a transient refresh problem). */
export function sessionKept(): boolean {
    return app?.auth?.isLoggedIn?.() === true;
}

export function isAbortError(e: unknown): boolean {
    return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
}

/**
 * Engine-side "I would have touched the network, but we know we are offline".
 *
 * Thrown by the hydrate/mv/trash/pin paths when connectivity is already known to
 * be down, so the failure is instant (no SDK retries) and carries a machine-
 * readable class over RPC (`{ ok:false, code:'offline' }`) the sidecar maps to
 * `ENETDOWN` and the CLI/GUI render as "you're offline".
 */
export class OfflineError extends Error {
    name = 'OfflineError';
    constructor(message = 'offline') {
        super(message);
    }
}

export function isOfflineError(e: unknown): boolean {
    return e instanceof OfflineError || (e instanceof Error && e.name === 'OfflineError');
}

/** The remote session is missing or rejected; carries `code:'auth'` over RPC (sidecar: EACCES). */
export class AuthRequiredError extends Error {
    name = 'AuthRequiredError';
    constructor(message = 'authentication required - run: phnx-drive-sync login') {
        super(message);
    }
}

/**
 * The server answered 401 but the stored session is still there: the SDK only signs
 * out when a token refresh is refused with a 4xx (not 429/5xx), so this is a
 * transient refresh failure and must be retried, not reported as "sign in".
 */
export class SessionKeptError extends Error {
    name = 'SessionKeptError';
}

/** The engine is up but has no remote connection yet; `code:'unavailable'` (sidecar: ENOTCONN). */
export class RemoteUnavailableError extends Error {
    name = 'RemoteUnavailableError';
    constructor(message = 'engine is not connected to Proton Drive yet') {
        super(message);
    }
}

/** A download made no progress for too long; `code:'timeout'` (sidecar: ETIMEDOUT). */
export class HydrateTimeoutError extends Error {
    name = 'HydrateTimeoutError';
    constructor(message = 'download stalled') {
        super(message);
    }
}

function isTransientTransportError(message: string | undefined): boolean {
    if (!message) return false;
    const lower = message.toLowerCase();
    return (
        lower.includes('socket connection was closed unexpectedly') ||
        lower.includes('other side closed') ||
        lower.includes('socket hang up')
    );
}

function hasTransientTransportCode(e: Error): boolean {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET';
}

/**
 * Classify a throwable as a network/connectivity failure.
 *
 * Mirrors the SDK's internal classifier (`vendor/client/js/src/internal/errors.ts`)
 * but is engine-owned and dependency-free, so it also catches errors that leak
 * through from the HTTP stack as plain `Error`/`TypeError`/`FetchError` with a
 * transient `code` or a `cause` chain.
 *
 * Callers MUST check `isAuthError` first: a 401/403 is an auth problem, not
 * connectivity.
 */
export function isNetworkError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    if (
        e instanceof ConnectionError ||
        e.name === 'ConnectionError' ||
        e.name === 'OfflineError' ||
        e.name === 'NetworkError' ||
        e.name === 'FetchError'
    ) {
        return true;
    }
    if (e.message?.toLowerCase() === 'network error') return true;
    if (
        e.name === 'TypeError' &&
        ['Failed to fetch', 'NetworkError when attempting to fetch resource', 'Load failed'].includes(e.message)
    ) {
        return true;
    }
    if (isTransientTransportError(e.message) || hasTransientTransportCode(e)) return true;
    if (e.cause instanceof Error) {
        return isTransientTransportError(e.cause.message) || hasTransientTransportCode(e.cause);
    }
    return false;
}

/**
 * SDK already knows it is offline (after N consecutive offline errors) or that
 * transfers may resume again. Wired by `connectivity.ts` once the SDK is ready.
 */
export interface SdkConnectivityHandlers {
    paused: () => void;
    resumed: () => void;
}

let connectivityHandlers: SdkConnectivityHandlers | null = null;

/** Register the paused/resumed observers before `initRemote()`. */
export function onConnectivity(handlers: SdkConnectivityHandlers): void {
    connectivityHandlers = handlers;
}

/** Subscribe to the SDK's transfersPaused/transfersResumed events (called by initRemote). */
function subscribeSdkEvents(client: ProtonDriveClient): void {
    try {
        client.onMessage(SDKEvent.TransfersPaused, () => connectivityHandlers?.paused());
        client.onMessage(SDKEvent.TransfersResumed, () => connectivityHandlers?.resumed());
    } catch (e) {
        log('WARN', `could not subscribe to SDK connectivity events: ${errMsg(e)}`);
    }
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

/**
 * Tear down a partially/fully initialised SDK without blocking: used between
 * boot retries (a network failure can leave an app handle behind) and by
 * shutdownRemote. Never throws.
 */
async function resetRemote(): Promise<void> {
    stopEventLoop();
    const previous = app;
    app = null;
    sdk = null;
    remoteRootUid = '';
    eventScope = '';
    if (!previous) return;
    try {
        await Promise.race([previous.dispose(), sleep(2000)]);
    } catch {
        /* disposing is best-effort */
    }
}

let initImpl: typeof init = init;
let shutDown = false;

/** Test seam: swap the vendor `init` (no keyring/network) and restore it with no argument. */
export function _setInitForTest(fn?: typeof init): void {
    initImpl = fn ?? init;
    shutDown = false;
}

/**
 * Connect to Proton Drive. Every attempt starts from scratch and a failed one
 * tears itself down (app handle, crypto endpoint, event loop), so a retry after
 * an auth or network failure sees the same clean state as the first boot.
 */
export async function initRemote(): Promise<void> {
    if (shutDown) throw new Error('engine is stopping');
    await resetRemote(); // clean up a previous partial attempt before retrying
    try {
        await connectApp();
    } catch (e) {
        let err = e;
        if (isAuthError(e) && sessionKept()) {
            err = new SessionKeptError(`session refresh failed but the stored session is kept (will retry): ${errMsg(e)}`, {
                cause: e,
            });
        }
        await resetRemote();
        throw err;
    }
}

async function connectApp(): Promise<void> {
    const created = await initImpl({
        appVersion: APP_VERSION,
        clientUidPrefix: CLIENT_UID_PREFIX,
        enablePersistedEvents: false,
        enableConsoleLog: false,
        enableMetrics: false,
        flags: { [FeatureFlags.DriveSmallFileUpload]: true },
    });
    app = created;
    // shutdown abandoned this attempt while it was in flight: do not leave a live app behind
    if (shutDown) throw new Error('engine is stopping');
    sdk = app.sdk;
    subscribeSdkEvents(sdk);
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
    shutDown = true;
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

/** Remove a path and every cached descendant (server-side cascade trash drops them all). */
export function cacheRemoveSubtree(p: string): void {
    for (const row of st.cacheAll()) {
        if (row.path === p || row.path.startsWith(p + '/')) {
            if (uidIndex.get(row.uid) === row.path) uidIndex.delete(row.uid);
            st.cacheDel(row.path);
        }
    }
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
    /** Aborts the download; the abort reason (if an Error) is what the caller sees. */
    signal?: AbortSignal;
    /** Give up when no bytes arrive for this long (0/undefined: never). */
    stallMs?: number;
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
    const abort = new AbortController();
    const onExternalAbort = () => abort.abort(o.signal?.reason);
    if (o.signal?.aborted) onExternalAbort();
    else o.signal?.addEventListener('abort', onExternalAbort, { once: true });
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        if (!o.stallMs || o.stallMs <= 0) return;
        stallTimer = setTimeout(() => {
            abort.abort(new HydrateTimeoutError(`download stalled: no data for ${Math.round(o.stallMs! / 1000)}s`));
        }, o.stallMs);
    };
    try {
        armStall();
        // the SDK's own signal aborts the transfer for real (no orphaned download
        // finishing later); progress re-arms the stall timer
        const downloader = await requireSdk().getFileDownloader(o.uid, abort.signal);
        const ctrl = downloader.downloadToStream(ws, armStall);
        await ctrl.completion();
        // bytes are complete: from here to the rename nothing may abort (I5), and
        // everything up to `return` is synchronous
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = null;
        o.signal?.removeEventListener('abort', onExternalAbort);
        if (ctrl.isDownloadCompleteWithSignatureIssues()) throw new Error('download completed with signature issues');
        endSink();
        const size = statSync(tmp).size;
        if (o.expectSize !== null && o.expectSize > 0 && size !== o.expectSize) {
            throw new Error(`download size mismatch: got ${size}, expected ${o.expectSize}`);
        }
        renameSync(tmp, o.abs);
        utimesSync(o.abs, new Date(o.mtimeMs), new Date(o.mtimeMs));
    } catch (e) {
        endSink();
        try {
            if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        const reason: unknown = abort.signal.aborted ? abort.signal.reason : undefined;
        throw reason instanceof Error ? reason : e;
    } finally {
        if (stallTimer) clearTimeout(stallTimer);
        o.signal?.removeEventListener('abort', onExternalAbort);
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
