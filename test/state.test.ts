import { beforeEach, describe, expect, test } from 'bun:test';

import * as st from '../src/state';
import { resetState, seedLocalFile, seedRow } from './helpers';

beforeEach(resetState);

describe('keep marks (pinned)', () => {
    test('set/has/del/all round-trip', () => {
        expect(st.pinnedHas('x.bin')).toBe(false);
        st.pinnedSet('x.bin');
        st.pinnedSet('x.bin'); // idempotent
        st.pinnedSet('y.bin');
        expect(st.pinnedHas('x.bin')).toBe(true);
        expect(st.pinnedAll().sort()).toEqual(['x.bin', 'y.bin']);
        st.pinnedDel('x.bin');
        expect(st.pinnedHas('x.bin')).toBe(false);
        expect(st.pinnedAll()).toEqual(['y.bin']);
    });

    test('dropping a baseline row drops its marks with it (no orphans)', () => {
        seedRow({ path: 'a.bin', uid: 'u', type: 'file', lsize: 1, lmtime: 1, rsize: 1, rmtime: 1 });
        st.pinnedSet('a.bin');
        st.onlineSet('a.bin');
        st.syncDel('a.bin');
        expect(st.pinnedHas('a.bin')).toBe(false);
        expect(st.onlineHas('a.bin')).toBe(false);
        expect(st.syncGet('a.bin')).toBeUndefined();
    });

    test('rename carries the online marker and the keep mark to the new path', () => {
        seedRow({ path: 'old.bin', uid: 'u1', type: 'file', lsize: 5, lmtime: 5, rsize: 5, rmtime: 5 });
        st.onlineSet('old.bin', 0);
        st.pinnedSet('old.bin');
        st.syncRename('old.bin', 'new.bin');

        expect(st.syncGet('old.bin')).toBeUndefined();
        expect(st.syncGet('new.bin')).toMatchObject({ path: 'new.bin', uid: 'u1' });
        expect(st.onlineGet('new.bin')).toBe(0);
        expect(st.onlineHas('old.bin')).toBe(false);
        expect(st.pinnedHas('new.bin')).toBe(true);
        expect(st.pinnedHas('old.bin')).toBe(false);
    });

    test('prune drops marks whose baseline row is gone', () => {
        seedRow({ path: 'keep.bin', uid: 'u', type: 'file', lsize: 1, lmtime: 1, rsize: 1, rmtime: 1 });
        st.pinnedSet('keep.bin');
        st.pinnedSet('orphan.bin');
        expect(st.pinnedPrune()).toBe(1);
        expect(st.pinnedAll()).toEqual(['keep.bin']);
    });
});

describe('reclaimableBytes', () => {
    const row = (p: string, over: Partial<st.SyncRow> = {}) =>
        seedRow({ path: p, uid: `u:${p}`, type: 'file', lsize: 100, lmtime: 1_700_000_000_000, rsize: 100, rmtime: 1_700_000_000_000, ...over });

    test('counts steady materialized files only', () => {
        row('local.bin'); // clean, on disk
        row('online.bin');
        st.onlineSet('online.bin'); // placeholder: bytes already gone
        row('kept.bin');
        st.pinnedSet('kept.bin'); // keep on this device
        row('unsynced.bin', { rsize: null, rmtime: null }); // never synced
        row('diverged.bin', { rsize: 10_000 }); // baseline not steady: local edit pending (diff > modifyWindowMs)
        row('dir', { type: 'dir', lsize: null, rsize: null });

        expect(st.reclaimableBytes()).toBe(100); // only local.bin
    });

    test('placeholder bytes are excluded even though the baseline still carries their size', () => {
        row('ph.bin');
        st.onlineSet('ph.bin');
        expect(st.reclaimableBytes()).toBe(0);
        expect(st.syncGet('ph.bin')!.lsize).toBe(100); // baseline untouched by eviction
    });

    test('zero when nothing is synced', () => {
        expect(st.reclaimableBytes()).toBe(0);
    });
});

describe('online markers', () => {
    test('count and defensive prune', () => {
        seedRow({ path: 'live.bin', uid: 'u', type: 'file', lsize: 1, lmtime: 1, rsize: 1, rmtime: 1 });
        st.onlineSet('live.bin');
        st.onlineSet('orphan.bin');
        expect(st.onlineCount()).toBe(2);
        expect(st.onlinePrune()).toBe(1);
        expect(st.onlineCount()).toBe(1);
        expect(st.onlineGet('live.bin')).toBe(0);
        expect(st.onlineGet('missing.bin')).toBeNull();
    });
});

describe('meta', () => {
    test('prefetch override round-trips', () => {
        expect(st.metaGet('prefetch')).toBeNull();
        st.metaSet('prefetch', 'on');
        expect(st.metaGet('prefetch')).toBe('on');
        st.metaSet('prefetch', 'off');
        expect(st.metaGet('prefetch')).toBe('off');
    });
});

describe('placeholder materialization fixtures', () => {
    test('seedLocalFile produces the exact evict-candidate shape', () => {
        const seeded = seedLocalFile('sub/dir/file.txt', Buffer.alloc(64));
        const row = st.syncGet(seeded.rel)!;
        expect(row.type).toBe('file');
        expect(row.lsize).toBe(seeded.size);
        expect(row.rsize).toBe(seeded.size);
        expect(st.reclaimableBytes()).toBe(seeded.size);
    });
});
