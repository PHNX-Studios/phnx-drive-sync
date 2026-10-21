import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { APICodeError } from '@protontech/drive-sdk/internal/apiService/errors';

import { connectAndSync, connectRemote, createWaker, type BootDeps, type ConnectDeps, type InitialPassResult, type WakeResult } from '../src/boot';
import { statusFile } from '../src/config';
import { setStatus } from '../src/log';
import { _setInitForTest, errMsg, initRemote } from '../src/remote';
import { initOpenPGPCryptoModule, releaseOpenPGPCryptoModule } from '../vendor/cli/src/init';

interface Harness {
    deps: ConnectDeps;
    inits: () => number;
    errors: string[];
    auths: string[];
    offlines: string[];
    waits: Array<number | null>;
    stop: () => void;
}

/**
 * Scripted connect harness. `outcomes[i]` is what init attempt i does; the last
 * one repeats. `wakes` scripts waitForWake results (default: 'timeout', advancing
 * the fake clock by the requested time); when the script says 'stop' the run ends.
 */
function harness(opts: {
    outcomes: Array<'ok' | Error>;
    wakes?: Array<WakeResult | 'stop'>;
    authRecheckMs?: number;
    stopAfterMs?: number;
}): Harness {
    let stopping = false;
    let stopResolve: () => void = () => {};
    const stopSignal = new Promise<void>((r) => {
        stopResolve = r;
    });
    const stop = (): void => {
        stopping = true;
        stopResolve();
    };
    let now = 0;
    let n = 0;
    const h: Harness = {
        inits: () => n,
        errors: [],
        auths: [],
        offlines: [],
        waits: [],
        stop,
        deps: {
            init: async () => {
                const o = opts.outcomes[Math.min(n, opts.outcomes.length - 1)];
                n++;
                if (o !== 'ok') throw o;
            },
            isStopping: () => stopping,
            stopSignal,
            waitForWake: async (ms) => {
                h.waits.push(ms);
                const scripted = opts.wakes?.shift();
                if (scripted === 'stop') {
                    stop();
                    return 'wake';
                }
                if (scripted) return scripted;
                now += ms ?? 0;
                if (opts.stopAfterMs !== undefined && now >= opts.stopAfterMs) stop();
                return 'timeout';
            },
            minMs: 5000,
            maxMs: 120_000,
            authRecheckMs: opts.authRecheckMs ?? 0,
            onAuth: (e) => {
                h.auths.push(errMsg(e));
                setStatus({ state: 'auth-required', lastError: errMsg(e) });
            },
            onOffline: (e) => h.offlines.push(errMsg(e)),
            onError: (e) => h.errors.push(errMsg(e)),
        },
    };
    return h;
}

const authErr = (): Error => new APICodeError('Invalid access token', 401);
const netErr = (): Error => Object.assign(new Error('fetch failed'), { name: 'FetchError' });

describe('connectRemote', () => {
    test('an expired session recovers on wake without any "already initialised" error', async () => {
        // the real initRemote with a fake vendor init that claims the real crypto
        // singleton exactly like vendor init() does, so a regression surfaces here
        let attempts = 0;
        _setInitForTest((async () => {
            attempts++;
            await initOpenPGPCryptoModule();
            const root = async () => {
                if (attempts === 1) throw authErr();
                return { uid: 'root', treeEventScopeId: 's' };
            };
            return {
                sdk: { onMessage: () => {}, getMyFilesRootFolder: root, async *iterateEvents() {} },
                clearCaches: async () => {},
                dispose: async () => {},
            };
        }) as never);
        try {
            const h = harness({ outcomes: ['ok'], wakes: ['wake'] });
            h.deps.init = initRemote;
            expect(await connectRemote(h.deps)).toBe('ready');
            expect(attempts).toBe(2);
            expect(h.auths).toEqual(['Invalid access token']);
            expect(h.errors.concat(h.offlines).some((m) => /already initiali[sz]ed/i.test(m))).toBe(false);
            expect(h.waits).toEqual([null]);
        } finally {
            _setInitForTest();
            await releaseOpenPGPCryptoModule();
        }
    });

    test('a scripted auth failure then success', async () => {
        const h = harness({ outcomes: [authErr(), 'ok'], wakes: ['wake'] });
        expect(await connectRemote(h.deps)).toBe('ready');
        expect(h.inits()).toBe(2);
        expect(h.auths).toEqual(['Invalid access token']);
        expect(h.errors.concat(h.offlines).some((m) => /already initiali[sz]ed/i.test(m))).toBe(false);
        expect(h.waits).toEqual([null]); // parked: no timer retry
    });

    test('offline at boot retries on the backoff and recovers (regression: offline boot)', async () => {
        const h = harness({ outcomes: [netErr(), netErr(), 'ok'] });
        expect(await connectRemote(h.deps)).toBe('ready');
        expect(h.inits()).toBe(3);
        expect(h.waits).toEqual([5000, 10_000]);
        expect(h.offlines).toHaveLength(2);
        expect(h.errors).toHaveLength(0);
    });

    test('a wake resets the backoff', async () => {
        const h = harness({ outcomes: [netErr(), netErr(), netErr(), 'ok'], wakes: ['timeout', 'timeout', 'wake'] });
        expect(await connectRemote(h.deps)).toBe('ready');
        // timeout doubles, wake collapses back to the minimum
        expect(h.waits).toEqual([5000, 10_000, 20_000]);
    });

    test('other errors back off without claiming to be offline', async () => {
        const h = harness({ outcomes: [new Error('boom'), 'ok'] });
        expect(await connectRemote(h.deps)).toBe('ready');
        expect(h.errors).toEqual(['boom']);
        expect(h.offlines).toHaveLength(0);
    });

    test('a rejected session parks with no timer retry; status says auth-required; stop ends it', async () => {
        // the real waker with no recheck: it waits until woken, however long that is
        const waker = createWaker();
        const h = harness({ outcomes: [authErr()] });
        const run = connectRemote({ ...h.deps, waitForWake: (ms) => (h.waits.push(ms), waker.wait(ms)) });
        await Bun.sleep(100);
        expect(h.inits()).toBe(1);
        expect(h.waits).toEqual([null]);
        const status = JSON.parse(readFileSync(statusFile, 'utf8')) as { state: string; lastError: string };
        expect(status.state).toBe('auth-required');
        expect(status.lastError).toBe('Invalid access token');
        h.stop();
        waker.wake();
        expect(await run).toBe('stopped');
        expect(h.inits()).toBe(1);
    });

    test('the quiet recheck retries once per interval and reports the rejection only once', async () => {
        const h = harness({ outcomes: [authErr()], authRecheckMs: 900_000, stopAfterMs: 3_600_000 });
        expect(await connectRemote(h.deps)).toBe('stopped');
        expect(h.inits()).toBe(4); // attempts at t=0, 15, 30, 45 min; the 60 min wait ends the run
        expect(h.auths).toHaveLength(1);
        expect(h.waits.every((w) => w === 900_000)).toBe(true);
        expect(h.waits.reduce<number>((a, w) => a + (w ?? 0), 0)).toBe(3_600_000); // one hour of fake time
    });

    test('a recheck that finds a healed keyring connects', async () => {
        const h = harness({ outcomes: [authErr(), authErr(), 'ok'], authRecheckMs: 1000 });
        expect(await connectRemote(h.deps)).toBe('ready');
        expect(h.inits()).toBe(3);
    });

    test('stopping abandons a hung attempt', async () => {
        const h = harness({ outcomes: ['ok'] });
        const deps: ConnectDeps = { ...h.deps, init: () => new Promise<void>(() => {}) };
        const run = connectRemote(deps);
        setTimeout(h.stop, 10);
        expect(await run).toBe('stopped');
    });

    test('stop during a backoff wait returns stopped', async () => {
        const h = harness({ outcomes: [netErr()], wakes: ['stop'] });
        expect(await connectRemote(h.deps)).toBe('stopped');
        expect(h.inits()).toBe(1);
    });
});

