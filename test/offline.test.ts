import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';

import { rpcSocket } from '../src/config';
import { isOffline, reportNetworkError, setOffline } from '../src/connectivity';
import { _resetForTest } from '../src/connectivity';
import { OfflineError } from '../src/remote';
import { errorCode, startRpcServer, stopRpcServer, type RpcHandlers, type RpcResponse } from '../src/rpc';
import { resetState } from './helpers';

function stubHandlers(over: Partial<RpcHandlers> = {}): RpcHandlers {
    const ok = async (paths: string[]) => paths.map((p) => ({ path: p, ok: true }));
    return {
        pin: ok,
        unpin: ok,
        hydrate: ok,
        mv: ok,
        trash: ok,
        evict: ok,
        prefetch: ok,
        list: async () => [],
        sync: ok,
        ...over,
    };
}

function rpcRaw(op: string, paths: string[]): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
        const sock = createConnection(rpcSocket);
        let buf = '';
        const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error('test rpc timeout'));
        }, 5000);
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(JSON.stringify({ op, paths }) + '\n'));
        sock.on('data', (chunk: string) => {
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl === -1) return;
            clearTimeout(timer);
            resolve(JSON.parse(buf.slice(0, nl)) as RpcResponse);
            sock.end();
        });
        sock.on('error', reject);
    });
}

afterEach(() => {
    stopRpcServer();
    _resetForTest();
    resetState();
});

describe('errorCode mapping', () => {
    test('classifies offline, auth and other errors', () => {
        expect(errorCode(new OfflineError('offline'))).toBe('offline');
        const auth = new Error('401 Unauthorized');
        expect(errorCode(auth)).toBe('auth');
        expect(errorCode(new Error('boom'))).toBeUndefined();
    });
});

describe('RPC dispatch offline contract', () => {
    test('an offline hydrate fails with code=offline and offline=true', async () => {
        setOffline(true, 'link'); // the engine knows it is offline, so hydrateOne throws
        startRpcServer(stubHandlers({ hydrate: async () => { throw new OfflineError('offline: a.txt needs internet'); } }));
        const resp = await rpcRaw('hydrate', ['a.txt']);
        expect(resp.ok).toBe(false);
        expect(resp.code).toBe('offline');
        expect(resp.offline).toBe(true);
        expect(resp.error).toContain('offline');
    });

    test('every response stamps the current connectivity', async () => {
        startRpcServer(stubHandlers());
        const online = await rpcRaw('pin', ['a.txt']);
        expect(online.ok).toBe(true);
        expect(online.offline).toBe(false);

        setOffline(true, 'link');
        const offline = await rpcRaw('pin', ['a.txt']);
        expect(offline.ok).toBe(true);
        expect(offline.offline).toBe(true);
    });

    test('a malformed request is classified and never reaches a handler', async () => {
        let called = false;
        startRpcServer(stubHandlers({ hydrate: async (paths) => { called = true; return paths.map((p) => ({ path: p, ok: true })); } }));
        const resp = await rpcRaw('hydrate', ['a.txt', 'b.txt']); // arity 1
        expect(resp.ok).toBe(false);
        expect(resp.code).toBe('malformed');
        expect(called).toBe(false);
    });

    test('reactive failure flips the shared status before the next response', async () => {
        const offline = new Error('nope');
        offline.name = 'OfflineError';
        reportNetworkError(offline);
        expect(isOffline()).toBe(true);
        startRpcServer(stubHandlers());
        const resp = await rpcRaw('list', ['']);
        expect(resp.offline).toBe(true);
    });
});
