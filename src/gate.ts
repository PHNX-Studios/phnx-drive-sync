import { hydrateReadyWaitMs } from './config';
import { isOffline } from './connectivity';
import { AuthRequiredError, OfflineError, RemoteUnavailableError } from './remote';

/** Where the remote connection stands: not yet, rejected by the server, or usable. */
export type RemoteState = 'connecting' | 'auth-required' | 'ready';

interface Waiter {
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Admission control for RPC ops that touch the remote (hydrate, pin, mv, trash).
 *
 * The RPC socket opens before the remote connection exists, so the first thing an
 * op needs to know is whether waiting can possibly help. Not connected / waiting
 * for a sign-in: fail at once with a class the sidecar maps to an errno. Connected
 * but the initial pass is still running: wait for it, bounded, and release every
 * waiter with an error if the pass fails auth or the engine stops (no waiter may
 * outlive its reason to wait).
 */
export class RemoteGate {
    state: RemoteState = 'connecting';
    private passDone = false;
    private stopped = false;
    private readonly waiters = new Set<Waiter>();

    constructor(private readonly waitMs: () => number = hydrateReadyWaitMs) {}

    get initialPassDone(): boolean {
        return this.passDone;
    }

    setState(next: RemoteState): void {
        this.state = next;
    }

    /** The initial pass finished: release every waiter. */
    markPassDone(): void {
        this.passDone = true;
        for (const w of [...this.waiters]) this.settle(w, null);
    }

    /** Reject everything currently waiting (initial-pass auth failure). */
    fail(err: Error): void {
        for (const w of [...this.waiters]) this.settle(w, err);
    }

    /** Engine shutdown: refuse new work and release every waiter. */
    stop(): void {
        this.stopped = true;
        this.fail(new Error('engine is stopping'));
    }

    waiterCount(): number {
        return this.waiters.size;
    }

    private settle(w: Waiter, err: Error | null): void {
        if (!this.waiters.delete(w)) return;
        clearTimeout(w.timer);
        if (err) w.reject(err);
        else w.resolve();
    }

    private waitForPass(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const w: Waiter = {
                resolve,
                reject,
                timer: setTimeout(
                    () =>
                        this.settle(
                            w,
                            new RemoteUnavailableError('the initial sync is still running; try again shortly'),
                        ),
                    this.waitMs(),
                ),
            };
            this.waiters.add(w);
        });
    }

    /** Ops that need the network (hydrate/pin/mv/trash). Throws a classified error instead of hanging. */
    async readyForRemoteOp(): Promise<void> {
        if (this.stopped) throw new Error('engine is stopping');
        if (this.state === 'auth-required') throw new AuthRequiredError();
        if (this.state === 'connecting') {
            if (isOffline()) throw new OfflineError('offline: cannot reach Proton Drive');
            throw new RemoteUnavailableError();
        }
        // connected: offline is handled per-op (each op has its own offline behaviour)
        if (this.passDone || isOffline()) return;
        await this.waitForPass();
    }

    /**
     * Ops that are local first (unpin, evict). With no connection they proceed
     * (they only free bytes that are provably clean); while the initial pass is
     * running they wait for it so the baseline is current.
     */
    async readyForLocalOp(): Promise<void> {
        if (this.stopped) throw new Error('engine is stopping');
        if (this.state !== 'ready' || this.passDone || isOffline()) return;
        await this.waitForPass();
    }
}
