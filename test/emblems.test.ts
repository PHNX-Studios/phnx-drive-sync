import { beforeEach, describe, expect, test } from 'bun:test';

import { desiredEmblems, emblemFor, syncEmblems, type ApplyResult } from '../src/emblems';
import * as st from '../src/state';
import { resetState, seedRow } from './helpers';

function fakeApply(record: Map<string, string | null>, behavior?: (rel: string, kw: string | null) => ApplyResult) {
    return async (rel: string, kw: string | null): Promise<ApplyResult> => {
        const res = behavior ? behavior(rel, kw) : 'ok';
        if (res === 'ok') record.set(rel, kw);
        return res;
    };
}

beforeEach(resetState);

describe('emblemFor', () => {
    test('online-only file gets the cloud, materialized file the green check', () => {
        expect(emblemFor('file', true)).toBe('cloud');
        expect(emblemFor('file', false)).toBe('default');
    });

    test('folders never get a badge', () => {
        expect(emblemFor('dir', true)).toBeNull();
        expect(emblemFor('dir', false)).toBeNull();
    });
});

describe('desiredEmblems', () => {
    test('covers files with online markers and materialized rows, skips dirs', () => {
        seedRow({ path: 'keep/a.txt' });
        seedRow({ path: 'gone/b.txt' });
        st.onlineSet('gone/b.txt');
        seedRow({ path: 'Folder', type: 'dir' });
        const desired = desiredEmblems();
        expect(desired.get('keep/a.txt')).toBe('default');
        expect(desired.get('gone/b.txt')).toBe('cloud');
        expect(desired.has('Folder')).toBe(false);
    });
});

describe('syncEmblems', () => {
    test('first run applies every desired badge and records it', async () => {
        seedRow({ path: 'a.txt' });
        seedRow({ path: 'b.txt' });
        st.onlineSet('b.txt');
        const applied = new Map<string, string | null>();
        const s = await syncEmblems(fakeApply(applied));
        expect(s).toEqual({ set: 2, unset: 0, failed: 0, skipped: 0 });
        expect(applied.get('a.txt')).toBe('default');
        expect(applied.get('b.txt')).toBe('cloud');
        expect(st.emblemAll()).toEqual(new Map([
            ['a.txt', 'default'],
            ['b.txt', 'cloud'],
        ]));
    });

    test('second run is a no-op when nothing changed', async () => {
        seedRow({ path: 'a.txt' });
        await syncEmblems(fakeApply(new Map()));
        const applied = new Map<string, string | null>();
        const s = await syncEmblems(fakeApply(applied));
        expect(s).toEqual({ set: 0, unset: 0, failed: 0, skipped: 0 });
        expect(applied.size).toBe(0);
    });

    test('state transitions flip the badge: evict -> cloud, hydrate -> check', async () => {
        seedRow({ path: 'a.txt' });
        await syncEmblems(fakeApply(new Map()));
        st.onlineSet('a.txt');
        let applied = new Map<string, string | null>();
        expect((await syncEmblems(fakeApply(applied))).set).toBe(1);
        expect(applied.get('a.txt')).toBe('cloud');
        st.onlineDel('a.txt');
        applied = new Map();
        expect((await syncEmblems(fakeApply(applied))).set).toBe(1);
        expect(applied.get('a.txt')).toBe('default');
    });

    test('deleted rows clear the stored badge', async () => {
        seedRow({ path: 'a.txt' });
        await syncEmblems(fakeApply(new Map()));
        st.syncDel('a.txt');
        const applied = new Map<string, string | null>();
        const s = await syncEmblems(fakeApply(applied));
        expect(s).toEqual({ set: 0, unset: 1, failed: 0, skipped: 0 });
        expect(applied.get('a.txt')).toBeNull();
        expect(st.emblemAll().size).toBe(0);
    });

    test('failed applies are retried on the next run', async () => {
        seedRow({ path: 'a.txt' });
        let fail = true;
        const behavior = (): ApplyResult => (fail ? 'fail' : 'ok');
        const applied = new Map<string, string | null>();
        let s = await syncEmblems(fakeApply(applied, behavior));
        expect(s.failed).toBe(1);
        expect(st.emblemAll().size).toBe(0);
        fail = false;
        s = await syncEmblems(fakeApply(applied, behavior));
        expect(s).toEqual({ set: 1, unset: 0, failed: 0, skipped: 0 });
        expect(st.emblemAll().get('a.txt')).toBe('default');
    });

    test('skipped applies (path absent, mount down) do not record and are retried', async () => {
        seedRow({ path: 'a.txt' });
        const behavior = (): ApplyResult => 'skip';
        let s = await syncEmblems(fakeApply(new Map(), behavior));
        expect(s).toEqual({ set: 0, unset: 0, failed: 0, skipped: 1 });
        expect(st.emblemAll().size).toBe(0);
        s = await syncEmblems(fakeApply(new Map()));
        expect(s.set).toBe(1);
    });

    test('rename swaps the badge to the new path', async () => {
        seedRow({ path: 'old.txt' });
        st.onlineSet('old.txt');
        await syncEmblems(fakeApply(new Map()));
        st.syncRename('old.txt', 'new.txt', 'uid:1');
        const applied = new Map<string, string | null>();
        await syncEmblems(fakeApply(applied));
        expect(applied.get('new.txt')).toBe('cloud');
        expect(applied.get('old.txt')).toBeNull();
        expect(st.emblemAll()).toEqual(new Map([['new.txt', 'cloud']]));
    });
});
