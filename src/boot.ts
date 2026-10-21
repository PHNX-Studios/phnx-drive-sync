import { isAuthError, isNetworkError } from './remote';

export type WakeResult = 'wake' | 'timeout';

/**
 * One-slot wake-up (one waiter at a time; a second concurrent `wait` is a bug and
 * throws): `wake()` (login reload, SIGHUP, Sync now, connectivity edge,
 * shutdown) ends the current `wait()` early. A wake that arrives while nobody is
 * waiting is remembered, so it cannot be lost between an attempt and its sleep.
 */
export function createWaker(): { wake: () => void; wait: (ms: number | null) => Promise<WakeResult> } {
    let pending = false;
    let release: (() => void) | null = null;
    return {
        wake: () => {
            pending = true;
            release?.();
        },
        wait: (ms) =>
            new Promise<WakeResult>((resolve, reject) => {
                if (release) {
                    reject(new Error('createWaker: only one waiter at a time'));
                    return;
                }
                if (pending) {
                    pending = false;
                    resolve('wake');
                    return;
                }
                const timer = ms === null ? null : setTimeout(done, ms, 'timeout');
                function done(r: WakeResult): void {
                    if (timer) clearTimeout(timer);
                    release = null;
                    if (r === 'wake') pending = false;
                    resolve(r);
                }
                release = () => done('wake');
            }),
    };
}

export interface ConnectDeps {
    /** One connection attempt; must leave no state behind when it rejects. */
    init: () => Promise<void>;
    isStopping: () => boolean;
    /** Resolves on shutdown, so a stuck attempt never delays exit. */
    stopSignal: Promise<void>;
    /** Wait up to `ms` (null = until woken); resolves early with 'wake'. */
    waitForWake: (ms: number | null) => Promise<WakeResult>;
    minMs: number;
    maxMs: number;
    /** While waiting for a sign-in, quietly retry this often (0 = only when woken). */
    authRecheckMs: number;
    /** The session was rejected; called once per wait, not on every quiet recheck. */
    onAuth: (e: unknown) => void;
    /** A network failure; the retry follows in `retryMs`. */
    onOffline: (e: unknown, retryMs: number) => void;
    /** Anything else; the retry follows in `retryMs`. */
    onError: (e: unknown, retryMs: number) => void;
}

/**
 * Connect to the remote, never giving up and never exiting.
 *
 * Network and unknown failures back off exponentially (reset by a wake). An auth
 * failure is not retried on a timer - the session will not heal by itself - so it
 * parks until woken (login, reload, Sync now) with only an optional slow quiet
 * recheck for a keyring that unlocks late.
 */
export async function connectRemote(d: ConnectDeps): Promise<'ready' | 'stopped'> {
    let delay = d.minMs;
    let authReported = false;
    for (;;) {
        if (d.isStopping()) return 'stopped';
        try {
            const attempt = d.init();
            // a shutdown may abandon this attempt; swallow its eventual rejection
            attempt.catch(() => {
                /* abandoned on shutdown */
            });
            await Promise.race([attempt, d.stopSignal]);
            return d.isStopping() ? 'stopped' : 'ready';
        } catch (e) {
            if (d.isStopping()) return 'stopped';
            if (isAuthError(e)) {
                if (!authReported) d.onAuth(e);
                authReported = true;
                const r = await d.waitForWake(d.authRecheckMs > 0 ? d.authRecheckMs : null);
                if (r === 'wake') {
                    authReported = false; // an explicit retry that fails again deserves a fresh report
                    delay = d.minMs;
                }
                continue;
            }
            authReported = false;
            if (isNetworkError(e)) d.onOffline(e, delay);
            else d.onError(e, delay);
            const r = await d.waitForWake(delay);
            // a wake (connectivity edge, reload) retries promptly, not at the backoff ceiling
            delay = r === 'wake' ? d.minMs : Math.min(d.maxMs, delay * 2);
        }
    }
}

export interface InitialPassResult {
    /** The remote scan itself was refused (not merely one file's transfer). */
    scanAuthFailed: boolean;
    lastError: string | null;
}

export interface BootDeps {
    /** `connectRemote` bound to its deps. */
    connect: () => Promise<'ready' | 'stopped'>;
    isStopping: () => boolean;
    /** Connected: open the gate for the initial pass. */
    onReady: () => void;
    /** Run the initial full pass (owns the pass bookkeeping and status). */
    pass: () => Promise<InitialPassResult>;
    /** The initial pass is over (success, or a failure that is not retried): release waiters. */
    onPassDone: () => void;
    /** The stored session survived the failure (a transient refresh problem), so do not ask for a sign-in. */
    sessionKept: () => boolean;
    onAuth: (why: string) => void;
    onTransient: (why: string, retryMs: number) => void;
    waitForWake: (ms: number | null) => Promise<WakeResult>;
    minMs: number;
    maxMs: number;
    authRecheckMs: number;
}

/**
 * Connect, then run the initial full pass; if the session is rejected in that
 * pass, park until woken (login / reload / Sync now) and start over with a fresh
 * connection. Only a refused remote *scan* parks the engine - a per-file auth
 * error stays per-file and the pass result is accepted.
 */
export async function connectAndSync(d: BootDeps): Promise<'done' | 'stopped'> {
    let delay = d.minMs;
    for (;;) {
        if ((await d.connect()) === 'stopped' || d.isStopping()) return 'stopped';
        d.onReady();
        let result: InitialPassResult;
        try {
            result = await d.pass();
        } catch (e) {
            d.onPassDone();
            throw e;
        }
        if (!result.scanAuthFailed) {
            d.onPassDone();
            return 'done';
        }
        if (d.isStopping()) return 'stopped';
        const why = result.lastError ?? 'authentication required';
        if (d.sessionKept()) {
            d.onTransient(why, delay);
            const r = await d.waitForWake(delay);
            delay = r === 'wake' ? d.minMs : Math.min(d.maxMs, delay * 2);
        } else {
            d.onAuth(why);
            await d.waitForWake(d.authRecheckMs > 0 ? d.authRecheckMs : null);
        }
    }
}
