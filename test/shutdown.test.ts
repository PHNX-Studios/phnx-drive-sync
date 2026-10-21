import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { shutdownGraceMs, treeRoot } from '../src/config';
import { waitForPassEnd } from '../src/shutdown';
import { execute, requestStop, type Action, type PassStats } from '../src/sync';

function stats(): PassStats {
    return { uploads: 0, downloads: 0, deletes: 0, renames: 0, conflicts: 0, adopts: 0, errors: 0, lastError: null, authFailed: false, scanAuthFailed: false };
}

describe('waitForPassEnd', () => {
    test('returns immediately when no pass is running', async () => {
        let slept = 0;
        let t = 0;
        const ok = await waitForPassEnd({
            isPassing: () => false,
            graceMs: 1000,
            now: () => t,
            sleep: async (ms) => {
                slept++;
                t += ms;
            },
        });
        expect(ok).toBe(true);
        expect(slept).toBe(0);
    });

    test('returns true once the pass ends within the grace period', async () => {
        let remaining = 3;
        let t = 0;
        const ok = await waitForPassEnd({
            isPassing: () => remaining > 0,
            graceMs: 10_000,
            pollMs: 100,
            now: () => t,
            sleep: async (ms) => {
                t += ms;
                remaining--;
            },
        });
        expect(ok).toBe(true);
    });

    test('returns false when the pass outlives the grace period', async () => {
        let t = 0;
        let slept = 0;
        const ok = await waitForPassEnd({
            isPassing: () => true,
            graceMs: 250,
            pollMs: 100,
            now: () => t,
            sleep: async (ms) => {
                slept++;
                t += ms;
            },
        });
        expect(ok).toBe(false);
        expect(slept).toBe(3); // 0 -> 100 -> 200 -> 300 (>= 250) then gives up
    });
});

describe('execute cooperative stop', () => {
    beforeEach(() => {
        mkdirSync(treeRoot, { recursive: true });
        for (const p of ['s1', 's2', 's3', 's4']) {
            rmSync(path.join(treeRoot, p), { recursive: true, force: true });
        }
    });

    test('finishes the in-flight action, then stops before starting the next', async () => {
        const actions: Action[] = [
            { phase: 'mkdirLocal', p: 's1' },
            { phase: 'mkdirLocal', p: 's2' },
            { phase: 'mkdirLocal', p: 's3' },
            { phase: 'mkdirLocal', p: 's4' },
        ];
        let checks = 0;
        // allow two actions, then request stop; the check happens before the 3rd
        const shouldStop = (): boolean => ++checks > 2;

        await execute(actions, new Map(), stats(), shouldStop);

        expect(existsSync(path.join(treeRoot, 's1'))).toBe(true);
        expect(existsSync(path.join(treeRoot, 's2'))).toBe(true);
        expect(existsSync(path.join(treeRoot, 's3'))).toBe(false);
        expect(existsSync(path.join(treeRoot, 's4'))).toBe(false);
        expect(checks).toBe(3); // checked before the 3rd action and stopped
    });

    // Must run last in this file: requestStop() is process-lifetime (as in prod).
    test('the default predicate honours requestStop()', async () => {
        rmSync(path.join(treeRoot, 'stopme'), { recursive: true, force: true });
        requestStop();
        await execute([{ phase: 'mkdirLocal', p: 'stopme' }], new Map(), stats());
        expect(existsSync(path.join(treeRoot, 'stopme'))).toBe(false);
    });
});

describe('shutdownGraceMs', () => {
    test('defaults to 120000 and honours the env override', () => {
        delete process.env.PHNX_DRIVE_SYNC_SHUTDOWN_GRACE_MS;
        expect(shutdownGraceMs()).toBe(120_000);
        process.env.PHNX_DRIVE_SYNC_SHUTDOWN_GRACE_MS = '5000';
        expect(shutdownGraceMs()).toBe(5000);
        process.env.PHNX_DRIVE_SYNC_SHUTDOWN_GRACE_MS = 'nonsense';
        expect(shutdownGraceMs()).toBe(120_000);
        delete process.env.PHNX_DRIVE_SYNC_SHUTDOWN_GRACE_MS;
    });
});
