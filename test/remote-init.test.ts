import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { APICodeError } from '@protontech/drive-sdk/internal/apiService/errors';

import { _setInitForTest, initRemote, isAuthError, remoteRootUid, SessionKeptError } from '../src/remote';
import { initOpenPGPCryptoModule, releaseOpenPGPCryptoModule } from '../vendor/cli/src/init';
import { resetState } from './helpers';

type FakeApp = Awaited<ReturnType<typeof import('../vendor/cli/src/init').init>>;

/** A minimal app: only what initRemote touches. */
function fakeApp(getRoot: () => Promise<{ uid: string; treeEventScopeId: string }>): FakeApp {
    return {
        sdk: {
            onMessage: () => {},
            getMyFilesRootFolder: getRoot,
            async *iterateEvents() {},
        },
        clearCaches: async () => {},
        dispose: async () => {},
    } as unknown as FakeApp;
}

afterEach(() => {
    _setInitForTest();
    resetState();
});

afterAll(async () => {
    await releaseOpenPGPCryptoModule();
});

describe('crypto endpoint lifecycle', () => {
    test('initOpenPGPCryptoModule can run repeatedly without "already initialised"', async () => {
        await initOpenPGPCryptoModule();
        await initOpenPGPCryptoModule();
        await releaseOpenPGPCryptoModule();
        await releaseOpenPGPCryptoModule(); // releasing nothing is not an error
    });
});

describe('initRemote retry after a failed attempt', () => {
    test('an auth rejection does not poison the next attempt', async () => {
        let calls = 0;
        _setInitForTest(async () => {
            calls++;
            await initOpenPGPCryptoModule(); // the real singleton, as vendor init() claims it
            return fakeApp(async () => {
                if (calls === 1) throw new APICodeError('Invalid access token', 401);
                return { uid: 'root', treeEventScopeId: 's' };
            });
        });

        const first = await initRemote().then(
            () => null,
            (e: unknown) => e,
        );
        expect(first).toBeInstanceOf(Error);
        expect(isAuthError(first)).toBe(true);

        await initRemote(); // would throw "already initialised" before the fix
        expect(calls).toBe(2);
        expect(remoteRootUid).toBe('root');
    });
});

describe('401 with the stored session still present', () => {
    function failing(loggedIn: boolean): void {
        _setInitForTest(async () => {
            const app = fakeApp(async () => {
                throw new APICodeError('Invalid access token', 401);
            });
            return { ...app, auth: { isLoggedIn: () => loggedIn } } as unknown as FakeApp;
        });
    }

    test('is a transient refresh failure, not an auth error', async () => {
        failing(true);
        const err = await initRemote().then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(SessionKeptError);
        expect(isAuthError(err)).toBe(false);
    });

    test('with the session gone (refresh refused, signed out) it is an auth error', async () => {
        failing(false);
        const err = await initRemote().then(
            () => null,
            (e: unknown) => e,
        );
        expect(isAuthError(err)).toBe(true);
    });
});
