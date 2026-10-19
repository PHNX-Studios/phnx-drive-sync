import { existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import { localRoot, rpcSocket, treeRoot } from './config';
import { isOffline } from './connectivity';
import { log } from './log';
import { isAuthError, isOfflineError } from './remote';
import * as st from './state';

export interface PinResult {
    path: string;
    ok: boolean;
    note?: string;
}

/** Whether a file's bytes are on this device (`local`) or only remote (`online`). */
export type EntryPresence = 'local' | 'online';
/** Sync state of a file relative to the baseline (`n/a` for folders). */
export type EntrySync = 'clean' | 'dirty' | 'unsynced' | 'n/a';

/** One directory entry for the GUI file browser (status only; the engine owns the semantics). */
export interface ListEntry {
    /** Path relative to the sync root ('' is the root itself). */
    path: string;
    name: string;
    type: 'file' | 'dir';
    presence: EntryPresence;
    sync: EntrySync;
    /** keep-on-this-device mark (`pinned` table) */
    pinned: boolean;
    size: number | null;
    mtime: number | null;
}

export interface RpcRequest {
    op: 'pin' | 'unpin' | 'hydrate' | 'mv' | 'trash' | 'evict' | 'prefetch' | 'list' | 'sync';
    paths: string[];
}

export interface RpcResponse {
    ok: boolean;
    /**
     * Machine-readable failure class. `offline` lets the sidecar map the failure
     * to `ENETDOWN` (and the CLI/GUI render "you're offline") instead of a
     * generic `EIO`; `auth` distinguishes a session problem from connectivity.
     */
    code?: 'offline' | 'auth' | 'not-found' | 'malformed';
    error?: string;
    /** Engine connectivity at response time (always present; drives sidecar prefetch gating). */
    offline?: boolean;
    results?: PinResult[];
    /** `list` only: per-entry status of one directory. */
    entries?: ListEntry[];
    placeholders?: number;
}

export interface RpcHandlers {
    pin: (paths: string[]) => Promise<PinResult[]>;
    unpin: (paths: string[]) => Promise<PinResult[]>;
    hydrate: (paths: string[]) => Promise<PinResult[]>;
    mv: (paths: string[]) => Promise<PinResult[]>;
    trash: (paths: string[]) => Promise<PinResult[]>;
    evict: (paths: string[]) => Promise<PinResult[]>;
    prefetch: (paths: string[]) => Promise<PinResult[]>;
    /** Read-only: per-entry status under a directory ('' = sync root). */
    list: (paths: string[]) => Promise<ListEntry[]>;
    /** Trigger an incremental pass (the GUI "Sync now"); no paths. */
    sync: (paths: string[]) => Promise<PinResult[]>;
}

/** null = any non-empty path list; number = exact arity (mv = [from, to]; sync = none). */
const OP_ARITY: Record<RpcRequest['op'], number | null> = {
    pin: null,
    unpin: null,
    hydrate: 1,
    mv: 2,
    trash: 1,
    evict: null,
    prefetch: 1,
    list: 1,
    sync: 0,
};

/**
 * Per-op path validation.
 *
 * - `sync` takes no paths at all.
 * - `list` takes exactly one directory path and allows '' (the sync root).
 * - everything else takes one or more non-empty, traversal-free relative paths.
 */
function pathsOk(op: RpcRequest['op'], arity: number | null, paths: unknown): paths is string[] {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return false;
    if (arity === 0) return paths.length === 0;
    if (op === 'list') return paths.length === 1 && !paths[0].startsWith('/') && !paths[0].split('/').includes('..');
    if (arity !== null && paths.length !== arity) return false;
    return paths.length > 0 && paths.every((p) => p !== '' && !p.split('/').includes('..'));
}

let server: Server | null = null;

/** Server side: one JSON-line request per connection, one JSON-line response, then close. */
export function startRpcServer(handlers: RpcHandlers): void {
    try {
        if (existsSync(rpcSocket)) unlinkSync(rpcSocket); // stale socket from a crashed daemon
    } catch {
        /* ignore */
    }
    server = createServer((sock) => {
        let buf = '';
        let handled = false;
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => {
            if (handled) return;
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl === -1) return;
            handled = true;
            void dispatch(buf.slice(0, nl), handlers, sock);
        });
        sock.on('error', () => {
            /* client went away mid-request */
        });
    });
    server.on('error', (e) => log('ERROR', 'rpc server error', e));
    server.listen(rpcSocket);
    log('INFO', `rpc listening on ${rpcSocket}`);
}

export function stopRpcServer(): void {
    if (!server) return;
    try {
        server.close();
    } catch {
        /* ignore */
    }
    server = null;
    try {
        unlinkSync(rpcSocket);
    } catch {
        /* ignore */
    }
}

/** Map a thrown handler error to the machine-readable response class (or undefined). */
export function errorCode(e: unknown): RpcResponse['code'] {
    if (isOfflineError(e)) return 'offline';
    if (isAuthError(e)) return 'auth';
    return undefined;
}

