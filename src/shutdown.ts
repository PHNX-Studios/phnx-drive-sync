/**
 * Cooperative shutdown helpers.
 *
 * The engine's sync pass runs one file operation at a time; on SIGTERM/SIGINT
 * the daemon asks the pass to stop (`requestStop` in sync.ts) and then waits for
 * it to unwind here. The running operation always finishes (the stop request is
 * only observed between actions), so no upload/download is cut mid-flight.
 */

export interface WaitForPassOptions {
    /** Whether a sync pass is currently running. */
    isPassing: () => boolean;
    /** Maximum time to wait for the pass to finish, in milliseconds. */
    graceMs: number;
    /** Sleep function (injected for tests). */
    sleep: (ms: number) => Promise<void>;
    /** Clock (injected for tests); defaults to Date.now. */
    now?: () => number;
    /** Poll interval; defaults to 100 ms. */
    pollMs?: number;
}

/**
 * Wait until no sync pass is running or the grace period elapses.
 *
 * Returns `true` if the pass ended within the grace period, `false` if the
 * deadline passed with the pass still running (caller should stop anyway).
 */
export async function waitForPassEnd(opts: WaitForPassOptions): Promise<boolean> {
    const now = opts.now ?? Date.now;
    const pollMs = opts.pollMs ?? 100;
    const deadline = now() + opts.graceMs;
    while (opts.isPassing() && now() < deadline) {
        await opts.sleep(pollMs);
    }
    return !opts.isPassing();
}
