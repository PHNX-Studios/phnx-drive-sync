import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { localRoot, rpcSocket, shareDir, stateDbPath, stateDir, treeRoot } from './config';
import { log } from './log';

export const mountOkPath = path.join(stateDir, 'mount-ok');
const sidecarPath = path.join(import.meta.dir, '..', 'python', 'sidecar.py');
const pyLibDir = path.join(shareDir, 'python');

export function isMountPoint(p: string): boolean {
    try {
        return statSync(p).dev !== statSync(path.dirname(p)).dev;
    } catch (e) {
        // a stale mount (dead sidecar) fails stat with ENOTCONN but is still mounted
        return (e as NodeJS.ErrnoException).code === 'ENOTCONN';
    }
}

function fusermount(...args: string[]): number {
    const r = spawnSync('/usr/bin/fusermount3', args, { stdio: 'ignore' });
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sidecarEnv(): NodeJS.ProcessEnv {
    return { ...process.env, PYTHONPATH: pyLibDir };
}

export async function startMount(): Promise<Sidecar> {
    recoverStaleMount();
    try {
        unlinkSync(mountOkPath);
    } catch {
        /* no heartbeat from a previous run */
    }
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

export async function stopMount(sidecar: Sidecar | null): Promise<void> {
    const child = sidecar?.child;
    if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        const deadline = Date.now() + 5000;
        while (child.exitCode === null && Date.now() < deadline) await sleep(50);
        if (child.exitCode === null) child.kill('SIGKILL');
    }
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
