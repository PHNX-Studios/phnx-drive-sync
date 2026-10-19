import { readFileSync, readdirSync } from 'node:fs';

import { connectivityPollMs, offlineNotifyCooldownMs } from './config';
import { log, setStatus } from './log';
import { notify } from './notify';
import { isNetworkError } from './remote';

/**
 * Engine-wide connectivity state.
 *
 * Offline is a coarse hint, not a guarantee: it exists so a placeholder recall
 * (and the adjacent rename/trash/pin paths) can fail *instantly* with a sensible
 * errno instead of hanging through the SDK's retries, and so the tray/GUI can
 * say "you're offline". The authoritative "we are back" is always a successful
 * API call, never the probe alone.
 *
 * Three inputs, combined:
 *   1. a cheap kernel link probe (default route + carrier) polled every few
 *      seconds - catches airplane mode / Wi-Fi off / cable unplugged before the
 *      first open;
 *   2. the SDK's own transfersPaused/transfersResumed events - the SDK already
 *      tracks consecutive offline errors;
 *   3. reactive classification of an actual network failure (`isNetworkError`) -
 *      catches a black-holed link whose probe still looks "up".
 */

let offline = false;
let offlineSince: string | null = null;
let lastNotifyAt = 0;
let offlineNotified = false;
let upStreak = 0;
let stopPoll: (() => void) | null = null;
let onResume: (() => void) | null = null;

export function isOffline(): boolean {
    return offline;
}

export function offlineTimestamp(): string | null {
    return offlineSince;
}

/** A machine-readable reason, for the log only. */
export type OfflineReason = 'link' | 'reactive' | 'sdk' | 'boot' | 'success';

/**
 * Set the connectivity state, firing the transition side effects exactly once
 * per edge: status.json update, a (rate-limited) desktop notification, and the
 * resume callback when coming back online.
 */
export function setOffline(next: boolean, reason: OfflineReason): void {
    if (offline === next) return;
    offline = next;
    offlineSince = next ? new Date().toISOString() : null;
    setStatus({ offline, offlineSince });
    if (next) {
        log('WARN', `offline (${reason}): online-only files will fail fast until reconnect`);
        notifyOffline();
    } else {
        log('INFO', `back online (${reason}); resuming`);
        notifyOnline();
        onResume?.();
    }
}

function notifyOffline(): void {
    const now = Date.now();
    if (now - lastNotifyAt < offlineNotifyCooldownMs()) {
        offlineNotified = false; // suppressed: do not announce a "back online" for it
        return;
    }
    lastNotifyAt = now;
    offlineNotified = true;
    notify("You're offline - online-only files can't be opened until you reconnect.");
}

function notifyOnline(): void {
    if (!offlineNotified) return; // the offline notice was suppressed: stay quiet
    offlineNotified = false;
    notify('Back online - resuming sync and downloading pending files.');
}

/**
 * Cheap kernel-level "the link is down" test, injectable for tests.
 *
 * Offline iff there is no IPv4 default route, no IPv6 default route, and no
 * non-loopback interface with carrier. A present default route means "assume
 * online" even if it might be black-holed; the reactive classifier handles that.
 */
export function linkIsDown(readFile: (p: string) => string, listNet: () => string[]): boolean {
    let ipv4: string;
    try {
        ipv4 = readFile('/proc/net/route');
    } catch {
        return false; // cannot read the routing table: do not assert offline (conservative)
    }
    let ipv6 = '';
    try {
        ipv6 = readFile('/proc/net/ipv6_route'); // optional on IPv4-only kernels
    } catch {
        ipv6 = '';
    }
    if (hasDefaultRoute(ipv4, ipv6)) return false;
    try {
        for (const iface of listNet()) {
            if (iface === 'lo') continue;
            try {
                if (readFile(`/sys/class/net/${iface}/carrier`).trim() === '1') return false;
            } catch {
                /* interface vanished mid-read */
            }
        }
    } catch {
        return false; // cannot enumerate interfaces: do not assert offline
    }
    return true;
}

/**
 * True when either routing table has a default route.
 *
 * `/proc/net/route` columns are: Iface Destination Gateway Flags ... Destination
 * `00000000` is the IPv4 default; a non-zero Gateway confirms it is real.
 * `/proc/net/ipv6_route` encodes the default as 32 zero hex chars destination +
 * 32 zero hex chars prefix; its 5th field is the next-hop (all-zero = no route).
 */
export function hasDefaultRoute(ipv4: string, ipv6 = ''): boolean {
    for (const line of ipv4.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 3) continue;
        const dest = cols[1];
        const gateway = cols[2];
        if (dest === '00000000' && gateway && gateway !== '00000000') return true;
    }
    for (const line of ipv6.split('\n')) {
        const cols = line.trim().split(/\s+/);
        // dest(32 hex) prefixlen(8 hex) src(32) srcprefix(8) gateway(32) ...
        if (cols.length < 5) continue;
        if (/^0{32}$/.test(cols[0]) && /^0{8}$/.test(cols[1]) && !/^0{32}$/.test(cols[4])) return true;
    }
    return false;
}

function probe(): boolean {
    return linkIsDown((p) => readFileSync(p, 'utf8'), () => readdirSync('/sys/class/net'));
}

/**
 * Start watching connectivity. `resume` runs when connectivity returns (the
 * daemon uses it to schedule a reconciling full pass). The poll timer is
 * unref'd so it can never hold the process open at shutdown.
 */
export function startMonitor(resume: () => void): void {
    onResume = resume;
    const interval = connectivityPollMs();
    // immediate first reading so an offline boot is known before the first open
    setOffline(probe(), 'boot');
    if (interval <= 0) return;
    const timer = setInterval(() => {
        if (offline) {
            // trust "up" only after two consecutive readings, so a flapping
            // carrier does not toggle the state (and re-hang an open) every poll;
            // the escalation to offline stays immediate
            // probe() is true when the link is DOWN; count consecutive readings
            // where it reports UP
            upStreak = probe() ? 0 : upStreak + 1;
            if (upStreak >= 2) setOffline(false, 'link');
        } else if (probe()) {
            setOffline(true, 'link');
        }
    }, interval);
    timer.unref();
    stopPoll = () => clearInterval(timer);
}

export function stopMonitor(): void {
    stopPoll?.();
    stopPoll = null;
    onResume = null;
}

/** Called when a network operation fails: escalate to offline (reactive). */
export function reportNetworkError(e: unknown): void {
    if (isNetworkError(e)) setOffline(true, 'reactive');
}

/** Called when a pass/operation succeeds end to end: connectivity is proven. */
export function reportSuccess(): void {
    setOffline(false, 'success');
}

/** SDK reported that it has paused transfers after repeated offline errors. */
export function sdkPaused(): void {
    setOffline(true, 'sdk');
}

/** SDK reported that transfers resumed (a request succeeded again). */
export function sdkResumed(): void {
    setOffline(false, 'success');
}

/** Test hook: reset module state between cases. */
export function _resetForTest(): void {
    stopMonitor();
    offline = false;
    offlineSince = null;
    lastNotifyAt = 0;
    offlineNotified = false;
    upStreak = 0;
    setStatus({ offline: false, offlineSince: null });
}
