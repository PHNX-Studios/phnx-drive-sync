import { spawn, type ChildProcess } from 'node:child_process';

import { isPartial, treeRoot } from './config';
import { log } from './log';

/** A watcher process must survive this long before it counts as healthy (resets the restart streak). */
const HEALTHY_UPTIME_MS = 60_000;
/** After this many consecutive quick exits, stop respawning and hand off to the safety poll. */
const MAX_RESTARTS = 20;
const RESTART_DELAY_MS = 2_000;

export interface WatcherHandle {
    /** Stop the watcher and its supervisor permanently. */
    stop(): void;
    /** True while a supervised inotifywait is running and believed to cover the whole tree. */
    healthy(): boolean;
}

/**
 * Watch the real tree for local changes. inotifywait -r also watches directories
 * created (or moved in) after startup, so new subtrees are covered without a
 * restart. Every event is collapsed by the caller's debounce; the watcher itself
 * only filters engine-internal temp files.
 */
export function startWatcher(onWake: (absPath: string) => void): WatcherHandle {
    let stopped = false;
    let child: ChildProcess | null = null;
    let restarts = 0;
    let buffer = '';
    let healthy = false;
    let uptimeTimer: ReturnType<typeof setTimeout> | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;

    const clearUptimeTimer = (): void => {
        if (uptimeTimer) {
            clearTimeout(uptimeTimer);
            uptimeTimer = null;
        }
    };

    const clearRestartTimer = (): void => {
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
    };

    /** Drop a finished child's listeners so a late chunk cannot feed the next child's buffer. */
    const detach = (c: ChildProcess | null): void => {
        if (!c) return;
        c.stdout?.removeAllListeners();
        c.stderr?.removeAllListeners();
        c.removeAllListeners();
    };

    const start = (): void => {
        if (stopped) return;
        detach(child); // the previous child (if any) is already dead; drop its listeners
        buffer = '';
        clearUptimeTimer();
        clearRestartTimer();
        child = spawn(
            'inotifywait',
            [
                '-m',
                '-r',
                '-q',
                '--format',
                '%w%f|%e',
                '-e',
                'close_write',
                '-e',
                'modify',
                '-e',
                'attrib',
                '-e',
                'create',
                '-e',
                'delete',
                '-e',
                'move',
                treeRoot,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        // the process is up (spawn failures arrive asynchronously via 'error')
        healthy = true;
        // survived the startup window without dying: reset the streak so the cap
        // counts consecutive restarts, not lifetime exits
        uptimeTimer = setTimeout(() => {
            restarts = 0;
            uptimeTimer = null;
        }, HEALTHY_UPTIME_MS);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                const bar = line.lastIndexOf('|');
                const p = bar === -1 ? line : line.slice(0, bar);
                if (!p) continue;
                if (isPartial(p)) continue;
                onWake(p);
            }
        });
        child.stderr?.on('data', (d: Buffer) => {
            const text = d.toString().trim();
            if (!text) return;
            // a watch-limit or hard error means the tree is only partially
            // covered: surface it (WARN, not DEBUG) and drop out of "healthy"
            // so the safety poll engages instead of silently missing changes
            if (/limit|failed|error|cannot|unable|too many|no such|denied|space|couldn/i.test(text)) {
                log('WARN', `inotifywait: ${text}`);
                healthy = false;
            } else {
                log('DEBUG', `inotifywait: ${text}`);
            }
        });
        child.on('error', (e) => {
            clearUptimeTimer();
            healthy = false;
            log('WARN', 'inotifywait unavailable; falling back to the safety poll and event stream only', e);
            stopped = true;
        });
        child.on('exit', (code, sig) => {
            clearUptimeTimer();
            clearRestartTimer();
            healthy = false;
            if (stopped) return;
            if (++restarts > MAX_RESTARTS) {
                log('WARN', 'watcher restarted too many times; falling back to the safety poll and event stream only');
                stopped = true;
                return;
            }
            log('WARN', `inotifywait exited (code=${code} sig=${sig}); restarting in ${RESTART_DELAY_MS / 1000}s`);
            restartTimer = setTimeout(start, RESTART_DELAY_MS);
        });
    };

    start();
    return {
        stop(): void {
            stopped = true;
            healthy = false;
            clearUptimeTimer();
            clearRestartTimer();
            child?.kill();
        },
        healthy(): boolean {
            return healthy;
        },
    };
}
