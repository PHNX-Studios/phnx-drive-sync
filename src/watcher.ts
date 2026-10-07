import { spawn, type ChildProcess } from 'node:child_process';

import { isPartial, treeRoot } from './config';
import { log } from './log';

export function startWatcher(onWake: (absPath: string) => void): () => void {
    let stopped = false;
    let child: ChildProcess | null = null;
    let restarts = 0;
    let buffer = '';

    const start = (): void => {
        if (stopped) return;
        buffer = '';
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
                'create',
                '-e',
                'delete',
                '-e',
                'move',
                treeRoot,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                const bar = line.lastIndexOf('|');
                const p = bar === -1 ? line : line.slice(0, bar);
                if (!p || p.endsWith('.protonignore')) continue;
                if (isPartial(p)) continue;
                onWake(p);
            }
        });
        child.stderr?.on('data', (d: Buffer) => log('DEBUG', `inotifywait: ${d.toString().trim()}`));
        child.on('error', (e) => {
            log('WARN', 'inotifywait unavailable; falling back to timer and event stream only', e);
            stopped = true;
        });
        child.on('exit', (code, sig) => {
            if (stopped) return;
            if (++restarts > 20) {
                log('WARN', 'watcher restarted too many times; falling back to timer and event stream only');
                stopped = true;
                return;
            }
            log('WARN', `inotifywait exited (code=${code} sig=${sig}); restarting in 2s`);
            setTimeout(start, 2000);
        });
    };

    start();
    return () => {
        stopped = true;
        child?.kill();
    };
}
