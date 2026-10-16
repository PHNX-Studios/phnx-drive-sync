import { beforeEach, describe, expect, test } from 'bun:test';

import type { LocalNode } from '../src/scan';
import { classify, type Action, type PassStats } from '../src/sync';
import * as st from '../src/state';
import { resetState, seedRow } from './helpers';

function stats(): PassStats {
    return { uploads: 0, downloads: 0, deletes: 0, renames: 0, conflicts: 0, adopts: 0, errors: 0, lastError: null, authFailed: false };
}

function run(
    L: Map<string, LocalNode>,
    R: Map<string, st.CacheRow>,
    S: Map<string, st.SyncRow>,
    online: Map<string, number>,
    dry = false,
): { actions: Action[]; stats: PassStats } {
    const s = stats();
    const actions = classify(L, R, S, online, s, dry);
    return { actions, stats: s };
}

const localFile = (size: number, mtimeMs: number): LocalNode => ({ dir: false, size, mtimeMs });
const remoteFile = (uid: string, size: number, mtime: number): st.CacheRow => ({ path: '', uid, type: 'file', size, mtime });

/** A steady baseline + matching remote facts for `p` (the placeholder shape). */
function steadyFile(p: string, size: number, mtimeMs: number, uid = 'uid-1'): st.SyncRow {
    return { path: p, uid, type: 'file', lsize: size, lmtime: mtimeMs, rsize: size, rmtime: mtimeMs };
}

beforeEach(resetState);

describe('classify: online-only (placeholder) files', () => {
    const p = 'docs/report.pdf';
    const SIZE = 4096;
    const MTIME = 1_700_000_000_000;

    test('steady remote, absent locally: no action (never delete, never re-download)', () => {
        seedRow(steadyFile(p, SIZE, MTIME));
        const R = new Map([[p, remoteFile('uid-1', SIZE, MTIME)]]);
        const S = new Map([[p, st.syncGet(p)!]]);
        const { actions, stats } = run(new Map(), R, S, new Map([[p, 0]]));
        expect(actions).toEqual([]);
        expect(stats.deletes).toBe(0);
        expect(stats.downloads).toBe(0);
    });

    test('remote changed under the placeholder: metadata adopt, no download/trash action', () => {
        seedRow(steadyFile(p, SIZE, MTIME));
        const newMtime = MTIME + 60_000;
        const R = new Map([[p, remoteFile('uid-1', SIZE + 100, newMtime)]]);
        const S = new Map([[p, st.syncGet(p)!]]);
        const { actions, stats } = run(new Map(), R, S, new Map([[p, 0]]));
        expect(actions).toEqual([]);
        expect(stats.adopts).toBe(1);
        // l := r mirror so the baseline stays steady and a later pin hydrates current bytes
        const row = st.syncGet(p)!;
        expect(row.lsize).toBe(SIZE + 100);
        expect(row.lmtime).toBe(newMtime);
        expect(row.rsize).toBe(SIZE + 100);
        expect(row.rmtime).toBe(newMtime);
    });

    test('same in dry mode: reports the adopt but writes nothing', () => {
        seedRow(steadyFile(p, SIZE, MTIME));
        const R = new Map([[p, remoteFile('uid-1', SIZE + 100, MTIME + 60_000)]]);
        const S = new Map([[p, st.syncGet(p)!]]);
        const { actions, stats } = run(new Map(), R, S, new Map([[p, 0]]), true);
        expect(actions).toEqual([]);
        expect(stats.adopts).toBe(1);
        expect(st.syncGet(p)!.lsize).toBe(SIZE); // untouched
    });

    test('same shape without the online marker propagates the local delete (contrast)', () => {
        seedRow(steadyFile(p, SIZE, MTIME));
        const R = new Map([[p, remoteFile('uid-1', SIZE, MTIME)]]);
        const S = new Map([[p, st.syncGet(p)!]]);
        const { actions, stats } = run(new Map(), R, S, new Map()); // no marker
        expect(actions).toEqual([{ phase: 'trashRemote', p, uid: 'uid-1', dir: false }]);
        expect(stats.deletes).toBe(1);
    });

    test('online-only files are never local-rename sources (I2)', () => {
        seedRow(steadyFile('a.txt', SIZE, MTIME));
        const S = new Map([['a.txt', st.syncGet('a.txt')!]]);
        const R = new Map([['a.txt', remoteFile('uid-1', SIZE, MTIME)]]);
        // fresh local twin: same size/mtime, would pair up if the marker were ignored
        const L = new Map([['b.txt', localFile(SIZE, MTIME)]]);
        const { stats, actions } = run(L, R, S, new Map([['a.txt', 0]]));
        expect(stats.renames).toBe(0);
        expect(actions.every((a) => a.phase !== 'renameRemote')).toBe(true);
    });

    test('contrast: without the marker the same twin pairs into renameRemote', () => {
        seedRow(steadyFile('a.txt', SIZE, MTIME));
        const S = new Map([['a.txt', st.syncGet('a.txt')!]]);
        const R = new Map([['a.txt', remoteFile('uid-1', SIZE, MTIME)]]);
        const L = new Map([['b.txt', localFile(SIZE, MTIME)]]);
        const { stats, actions } = run(L, R, S, new Map());
        expect(stats.renames).toBe(1);
        expect(actions[0]).toEqual({ phase: 'renameRemote', from: 'a.txt', to: 'b.txt' });
    });
});

