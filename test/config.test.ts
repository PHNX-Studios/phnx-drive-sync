import { afterEach, describe, expect, test } from 'bun:test';

import { watcherPollMs } from '../src/config';

const NEW = 'PHNX_DRIVE_SYNC_POLL_MS';
const LEGACY = 'DRIVE_SYNC_POLL_MS';
const originalNew = process.env[NEW];
const originalLegacy = process.env[LEGACY];

afterEach(() => {
    if (originalNew === undefined) delete process.env[NEW];
    else process.env[NEW] = originalNew;
    if (originalLegacy === undefined) delete process.env[LEGACY];
    else process.env[LEGACY] = originalLegacy;
});

describe('watcherPollMs (safety-poll interval)', () => {
    test('defaults to 2 minutes when unset', () => {
        delete process.env[NEW];
        delete process.env[LEGACY];
        expect(watcherPollMs()).toBe(120_000);
    });

    test('empty value falls back to the default', () => {
        process.env[NEW] = '';
        expect(watcherPollMs()).toBe(120_000);
    });

    test('0 disables the safety net', () => {
        process.env[NEW] = '0';
        expect(watcherPollMs()).toBe(0);
    });

    test('negative disables the safety net', () => {
        process.env[NEW] = '-5';
        expect(watcherPollMs()).toBe(0);
    });

    test('garbage disables rather than NaN', () => {
        process.env[NEW] = 'abc';
        expect(watcherPollMs()).toBe(0);
    });

    test('explicit value is honored', () => {
        process.env[NEW] = '60000';
        expect(watcherPollMs()).toBe(60_000);
    });
});

describe('env aliases (PHNX_DRIVE_SYNC_* canonical, DRIVE_SYNC_* legacy)', () => {
    test('the legacy DRIVE_SYNC_* name is still honored', () => {
        delete process.env[NEW];
        process.env[LEGACY] = '45000';
        expect(watcherPollMs()).toBe(45_000);
    });

    test('the canonical PHNX_DRIVE_SYNC_* name wins over the legacy one', () => {
        process.env[LEGACY] = '45000';
        process.env[NEW] = '7000';
        expect(watcherPollMs()).toBe(7_000);
    });
});