async function dispatch(line: string, handlers: RpcHandlers, sock: Socket): Promise<void> {
    let resp: RpcResponse;
    try {
        const req = JSON.parse(line) as RpcRequest;
        const arity = OP_ARITY[req.op];
        if (arity === undefined || !pathsOk(req.op, arity, req.paths)) {
            resp = { ok: false, code: 'malformed', error: 'malformed request' };
        } else if (req.op === 'list') {
            resp = { ok: true, entries: await handlers.list(req.paths) };
        } else {
            const results = await handlers[req.op](req.paths);
            resp = { ok: true, results, placeholders: st.onlineCount() };
        }
    } catch (e) {
        resp = { ok: false, error: e instanceof Error ? e.message : String(e) };
        const code = errorCode(e);
        if (code) resp.code = code;
    }
    // connectivity is stamped on every response (including failures) so the
    // sidecar can cheaply gate prefetch and map offline failures to ENETDOWN.
    resp.offline = isOffline();
    try {
        sock.write(JSON.stringify(resp) + '\n');
        sock.end();
    } catch {
        /* client gone */
    }
}

function toRel(raw: string): string {
    let abs = path.resolve(raw.startsWith('file://') ? decodeURIComponent(raw.slice(7)) : raw);
    while (abs.length > 1 && abs.endsWith('/')) abs = abs.slice(0, -1);
    const strip = (root: string): string | null => {
        const p = root.endsWith('/') ? root : root + '/';
        return abs.startsWith(p) ? abs.slice(p.length) : null;
    };
    if (abs === localRoot || abs === treeRoot) {
        throw new Error(`select files or folders inside the sync root, not the root itself: ${raw}`);
    }
    const rel = strip(localRoot) ?? strip(treeRoot);
    if (rel === null || rel === '') throw new Error(`path is outside the sync root (${localRoot}): ${raw}`);
    return rel;
}

function call(req: RpcRequest, timeoutMs: number): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
        const sock = createConnection(rpcSocket);
        let buf = '';
        let settled = false;
        const fail = (err: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            reject(err);
        };
        const timer = setTimeout(() => fail(new Error('timed out waiting for the engine')), timeoutMs);
        sock.setEncoding('utf8');
        sock.on('connect', () => {
            console.error('engine acknowledged; waiting for it to finish...');
            sock.write(JSON.stringify(req) + '\n');
        });
        sock.on('data', (chunk: string) => {
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl === -1) return;
            settled = true;
            clearTimeout(timer);
            try {
                resolve(JSON.parse(buf.slice(0, nl)) as RpcResponse);
            } catch {
                reject(new Error('bad response from engine'));
            }
            sock.end();
        });
        sock.on('error', (e) => {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ECONNREFUSED') fail(new Error('engine is not running'));
            else fail(new Error(`rpc: ${e.message}`));
        });
        sock.on('close', () => fail(new Error('engine closed the connection unexpectedly')));
    });
}

/** Client side: returns the process exit code. No lock, no remote connection. */
export async function rpcClient(op: 'pin' | 'unpin' | 'evict' | 'prefetch', rawPaths: string[]): Promise<number> {
    let rels: string[];
    if (op === 'prefetch') {
        const v = (rawPaths[0] ?? '').toLowerCase();
        if (!['on', 'off', 'status'].includes(v) || rawPaths.length > 1) {
            console.error('usage: phnx-drive-sync prefetch on|off|status');
            return 64;
        }
        rels = [v];
    } else if (rawPaths.length === 0) {
        if (op !== 'evict') {
            console.error(`usage: phnx-drive-sync ${op} <path>...`);
            return 64;
        }
        rels = ['*']; // evict without paths = every reclaimable file (bulk "Free up space")
    } else {
        try {
            rels = [...new Set(rawPaths.map(toRel))];
        } catch (e) {
            console.error(`phnx-drive-sync: ${e instanceof Error ? e.message : String(e)}`);
            return 64;
        }
    }
    let resp: RpcResponse;
    try {
        resp = await call({ op, paths: rels }, 30 * 60_000);
    } catch (e) {
        console.error(`phnx-drive-sync: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    if (!resp.ok) {
        if (resp.code === 'offline') {
            console.error(`phnx-drive-sync: you're offline - ${resp.error ?? "this needs internet"}`);
            return 2;
        }
        console.error(`phnx-drive-sync: ${resp.error ?? 'request failed'}`);
        return 1;
    }
    let failed = 0;
    let offlineFailed = 0;
    for (const r of resp.results ?? []) {
        const note = r.note ? `  (${r.note})` : '';
        if (r.ok) console.log(`ok   ${r.path}${note}`);
        else {
            failed++;
            if (r.note?.startsWith('offline:')) offlineFailed++;
            console.error(`FAIL ${r.path}${note}`);
        }
    }
    // collapse N identical offline failures into one actionable line
    if (offlineFailed > 0) {
        console.error(`phnx-drive-sync: you're offline - ${offlineFailed} file(s) need internet to download.`);
    }
    if (typeof resp.placeholders === 'number') console.error(`online-only files now: ${resp.placeholders}`);
    return failed > 0 ? 2 : 0;
}
