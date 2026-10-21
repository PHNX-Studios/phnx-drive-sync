import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';

import { _resetForTest } from '../src/connectivity';
import { rpcSocket, treeRoot } from '../src/config';
import { RemoteGate } from '../src/gate';
import {
    _setInitForTest,
    AuthRequiredError,
    downloadFileRemote,
    HydrateTimeoutError,
    initRemote,
    OfflineError,
    RemoteUnavailableError,
} from '../src/remote';
import { startRpcServer, stopRpcServer, type RpcHandlers, type RpcResponse } from '../src/rpc';
import { resetState } from './helpers';

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

function handlersGatedBy(gate: RemoteGate): RpcHandlers {
    const gated = async (paths: string[]) => {
        await gate.readyForRemoteOp();
        return paths.map((p) => ({ path: p, ok: true }));
    };
    const plain = async (paths: string[]) => paths.map((p) => ({ path: p, ok: true }));
    return {
        pin: gated,
        unpin: plain,
        hydrate: gated,
        mv: gated,
        trash: gated,
        evict: plain,
        prefetch: plain,
        list: async () => [],
        sync: plain,
        reload: plain,
    };
}

afterEach(() => {
    stopRpcServer();
    _resetForTest();
    _setInitForTest();
    resetState();
});

describe('RemoteGate over RPC', () => {
    test('not connected yet: the op fails at once with code=unavailable', async () => {
        const gate = new RemoteGate(() => 60_000);
        startRpcServer(handlersGatedBy(gate));
        const t0 = Date.now();
        const resp = await rpcRaw('hydrate', ['a.txt']);
        expect(Date.now() - t0).toBeLessThan(500);
        expect(resp.ok).toBe(false);
        expect(resp.code).toBe('unavailable');
    });

    test('waiting for a sign-in: the op fails at once with code=auth', async () => {
        const gate = new RemoteGate(() => 60_000);
        gate.setState('auth-required');
        startRpcServer(handlersGatedBy(gate));
        const t0 = Date.now();
        const resp = await rpcRaw('hydrate', ['a.txt']);
        expect(Date.now() - t0).toBeLessThan(500);
        expect(resp.ok).toBe(false);
        expect(resp.code).toBe('auth');
    });

    test('a pending waiter is rejected when the initial pass fails auth', async () => {
        const gate = new RemoteGate(() => 60_000);
        gate.setState('ready'); // connected, initial pass still running
        startRpcServer(handlersGatedBy(gate));
        const pending = rpcRaw('hydrate', ['a.txt']);
        await Bun.sleep(100);
        expect(gate.waiterCount()).toBe(1);
        gate.setState('auth-required');
        gate.fail(new AuthRequiredError());
        const resp = await pending;
        expect(resp.ok).toBe(false);
        expect(resp.code).toBe('auth');
        expect(gate.waiterCount()).toBe(0);
    });
});

describe('RemoteGate', () => {
    test('offline and not connected is an OfflineError, not "unavailable"', async () => {
        const { setOffline } = await import('../src/connectivity');
        setOffline(true, 'link');
        const gate = new RemoteGate();
        await expect(gate.readyForRemoteOp()).rejects.toBeInstanceOf(OfflineError);
    });

    test('a waiter is released when the pass finishes', async () => {
        const gate = new RemoteGate(() => 60_000);
        gate.setState('ready');
        const waiting = gate.readyForRemoteOp();
        gate.markPassDone();
        await waiting;
        await gate.readyForRemoteOp(); // and later ops pass straight through
    });

    test('the wait is bounded', async () => {
        const gate = new RemoteGate(() => 50);
        gate.setState('ready');
        await expect(gate.readyForRemoteOp()).rejects.toBeInstanceOf(RemoteUnavailableError);
        expect(gate.waiterCount()).toBe(0);
    });

    test('stop releases waiters and refuses new work', async () => {
        const gate = new RemoteGate(() => 60_000);
        gate.setState('ready');
        const waiting = gate.readyForRemoteOp();
        gate.stop();
        await expect(waiting).rejects.toThrow('engine is stopping');
        await expect(gate.readyForRemoteOp()).rejects.toThrow('engine is stopping');
        await expect(gate.readyForLocalOp()).rejects.toThrow('engine is stopping');
    });

    test('local ops proceed without a connection', async () => {
        const gate = new RemoteGate(() => 60_000);
        await gate.readyForLocalOp(); // connecting
        gate.setState('auth-required');
        await gate.readyForLocalOp();
    });
});

