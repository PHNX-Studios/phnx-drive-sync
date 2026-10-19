import { spawnSync } from 'node:child_process';

/**
 * Best-effort desktop notification (engine runs under systemd --user, which has
 * session DBus). Kept in a leaf module so connectivity (and anything else that
 * needs to notify) never forms an import cycle with evict/sync.
 */
export function notify(body: string, title = 'Proton Drive'): void {
    try {
        spawnSync('notify-send', [title, body], { stdio: 'ignore', timeout: 10_000 });
    } catch {
        /* no notification daemon: the log line is the fallback */
    }
}
