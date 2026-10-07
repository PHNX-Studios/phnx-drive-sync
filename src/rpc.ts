import { existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import { localRoot, rpcSocket, treeRoot } from './config';
import { log } from './log';
import * as st from './state';

export interface PinResult {
    path: string;
    ok: boolean;
    note?: string;
}

export interface RpcRequest {
    op: 'pin' | 'unpin' | 'hydrate' | 'mv' | 'trash';
    paths: string[];
}

export interface RpcResponse {
    ok: boolean;
    error?: string;
    results?: PinResult[];
    placeholders?: number;
}

export interface RpcHandlers {
    pin: (paths: string[]) => Promise<PinResult[]>;
    unpin: (paths: string[]) => Promise<PinResult[]>;
    hydrate: (paths: string[]) => Promise<PinResult[]>;
    mv: (paths: string[]) => Promise<PinResult[]>;
    trash: (paths: string[]) => Promise<PinResult[]>;
}

/** null = any non-empty path list; number = exact arity (mv = [from, to]). */
const OP_ARITY: Record<RpcRequest['op'], number | null> = { pin: null, unpin: null, hydrate: 1, mv: 2, trash: 1 };

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

async function dispatch(line: string, handlers: RpcHandlers, sock: Socket): Promise<void> {
    let resp: RpcResponse;
    try {
        const req = JSON.parse(line) as RpcRequest;
        const arity = OP_ARITY[req.op];
        const pathsOk =
            arity !== undefined &&
            Array.isArray(req.paths) &&
            req.paths.length > 0 &&
            (arity === null || req.paths.length === arity) &&
            req.paths.every((p) => typeof p === 'string' && p !== '' && !p.split('/').includes('..'));
        if (!pathsOk) {
            resp = { ok: false, error: 'malformed request' };
        } else {
            const results = await handlers[req.op](req.paths);
            resp = { ok: true, results, placeholders: st.onlineCount() };
        }
    } catch (e) {
        resp = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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
export async function rpcClient(op: 'pin' | 'unpin', rawPaths: string[]): Promise<number> {
    if (rawPaths.length === 0) {
        console.error(`usage: drive-sync ${op} <path>...`);
        return 64;
    }
    let rels: string[];
    try {
        rels = [...new Set(rawPaths.map(toRel))];
    } catch (e) {
        console.error(`drive-sync: ${e instanceof Error ? e.message : String(e)}`);
        return 64;
    }
    let resp: RpcResponse;
    try {
        resp = await call({ op, paths: rels }, 30 * 60_000);
    } catch (e) {
        console.error(`drive-sync: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    if (!resp.ok) {
        console.error(`drive-sync: ${resp.error ?? 'request failed'}`);
        return 1;
    }
    let failed = 0;
    for (const r of resp.results ?? []) {
        const note = r.note ? `  (${r.note})` : '';
        if (r.ok) console.log(`ok   ${r.path}${note}`);
        else {
            failed++;
            console.error(`FAIL ${r.path}${note}`);
        }
    }
    if (typeof resp.placeholders === 'number') console.error(`online-only files now: ${resp.placeholders}`);
    return failed > 0 ? 2 : 0;
}