describe('downloadFileRemote stall and abort', () => {
    type Init = NonNullable<Parameters<typeof _setInitForTest>[0]>;

    /** An app whose downloader never reports progress and only ends when its signal aborts. */
    async function connectWithSilentDownloader(onAbortSeen: () => void): Promise<void> {
        _setInitForTest((async () => ({
            sdk: {
                onMessage: () => {},
                getMyFilesRootFolder: async () => ({ uid: 'root', treeEventScopeId: 's' }),
                async *iterateEvents() {},
                getFileDownloader: async (_uid: string, signal?: AbortSignal) => ({
                    downloadToStream: (ws: WritableStream<Uint8Array>) => {
                        void ws;
                        return {
                            completion: () =>
                                new Promise<void>((_, reject) => {
                                    signal?.addEventListener('abort', () => {
                                        onAbortSeen();
                                        reject(new Error('aborted by signal'));
                                    });
                                }),
                            isDownloadCompleteWithSignatureIssues: () => false,
                        };
                    },
                }),
            },
            clearCaches: async () => {},
            dispose: async () => {},
        })) as unknown as Init);
        await initRemote();
    }

    test('steady progress keeps a slow download alive past stallMs', async () => {
        _setInitForTest((async () => ({
            sdk: {
                onMessage: () => {},
                getMyFilesRootFolder: async () => ({ uid: 'root', treeEventScopeId: 's' }),
                async *iterateEvents() {},
                getFileDownloader: async () => ({
                    downloadToStream: (ws: WritableStream<Uint8Array>, onProgress?: (n: number) => void) => ({
                        completion: async () => {
                            const w = ws.getWriter();
                            for (let i = 1; i <= 8; i++) {
                                await Bun.sleep(20); // 160 ms total, 20 ms apart, stallMs is 50
                                await w.write(new Uint8Array([i]));
                                onProgress?.(i);
                            }
                            await w.close();
                        },
                        isDownloadCompleteWithSignatureIssues: () => false,
                    }),
                }),
            },
            clearCaches: async () => {},
            dispose: async () => {},
        })) as unknown as Init);
        await initRemote();
        const { abs, part } = target('slow.bin');
        await downloadFileRemote({ uid: 'u', abs, expectSize: 8, mtimeMs: 1000, stallMs: 50 });
        expect(existsSync(abs)).toBe(true);
        expect(existsSync(part)).toBe(false);
    });

    function target(name: string): { abs: string; part: string } {
        mkdirSync(treeRoot, { recursive: true });
        const abs = path.join(treeRoot, name);
        return { abs, part: abs + '.drivesync.part' };
    }

    test('a download with no progress fails with HydrateTimeoutError and leaves no .part', async () => {
        let aborted = false;
        await connectWithSilentDownloader(() => (aborted = true));
        const { abs, part } = target('stall.bin');
        const err = await downloadFileRemote({ uid: 'u', abs, expectSize: 10, mtimeMs: 1, stallMs: 50 }).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(HydrateTimeoutError);
        expect(aborted).toBe(true); // the SDK transfer itself was cancelled, not abandoned
        expect(existsSync(part)).toBe(false);
        expect(existsSync(abs)).toBe(false);
    });

    test('an external abort surfaces its reason', async () => {
        await connectWithSilentDownloader(() => {});
        const { abs, part } = target('abort.bin');
        const ac = new AbortController();
        const run = downloadFileRemote({ uid: 'u', abs, expectSize: 10, mtimeMs: 1, signal: ac.signal });
        setTimeout(() => ac.abort(new AuthRequiredError()), 30);
        await expect(run).rejects.toBeInstanceOf(AuthRequiredError);
        expect(existsSync(part)).toBe(false);
    });

    test('the baseline marker survives a stalled download (I5)', async () => {
        const st = await import('../src/state');
        st.syncSet({ path: 'keep.bin', uid: 'u', type: 'file', lsize: null, lmtime: null, rsize: 10, rmtime: 1 });
        st.onlineSet('keep.bin', 0);
        await connectWithSilentDownloader(() => {});
        const { abs } = target('keep.bin');
        writeFileSync(abs + '.drivesync.part', 'junk'); // a stale partial from an earlier crash
        await expect(downloadFileRemote({ uid: 'u', abs, expectSize: 10, mtimeMs: 1, stallMs: 30 })).rejects.toBeInstanceOf(
            HydrateTimeoutError,
        );
        expect(st.onlineGet('keep.bin')).not.toBeNull(); // downloadFileRemote never clears the marker
    });
});
