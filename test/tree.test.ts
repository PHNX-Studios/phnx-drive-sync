import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { treeRoot } from '../src/config';
import type { ListEntry } from '../src/rpc';
import * as st from '../src/state';
import { listDirStatus } from '../src/tree';
import { mutate, resetState, seedLocalFile } from './helpers';

function find(entries: ListEntry[], rel: string): ListEntry | undefined {
    return entries.find((e) => e.path === rel);
}

beforeEach(() => {
    // resetState wipes the shared baseline; the tree on disk is also shared
    // across test files, so clear it too (bun runs test files sequentially).
    resetState();
    rmSync(treeRoot, { recursive: true, force: true });
    mkdirSync(treeRoot, { recursive: true });
});

describe('listDirStatus', () => {
    test('lists directories first, then files, sorted by name', () => {
        seedLocalFile('zebra.txt', 'z');
        seedLocalFile('apple.txt', 'a');
        mkdirSync(path.join(treeRoot, 'sub'), { recursive: true });

        const entries = listDirStatus('');

        expect(entries.map((e) => e.name)).toEqual(['sub', 'apple.txt', 'zebra.txt']);
        expect(entries[0].type).toBe('dir');
        expect(entries[0].sync).toBe('n/a');
    });

    test('a clean materialized file is presence=local, sync=clean', () => {
        seedLocalFile('clean.txt', Buffer.alloc(16));

        const entry = find(listDirStatus(''), 'clean.txt')!;

        expect(entry.presence).toBe('local');
        expect(entry.sync).toBe('clean');
        expect(entry.size).toBe(16);
        expect(entry.pinned).toBe(false);
    });

    test('an unsynced local edit is sync=dirty', () => {
        const seeded = seedLocalFile('dirty.txt', Buffer.alloc(16));
        mutate(seeded);

        expect(find(listDirStatus(''), 'dirty.txt')!.sync).toBe('dirty');
    });

    test('a file with no baseline row is sync=unsynced', () => {
        writeFileSync(path.join(treeRoot, 'brand-new.txt'), 'hello');

        const entry = find(listDirStatus(''), 'brand-new.txt')!;

        expect(entry.presence).toBe('local');
        expect(entry.sync).toBe('unsynced');
        expect(entry.size).toBe(5);
    });

    test('an online-only placeholder is presence=online with baseline size', () => {
        const seeded = seedLocalFile('cloud.bin', Buffer.alloc(42));
        st.onlineSet('cloud.bin');
        unlinkSync(seeded.abs); // bytes gone locally, marker + baseline remain

        const entry = find(listDirStatus(''), 'cloud.bin')!;

        expect(entry.presence).toBe('online');
        expect(entry.sync).toBe('clean');
        expect(entry.size).toBe(42);
    });

    test('the keep-mark rides along as pinned=true', () => {
        seedLocalFile('keep.txt', Buffer.alloc(4), { keep: true });

        expect(find(listDirStatus(''), 'keep.txt')!.pinned).toBe(true);
    });

    test('hides trash, .protonignore and .drivesync.part entries', () => {
        seedLocalFile('real.txt', 'x');
        writeFileSync(path.join(treeRoot, '.protonignore'), '');
        writeFileSync(path.join(treeRoot, 'upload.drivesync.part'), '');
        mkdirSync(path.join(treeRoot, '.Trash-1000'), { recursive: true });

        const names = listDirStatus('').map((e) => e.name);

        expect(names).toEqual(['real.txt']);
    });

    test('lists only the direct children of a subdirectory', () => {
        seedLocalFile('sub/inner.txt', 'i');
        seedLocalFile('sub/deeper/leaf.txt', 'l');
        seedLocalFile('top.txt', 't');

        const sub = listDirStatus('sub');

        expect(sub.map((e) => e.name)).toEqual(['deeper', 'inner.txt']);
        expect(listDirStatus('')).toHaveLength(2); // sub/ + top.txt, not the nested files
    });

    test('an unreadable directory yields an empty listing', () => {
        expect(listDirStatus('does-not-exist')).toEqual([]);
    });
});
