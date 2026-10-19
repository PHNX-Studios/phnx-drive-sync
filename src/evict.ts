import { statSync, statfsSync, unlinkSync } from 'node:fs';

import { evictFreeGb, treeRoot } from './config';
import { log } from './log';
import { notify } from './notify';
import * as st from './state';
import { fileEq, steady } from './sync';

export { notify };

function abs(p: string): string {
    return p === '' ? treeRoot : `${treeRoot}/${p}`;
}

export function fmtBytes(n: number): string {
    let v = Math.max(0, n);
    for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
        if (v < 1024 || unit === 'TB') return unit === 'B' ? `${Math.round(v)} B` : `${v.toFixed(1)} ${unit}`;
        v /= 1024;
    }
    return `${v.toFixed(1)} TB`;
}

export interface EvictOutcome {
    /** files whose local bytes were removed (marker set first, I1) */
    freed: number;
    bytes: number;
    /** rel paths freed, largest first (callers log a bounded prefix) */
    freedPaths: string[];
    /** in scope but not provably identical to the synced copy: never freed */
    dirty: number;
    /** in scope but keep-marked (`pinned` table): never freed */
    kept: number;
    /** baseline rows without a remote id, or unlink failures: never freed */
    unsafe: number;
    /** stopped as soon as free space cleared the threshold */
    stoppedEarly: boolean;
}

function freeBytes(): number {
    const s = statfsSync(treeRoot);
    // POSIX statfs carries frsize (fragment size); Node's StatsFs type doesn't declare it, bun's does
    const frsize = (s as { frsize?: number }).frsize ?? s.bsize;
    return s.bavail * frsize;
}

/**
 * Free the local bytes of synced files, largest first.
 *
 * A file is a candidate only when all of these hold: it is a baseline file row,
 * present on disk, byte-identical to the local baseline (clean), part of a steady
 * baseline (local == remote facts), has a remote id, is not already online-only,
 * is not keep-marked, and is not mid-recall (`busy`).
 *
 * `targets` narrows the scope (exact baseline paths); null = every baseline file.
 * `thresholdBytes` stops the loop as soon as free space clears it (auto-evict).
 */
export function evictAll(opts: { targets?: string[] | null; busy?: ReadonlySet<string>; thresholdBytes?: number | null } = {}): EvictOutcome {
    const targets = opts.targets ?? null;
    const busy = opts.busy;
    const thresholdBytes = opts.thresholdBytes ?? null;
    const out: EvictOutcome = { freed: 0, bytes: 0, freedPaths: [], dirty: 0, kept: 0, unsafe: 0, stoppedEarly: false };

    const S = st.syncAll();
    const online = st.onlineAll();
    const keep = new Set(st.pinnedAll());
    const candidates: { p: string; size: number }[] = [];

    for (const [p, row] of S) {
        if (row.type !== 'file') continue;
        if (targets && !targets.includes(p)) continue;
        if (online.has(p)) continue; // already free
        if (busy?.has(p)) continue; // recall in flight: racing it only wastes a download
        if (keep.has(p)) {
            out.kept++;
            continue;
        }
        if (row.uid === null || row.lsize === null || row.lmtime === null) {
            out.unsafe++;
            continue;
        }
        let size: number;
        let mtimeMs: number;
        try {
            const s = statSync(abs(p));
            size = s.size;
            mtimeMs = s.mtimeMs;
        } catch {
            continue; // absent: nothing to free (pass will reconcile)
        }
        if (!steady(row) || !fileEq(size, mtimeMs, row.lsize, row.lmtime)) {
            out.dirty++;
            continue;
        }
        candidates.push({ p, size });
    }

    candidates.sort((a, b) => b.size - a.size);
    let free = thresholdBytes === null ? 0 : freeBytes();
    for (const c of candidates) {
        if (thresholdBytes !== null && free >= thresholdBytes) {
            out.stoppedEarly = true;
            break;
        }
        // marker BEFORE unlink so a watcher DELETE classifies as a steady placeholder (I1)
        st.onlineSet(c.p, 0);
        try {
            unlinkSync(abs(c.p));
            out.freed++;
            out.bytes += c.size;
            out.freedPaths.push(c.p);
        } catch {
            st.onlineDel(c.p); // never leave a marker on a present file
            out.unsafe++;
        }
        if (thresholdBytes !== null) free = freeBytes();
    }
    return out;
}

/** "Freed N file(s), X" + the first few paths — shared by the auto-evict and bulk-free reports. */
export function evictSummary(out: EvictOutcome, maxPaths = 8): string {
    const shown = out.freedPaths.slice(0, maxPaths).join(', ');
    const more = out.freedPaths.length > maxPaths ? ` … +${out.freedPaths.length - maxPaths} more` : '';
    const skipped =
        out.kept > 0 || out.dirty > 0
            ? ` (${out.kept} kept on this device, ${out.dirty} with unsynced changes left local)`
            : '';
    return `freed ${fmtBytes(out.bytes)} (${out.freed} file(s))${skipped}${shown ? `: ${shown}${more}` : ''}`;
}

let lastStarveWarnAt = 0;

/**
 * Auto-evict (Phase 3): when the filesystem holding the real tree drops below
 * `PHNX_DRIVE_SYNC_EVICT_FREE_GB`, free the largest clean, non-keep-marked local files
 * until the threshold is cleared, then report via notify-send. Disabled by default.
 */
export function maybeAutoEvict(busy?: ReadonlySet<string>): EvictOutcome | null {
    const freeGb = evictFreeGb();
    if (freeGb <= 0) return null;
    const thresholdBytes = Math.round(freeGb * 1024 ** 3);
    const free = freeBytes();
    if (free >= thresholdBytes) return null;

    log('WARN', `low disk: ${fmtBytes(free)} free < ${fmtBytes(thresholdBytes)} threshold; evicting largest clean local files`);
    const out = evictAll({ busy, thresholdBytes });
    const still = freeBytes();
    if (out.freed > 0) {
        log('INFO', `auto-evict: ${evictSummary(out)}; ${fmtBytes(still)} free now`);
        notify(
            `Freed ${fmtBytes(out.bytes)} (${out.freed} file(s)) to get back above the ` +
                `${fmtBytes(thresholdBytes)} low-disk threshold.\n${fmtBytes(still)} free now. ` +
                `Keep-on-this-device files were not touched.`,
        );
    } else if (Date.now() - lastStarveWarnAt > 30 * 60_000) {
        lastStarveWarnAt = Date.now();
        log('WARN', `auto-evict: nothing eligible while below threshold (${fmtBytes(still)} free; only pinned or dirty files left)`);
    }
    return out;
}
