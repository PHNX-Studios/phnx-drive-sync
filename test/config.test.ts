import { afterEach, describe, expect, test } from 'bun:test';

import { watcherPollMs } from '../src/config';

const original = process.env.DRIVE_SYNC_POLL_MS;

afterEach(() => {
    if (original === undefined) delete process.env.DRIVE_SYNC_POLL_MS;
    else process.env.DRIVE_SYNC_POLL_MS = original;
});

describe('watcherPollMs (safety-poll interval)', () => {
    test('defaults to 2 minutes when unset', () => {
        delete process.env.DRIVE_SYNC_POLL_MS;
        expect(watcherPollMs()).toBe(120_000);
    });

    test('empty value falls back to the default', () => {
        process.env.DRIVE_SYNC_POLL_MS = '';
        expect(watcherPollMs()).toBe(120_000);
    });

    test('0 disables the safety net', () => {
        process.env.DRIVE_SYNC_POLL_MS = '0';
        expect(watcherPollMs()).toBe(0);
    });

    test('negative disables the safety net', () => {
        process.env.DRIVE_SYNC_POLL_MS = '-5';
        expect(watcherPollMs()).toBe(0);
    });

    test('garbage disables rather than NaN', () => {
        process.env.DRIVE_SYNC_POLL_MS = 'abc';
        expect(watcherPollMs()).toBe(0);
    });

    test('explicit value is honored', () => {
        process.env.DRIVE_SYNC_POLL_MS = '60000';
        expect(watcherPollMs()).toBe(60_000);
    });
});