describe('classify: PHNX_DRIVE_SYNC_NEW_FILES (live env read)', () => {
    const p = 'new/remote.bin';
    const SIZE = 777;
    const MTIME = 1_700_000_100_000;
    const R = new Map([[p, remoteFile('uid-new', SIZE, MTIME)]]);

    test('default (local): a new remote file downloads', () => {
        delete process.env.PHNX_DRIVE_SYNC_NEW_FILES;
        const { actions, stats } = run(new Map(), R, new Map(), new Map());
        expect(actions).toEqual([{ phase: 'download', p, uid: 'uid-new', size: SIZE, mtimeMs: MTIME }]);
        expect(stats.downloads).toBe(1);
    });

    test('online: a new remote file becomes a placeholder', () => {
        process.env.PHNX_DRIVE_SYNC_NEW_FILES = 'online';
        try {
            const { actions, stats } = run(new Map(), R, new Map(), new Map());
            expect(actions).toEqual([{ phase: 'adoptOnline', p, uid: 'uid-new', size: SIZE, mtimeMs: MTIME }]);
            expect(stats.adopts).toBe(1);
            expect(stats.downloads).toBe(0);
        } finally {
            delete process.env.PHNX_DRIVE_SYNC_NEW_FILES;
        }
    });
});

describe('classify: seed adoption', () => {
    test('identical fresh local+remote pair adopts the baseline instead of conflicting', () => {
        const p = 'seeded.txt';
        const SIZE = 10;
        const MTIME = 1_700_000_200_000; // inside seedAdoptWindowMs of "now" for real runs; irrelevant here
        const L = new Map([[p, localFile(SIZE, MTIME)]]);
        const R = new Map([[p, remoteFile('uid-seed', SIZE, MTIME)]]);
        const { actions, stats } = run(L, R, new Map(), new Map());
        expect(actions).toEqual([]);
        expect(stats.adopts).toBe(1);
        expect(st.syncGet(p)).toMatchObject({ uid: 'uid-seed', lsize: SIZE, rsize: SIZE });
    });
});

describe('classify: filtering a synced file mirrors the local delete (option b)', () => {
    // A steady, previously-synced file that now matches .protonignore: walkLocal()
    // no longer returns it (L is empty), but the incremental remote cache and the
    // baseline still hold it. Chosen semantics: mirror the local absence, so the
    // remote copy is trashed (recoverable from Proton) rather than left orphaned.
    test('a steady file that becomes filtered is trashed remotely', () => {
        const p = 'secret/notes.txt';
        const SIZE = 2048;
        const MTIME = 1_700_000_300_000;
        seedRow(steadyFile(p, SIZE, MTIME));
        const R = new Map([[p, remoteFile('uid-1', SIZE, MTIME)]]);
        const S = new Map([[p, st.syncGet(p)!]]);
        const { actions, stats } = run(new Map(), R, S, new Map());
        expect(actions).toEqual([{ phase: 'trashRemote', p, uid: 'uid-1', dir: false }]);
        expect(stats.deletes).toBe(1);
    });
});
