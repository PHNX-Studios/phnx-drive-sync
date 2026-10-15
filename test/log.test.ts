import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { statusFile } from '../src/config';
import { bumpRevision, setStatus, status } from '../src/log';

describe('status revision', () => {
    beforeEach(() => {
        status.revision = 0;
    });

    test('starts at zero and only ever advances', () => {
        expect(status.revision).toBe(0);
        bumpRevision();
        bumpRevision();
        expect(status.revision).toBe(2);
    });

    test('setStatus persists the bumped revision to status.json', () => {
        bumpRevision();
        setStatus({ state: 'running' });
        const written = JSON.parse(readFileSync(statusFile, 'utf8')) as { revision: number; state: string };
        expect(written.revision).toBe(1);
        expect(written.state).toBe('running');
    });

    test('a following setStatus keeps the latest revision', () => {
        bumpRevision();
        setStatus({ state: 'passing' });
        bumpRevision();
        setStatus({ state: 'running' });
        const written = JSON.parse(readFileSync(statusFile, 'utf8')) as { revision: number };
        expect(written.revision).toBe(2);
    });
});