describe('connectAndSync', () => {
    function bootHarness(passes: Array<InitialPassResult | Error>, opts: { sessionKept?: boolean } = {}) {
        let stopping = false;
        const log: string[] = [];
        let n = 0;
        const d: BootDeps = {
            connect: async () => (log.push('connect'), 'ready'),
            isStopping: () => stopping,
            onReady: () => log.push('ready'),
            pass: async () => {
                const r = passes[Math.min(n++, passes.length - 1)];
                if (r instanceof Error) throw r;
                return r;
            },
            onPassDone: () => log.push('done'),
            sessionKept: () => opts.sessionKept ?? false,
            onAuth: (why) => log.push(`auth:${why}`),
            onTransient: (why) => log.push(`transient:${why}`),
            waitForWake: async (ms) => (log.push(`wait:${ms}`), 'wake'),
            minMs: 5000,
            maxMs: 120_000,
            authRecheckMs: 0,
        };
        return { d, log, stop: () => (stopping = true) };
    }
    const ok: InitialPassResult = { scanAuthFailed: false, lastError: null };
    const scanAuth: InitialPassResult = { scanAuthFailed: true, lastError: 'Invalid access token' };

    test('a refused scan parks, then reconnects and walks again on wake', async () => {
        const b = bootHarness([scanAuth, ok]);
        expect(await connectAndSync(b.d)).toBe('done');
        expect(b.log).toEqual(['connect', 'ready', 'auth:Invalid access token', 'wait:null', 'connect', 'ready', 'done']);
    });

    test('a per-file auth error (scan fine) does not park the engine', async () => {
        const b = bootHarness([{ scanAuthFailed: false, lastError: '401 on one file' }]);
        expect(await connectAndSync(b.d)).toBe('done');
        expect(b.log).toEqual(['connect', 'ready', 'done']);
    });

    test('a refused scan with the session still stored is retried on the backoff, not parked', async () => {
        const b = bootHarness([scanAuth, scanAuth, ok], { sessionKept: true });
        expect(await connectAndSync(b.d)).toBe('done');
        expect(b.log.filter((l) => l.startsWith('auth:'))).toEqual([]);
        expect(b.log.filter((l) => l.startsWith('wait:'))).toEqual(['wait:5000', 'wait:5000']);
    });

    test('a crashing pass still releases the waiters', async () => {
        const b = bootHarness([new Error('pass crashed')]);
        await expect(connectAndSync(b.d)).rejects.toThrow('pass crashed');
        expect(b.log).toContain('done');
    });

    test('stop while parked ends the loop', async () => {
        const b = bootHarness([scanAuth]);
        b.d.waitForWake = async () => (b.stop(), 'wake');
        expect(await connectAndSync(b.d)).toBe('stopped');
    });
});

describe('createWaker', () => {
    test('a second concurrent waiter is rejected', async () => {
        const w = createWaker();
        const first = w.wait(null);
        await expect(w.wait(null)).rejects.toThrow('one waiter');
        w.wake();
        await first;
    });

    test('wake ends a wait early; a wake with no waiter is remembered once', async () => {
        const w = createWaker();
        const waiting = w.wait(null);
        w.wake();
        expect(await waiting).toBe('wake');

        w.wake();
        expect(await w.wait(null)).toBe('wake');
        expect(await w.wait(10)).toBe('timeout');
    });
});
