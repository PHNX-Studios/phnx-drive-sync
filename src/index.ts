import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

import { lockFile, localRoot, passIntervalMs, stateDir, statusFile } from './config';
import { loadFilters } from './filters';
import { log, setStatus } from './log';
import * as remote from './remote';
import * as st from './state';
import { runPass } from './sync';
import { startWatcher } from './watcher';

let lockHeld = false;
let syncNowHook: (() => void) | null = null;

// Consumed so SIGUSR1 never kills the process (e.g. before the daemon hook exists).
process.on('SIGUSR1', () => syncNowHook?.());

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function acquireLock(): void {
    const attempt = (allowStale: boolean): void => {
        try {
            const fd = openSync(lockFile, 'wx');
            writeSync(fd, String(process.pid));
            closeSync(fd);
            lockHeld = true;
        } catch {
            let pid: number | null = null;
            try {
                pid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10) || null;
            } catch {
                pid = null;
            }
            if (pid && isAlive(pid)) throw new Error(`another instance is already running (pid ${pid})`);
            if (!allowStale) throw new Error(`lock file is stuck: ${lockFile}`);
            try {
                unlinkSync(lockFile);
            } catch {
                /* ignore */
            }
            attempt(false);
        }
    };
    attempt(true);
}

function releaseLock(): void {
    if (!lockHeld) return;
    lockHeld = false;
    try {
        unlinkSync(lockFile);
    } catch {
        /* ignore */
    }
}

async function main(): Promise<void> {
    const mode = process.argv[2] ?? 'run';

    if (mode === 'status') {
        try {
            console.log(readFileSync(statusFile, 'utf8'));
        } catch {
            console.log(JSON.stringify({ state: 'unknown' }));
        }
        return;
    }
    const dryRun = process.argv.includes('--dry-run');
    if (mode !== 'run' && mode !== 'once') {
        console.error('usage: drive-sync [run|once [--dry-run]|status]');
        process.exitCode = 64;
        return;
    }
    if (dryRun && mode !== 'once') {
        console.error('--dry-run is only valid with once');
        process.exitCode = 64;
        return;
    }

    mkdirSync(localRoot, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    st.openState();
    loadFilters();

    acquireLock();
    try {
        await remote.initRemote();
        if (mode === 'once') {
            const s = await runPass({ forceFull: true, dry: dryRun });
            setStatus({ state: dryRun ? 'stopped' : 'idle' });
            process.exitCode = s.authFailed ? 3 : s.errors > 0 ? 2 : 0;
        } else {
            await daemon();
        }
    } finally {
        await remote.shutdownRemote();
        releaseLock();
    }
    process.exit(process.exitCode ?? 0);
}

async function daemon(): Promise<void> {
    let stopping = false;
    let passing = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delayMs: number): void => {
        if (stopping) return;
        if (passing) {
            pending = true;
            return;
        }
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            void doPass();
        }, delayMs);
    };

    const doPass = async (): Promise<void> => {
        if (stopping) return;
        if (passing) {
            pending = true;
            return;
        }
        passing = true;
        setStatus({ state: 'passing' });
        try {
            const s = await runPass({ forceFull: false });
            if (s.authFailed) log('ERROR', 'authentication required; will retry each interval (re-login via the official proton-drive CLI if this persists)');
        } catch (e) {
            log('ERROR', 'pass crashed', e);
            setStatus({ state: 'running', lastError: e instanceof Error ? e.message : String(e) });
        } finally {
            passing = false;
            if (pending) {
                pending = false;
                schedule(2000);
            }
        }
    };

    log('INFO', 'initial full pass...');
    passing = true;
    try {
        const s = await runPass({ forceFull: true });
        if (s.authFailed) throw new Error(`initial sync failed: ${s.lastError}`);
    } finally {
        passing = false;
    }
    setStatus({ state: 'running' });
    log('INFO', 'initial pass done; starting event loop, watcher and interval');

    syncNowHook = () => {
        if (stopping) return;
        log('INFO', 'SIGUSR1: sync now');
        schedule(0);
    };
    remote.startEventLoop(() => schedule(1000));
    const stopWatch = startWatcher(() => {
        loadFilters();
        schedule(3000);
    });
    const interval = setInterval(() => schedule(0), passIntervalMs);

    await new Promise<void>((resolve) => {
        const shutdown = (sig: string): void => {
            if (stopping) return;
            stopping = true;
            syncNowHook = null;
            log('INFO', `${sig} received; shutting down`);
            if (timer) clearTimeout(timer);
            clearInterval(interval);
            stopWatch();
            remote.stopEventLoop();
            setStatus({ state: 'stopped' });
            setTimeout(resolve, 500);
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
    log('INFO', 'stopped cleanly');
}

main().catch((e) => {
    log('ERROR', `fatal: ${e instanceof Error ? e.stack : String(e)}`);
    releaseLock();
    process.exitCode = 1;
});
