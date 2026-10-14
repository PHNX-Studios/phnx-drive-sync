import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { sidecarPath } from './approot';
import { localRoot, rpcSocket, shareDir, stateDbPath, stateDir, treeRoot } from './config';
import { log, setStatus, status } from './log';

export const mountOkPath = path.join(stateDir, 'mount-ok');
const pyLibDir = path.join(shareDir, 'python');

export function isMountPoint(p: string): boolean {
    try {
        return statSync(p).dev !== statSync(path.dirname(p)).dev;
    } catch (e) {
        // a stale mount (dead sidecar) fails stat with ENOTCONN but is still mounted
        return (e as NodeJS.ErrnoException).code === 'ENOTCONN';
    }
}

/** fusermount3 is in /usr/bin on essentially every fuse3 distro, /bin on some. */
function findFusermount(): string {
    for (const p of ['/usr/bin/fusermount3', '/bin/fusermount3']) {
        if (existsSync(p)) return p;
    }
    return 'fusermount3'; // fall back to a PATH lookup
}
const FUSERMOUNT = findFusermount();

function fusermount(...args: string[]): number {
    const r = spawnSync(FUSERMOUNT, args, { stdio: 'ignore' });
    return r.status ?? -1;
}

/** Boot hygiene: a crash can leave the FUSE session mounted without a server. */
export function recoverStaleMount(): void {
    if (!isMountPoint(localRoot)) return;
    log('WARN', `stale mount at ${localRoot}; unmounting`);
    const rc = fusermount('-u', localRoot);
    if (rc !== 0 && isMountPoint(localRoot)) {
        log('WARN', `fusermount3 -u failed (rc=${rc}); mount may be busy`);
    }
}

export interface Sidecar {
    child: ChildProcess | null;
    ok: boolean;
}

/** The engine's one mount handle; owned here so the monitor can replace it. */
let current: Sidecar | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sidecarEnv(): NodeJS.ProcessEnv {
    // preserve any user PYTHONPATH; prepend the engine's sidecar lib dir
    const existing = process.env.PYTHONPATH;
    return { ...process.env, PYTHONPATH: existing ? `${pyLibDir}${path.delimiter}${existing}` : pyLibDir };
}

export async function startMount(): Promise<Sidecar> {
    recoverStaleMount();
    try {
        unlinkSync(mountOkPath);
    } catch {
        /* no heartbeat from a previous run */
    }
    current = await mountOnce();
    return current;
}

async function mountOnce(): Promise<Sidecar> {
    const probe = spawnSync('python3', ['-c', 'import pyfuse3'], { env: sidecarEnv(), stdio: 'ignore' });
    if (probe.status !== 0) {
        log('ERROR', 'pyfuse3 unavailable for the sidecar; mount degraded (mountpoint stays empty)');
        return { child: null, ok: false };
    }
    const child = spawn(
        'python3',
        [
            sidecarPath,
            '--mount', localRoot,
            '--tree', treeRoot,
            '--db', stateDbPath,
            '--rpc', rpcSocket,
            '--mount-ok', mountOkPath,
        ],
        { env: sidecarEnv(), stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('error', (e) => log('ERROR', 'sidecar failed to spawn', e));
    child.on('exit', (code, sig) => log('WARN', `sidecar exited (code=${code} sig=${sig})`));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (existsSync(mountOkPath)) {
            log('INFO', `FUSE mount ready at ${localRoot}`);
            return { child, ok: true };
        }
        if (child.exitCode !== null) break;
        await sleep(100);
    }
    log('ERROR', 'sidecar did not report a mount within 15s; mount degraded');
    return { child, ok: false };
}

function isSidecarLive(): boolean {
    return current?.child != null && current.child.exitCode === null;
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitoring = false;

/**
 * Keep the FUSE mount alive for the life of the daemon: watches the mount-ok
 * heartbeat and restarts the sidecar when it stops beating (external unmount,
 * SIGTERM, crash) — without restarting the engine. The interval is deliberately
 * unref'd so it can never hold the process open during shutdown.
 */
export function monitorMount(): void {
    if (monitorTimer) return;
    monitoring = true;
    const beat = (): boolean => {
        try {
            return Date.now() - statSync(mountOkPath).mtimeMs <= 15_000;
        } catch {
            return false;
        }
    };
    const setMount = (m: 'ok' | 'degraded'): void => {
        if (status.mount !== m) setStatus({ mount: m });
    };
    let failures = 0;
    let relaunching = false;
    let nextAttemptAt = 0;
    const tick = async (): Promise<void> => {
        if (relaunching) return;
        if (beat() && isMountPoint(localRoot)) {
            setMount('ok');
            failures = 0;
            return;
        }
        if (isSidecarLive() && beat()) {
            // live sidecar with a fresh heartbeat: transient pause, give it time
            return;
        }
        if (Date.now() < nextAttemptAt) return;
        relaunching = true;
        try {
            failures += 1;
            log('WARN', `FUSE mount lost; relaunching sidecar (attempt ${failures})`);
            await retireSidecar(); // never stack a second sidecar on a wedged one
            recoverStaleMount();
            try {
                unlinkSync(mountOkPath);
            } catch {
                /* already gone */
            }
            setMount('degraded');
            const s = await mountOnce();
            if (!monitoring) {
                // engine is shutting down: undo a relaunch that landed too late
                if (s.child && s.child.exitCode === null) s.child.kill('SIGTERM');
                return;
            }
            current = s;
            if (s.ok) failures = 0;
            // back off progressively when the sidecar keeps failing to come up
            else nextAttemptAt = Date.now() + Math.min(60, 5 * failures) * 1000;
        } finally {
            relaunching = false;
        }
    };
    const timer = setInterval(() => {
        if (!monitoring) return;
        void tick();
    }, 5_000);
    timer.unref();
    monitorTimer = timer;
}

async function retireSidecar(): Promise<void> {
    const child = current?.child;
    if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        const deadline = Date.now() + 5000;
        while (child.exitCode === null && Date.now() < deadline) await sleep(50);
        if (child.exitCode === null) child.kill('SIGKILL');
    }
    current = null;
}

export async function stopMount(): Promise<void> {
    monitoring = false;
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
    await retireSidecar();
    if (isMountPoint(localRoot)) {
        const rc = fusermount('-u', localRoot);
        if (rc !== 0) log('WARN', `shutdown unmount failed (rc=${rc})`);
    }
    try {
        unlinkSync(mountOkPath);
    } catch {
        /* already gone */
    }
}
