import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { treeRoot } from '../src/config';
import { evictAll, evictSummary, fmtBytes, maybeAutoEvict } from '../src/evict';
import * as st from '../src/state';
import { mutate, resetState, seedLocalFile, seedRow } from './helpers';

beforeEach(() => {
    resetState();
    mkdirSync(treeRoot, { recursive: true });
});

describe('evictAll', () => {
    test('frees clean steady files largest-first, marker before unlink', () => {
        seedLocalFile('a/small.bin', Buffer.alloc(1024));
        seedLocalFile('b/big.bin', Buffer.alloc(4096));
        seedLocalFile('c/mid.bin', Buffer.alloc(2048));

        const out = evictAll();

        expect(out.freed).toBe(3);
        expect(out.bytes).toBe(1024 + 4096 + 2048);
        expect(out.freedPaths).toEqual(['b/big.bin', 'c/mid.bin', 'a/small.bin']);
        expect(out.dirty).toBe(0);
        expect(out.kept).toBe(0);
        expect(existsSync(path.join(treeRoot, 'b/big.bin'))).toBe(false);
        expect(st.onlineGet('b/big.bin')).toBe(0); // placeholder marker landed before unlink (I1)
        expect(st.onlineCount()).toBe(3);
    });

    test('dirty file (unsynced local edit) is never freed', () => {
        const clean = seedLocalFile('clean.txt', Buffer.alloc(100));
        const dirty = seedLocalFile('dirty.txt', Buffer.alloc(100));
        mutate(dirty);

        const out = evictAll();

        expect(out.freed).toBe(1);
        expect(out.freedPaths).toEqual(['clean.txt']);
        expect(out.dirty).toBe(1);
        expect(existsSync(path.join(treeRoot, 'dirty.txt'))).toBe(true);
        expect(st.onlineGet('dirty.txt')).toBeNull();
    });

    test('keep-marked (pinned) file is never freed', () => {
        seedLocalFile('keep-me.txt', Buffer.alloc(100), { keep: true });
        seedLocalFile('free-me.txt', Buffer.alloc(100));

        const out = evictAll();

        expect(out.freed).toBe(1);
        expect(out.kept).toBe(1);
        expect(existsSync(path.join(treeRoot, 'keep-me.txt'))).toBe(true);
        expect(st.pinnedHas('keep-me.txt')).toBe(true); // mark survives eviction attempts
    });

    test('busy (mid-recall) files are skipped, already-online files ignored', () => {
        seedLocalFile('recalling.bin', Buffer.alloc(100));
        seedLocalFile('gone.bin', Buffer.alloc(100), { online: true }); // marker but still on disk

        const out = evictAll({ busy: new Set(['recalling.bin']) });

        expect(out.freed).toBe(0);
        expect(existsSync(path.join(treeRoot, 'recalling.bin'))).toBe(true);
        expect(existsSync(path.join(treeRoot, 'gone.bin'))).toBe(true);
    });

    test('targets narrows the scope', () => {
        seedLocalFile('one.txt', Buffer.alloc(100));
        seedLocalFile('two.txt', Buffer.alloc(100));
        seedLocalFile('three.txt', Buffer.alloc(100));

        const out = evictAll({ targets: ['two.txt'] });

        expect(out.freedPaths).toEqual(['two.txt']);
        expect(existsSync(path.join(treeRoot, 'one.txt'))).toBe(true);
        expect(existsSync(path.join(treeRoot, 'three.txt'))).toBe(true);
        expect(st.onlineCount()).toBe(1);
    });

    test('directories and rows without a remote id are never freed', () => {
        mkdirSync(path.join(treeRoot, 'some-dir'), { recursive: true });
        seedRow({ path: 'some-dir', uid: 'uid-dir', type: 'dir' });
        seedLocalFile('no-uid.txt', Buffer.alloc(100));
        st.syncSet({ ...st.syncGet('no-uid.txt')!, uid: null });

        const out = evictAll();

        expect(out.freed).toBe(0);
        expect(out.unsafe).toBe(1); // the uid-less file; dirs are not even candidates
        expect(existsSync(path.join(treeRoot, 'some-dir'))).toBe(true);
        expect(existsSync(path.join(treeRoot, 'no-uid.txt'))).toBe(true);
    });

    test('threshold already satisfied: stops before freeing anything', () => {
        seedLocalFile('x.bin', Buffer.alloc(4096));
        const out = evictAll({ thresholdBytes: 0 });
        expect(out.freed).toBe(0);
        expect(out.stoppedEarly).toBe(true);
        expect(existsSync(path.join(treeRoot, 'x.bin'))).toBe(true);
    });
});

describe('evict reporting', () => {
    test('evictSummary includes bytes, counts and a bounded path list', () => {
        const paths = Array.from({ length: 10 }, (_, i) => `f${i}.bin`);
        const out = {
            freed: 10,
            bytes: 4096,
            freedPaths: paths,
            dirty: 2,
            kept: 1,
            unsafe: 0,
            stoppedEarly: false,
        };
        const line = evictSummary(out, 3);
        expect(line).toContain('4.0 KB');
        expect(line).toContain('10 file(s)');
        expect(line).toContain('1 kept on this device');
        expect(line).toContain('f0.bin, f1.bin, f2.bin');
        expect(line).toContain('+7 more');
    });

    test('fmtBytes renders units', () => {
        expect(fmtBytes(0)).toBe('0 B');
        expect(fmtBytes(1024)).toBe('1.0 KB');
        expect(fmtBytes(1536)).toBe('1.5 KB');
    });
});

describe('maybeAutoEvict', () => {
    test('disabled (default threshold 0): never touches the tree', () => {
        delete process.env.PHNX_DRIVE_SYNC_EVICT_FREE_GB;
        seedLocalFile('auto.bin', Buffer.alloc(4096));
        expect(maybeAutoEvict()).toBeNull();
        expect(existsSync(path.join(treeRoot, 'auto.bin'))).toBe(true);
    });

    test('positive threshold: runs, but only eligible (clean) files go', () => {
        const dirty = seedLocalFile('auto2.bin', Buffer.alloc(4096));
        mutate(dirty);
        process.env.PHNX_DRIVE_SYNC_EVICT_FREE_GB = '999999'; // absurdly high: below threshold on any disk
        try {
            const out = maybeAutoEvict();
            expect(out).not.toBeNull();
            expect(out!.freed).toBe(0);
            expect(out!.dirty).toBe(1);
        } finally {
            delete process.env.PHNX_DRIVE_SYNC_EVICT_FREE_GB;
        }
        expect(existsSync(path.join(treeRoot, 'auto2.bin'))).toBe(true);
    });
});
