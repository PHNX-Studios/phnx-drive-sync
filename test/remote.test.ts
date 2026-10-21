import { describe, expect, test } from 'bun:test';

import { APICodeError, APIHTTPError } from '@protontech/drive-sdk/internal/apiService/errors';

import { AuthRequiredError, isAuthError, isNetworkError, isNotFound, isOfflineError, OfflineError } from '../src/remote';
import { AccountApiError } from '../vendor/incubating/account/js/src/accountApi';

/** Minimal Error with a chosen `name` (mirrors how the SDK/HTTP stack throws). */
function named(name: string, message = '', extra: { code?: string } = {}): Error {
    const e = new Error(message);
    e.name = name;
    return Object.assign(e, extra);
}

describe('isNetworkError', () => {
    test('matches the SDK transport-error names', () => {
        expect(isNetworkError(named('OfflineError'))).toBe(true);
        expect(isNetworkError(named('NetworkError'))).toBe(true);
        expect(isNetworkError(named('ConnectionError'))).toBe(true);
        expect(isNetworkError(named('FetchError'))).toBe(true);
    });

    test('matches plain TypeError fetch failures (browser/undici wording)', () => {
        expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
        expect(isNetworkError(new TypeError('NetworkError when attempting to fetch resource'))).toBe(true);
        expect(isNetworkError(new TypeError('Load failed'))).toBe(true);
        expect(isNetworkError(new TypeError('some other type error'))).toBe(false);
    });

    test('matches the literal "network error" message', () => {
        expect(isNetworkError(new Error('Network Error'))).toBe(true);
    });

    test('matches transient transport codes on the error and on its cause', () => {
        expect(isNetworkError(named('Error', 'boom', { code: 'ECONNRESET' }))).toBe(true);
        expect(isNetworkError(named('Error', 'boom', { code: 'EPIPE' }))).toBe(true);
        expect(isNetworkError(named('Error', 'boom', { code: 'UND_ERR_SOCKET' }))).toBe(true);
        const wrapped = new Error('outer', { cause: named('Error', 'socket hang up') });
        expect(isNetworkError(wrapped)).toBe(true);
        const coded = new Error('outer', { cause: named('Error', 'x', { code: 'ECONNRESET' }) });
        expect(isNetworkError(coded)).toBe(true);
    });

    test('matches the transient transport message wordings', () => {
        expect(isNetworkError(new Error('socket connection was closed unexpectedly'))).toBe(true);
        expect(isNetworkError(new Error('other side closed'))).toBe(true);
        expect(isNetworkError(new Error('socket hang up'))).toBe(true);
    });

    test('does not match non-errors or ordinary application failures', () => {
        expect(isNetworkError(undefined)).toBe(false);
        expect(isNetworkError('offline')).toBe(false);
        expect(isNetworkError(new Error('download size mismatch: got 1, expected 2'))).toBe(false);
        expect(isNetworkError(new Error('remote walk returned 0 nodes'))).toBe(false);
    });

    test('a 404 is not a network error (isNotFound handles it)', () => {
        const e = named('Error', '404 not found');
        expect(isNotFound(e)).toBe(true);
        expect(isNetworkError(e)).toBe(false);
    });
});

describe('auth vs network precedence', () => {
    test('a 401/403 is an auth error and not classified as network', () => {
        for (const e of [new Error('401 Unauthorized'), new Error('403 Forbidden'), new Error('refresh token expired')]) {
            expect(isAuthError(e)).toBe(true);
            // precedence is enforced by callers checking isAuthError first; the
            // classifier itself must not need to know that.
            expect(isNetworkError(e)).toBe(false);
        }
    });
});

describe('OfflineError', () => {
    test('is tagged and detected', () => {
        const e = new OfflineError('offline: a/b.txt needs internet');
        expect(e.name).toBe('OfflineError');
        expect(isOfflineError(e)).toBe(true);
        // a plain Error wearing the name still classifies (cross-realm safety)
        expect(isOfflineError(named('OfflineError'))).toBe(true);
        expect(isOfflineError(new Error('nope'))).toBe(false);
    });
});

describe('isAuthError structural checks', () => {
    test('SDK and account API errors carrying a 401/403', () => {
        expect(isAuthError(new APICodeError('Invalid access token', 401))).toBe(true);
        expect(isAuthError(new APIHTTPError('denied', 403))).toBe(true);
        expect(isAuthError(new APIHTTPError('Unauthorized', 401))).toBe(true);
        expect(isAuthError(new AccountApiError('nope', { httpCode: 401 }))).toBe(true);
        expect(isAuthError(Object.assign(new Error('x'), { response: { status: 401 } }))).toBe(true);
    });

    test('the status is found through the cause chain', () => {
        const inner = new APIHTTPError('x', 401);
        expect(isAuthError(new Error('wrapper', { cause: new Error('middle', { cause: inner }) }))).toBe(true);
    });

    test('wording alone is enough for the common refusals', () => {
        expect(isAuthError(new Error('Invalid access token'))).toBe(true);
        expect(isAuthError(new Error('invalid refresh token'))).toBe(true);
        expect(isAuthError(new Error('Not logged in'))).toBe(true);
        expect(isAuthError(new AuthRequiredError())).toBe(true);
        expect(isAuthError(Object.assign(new Error('You need to login first'), { name: 'AuthRequiredError' }))).toBe(true);
    });

    test('other statuses and ordinary failures are not auth', () => {
        expect(isAuthError(new APIHTTPError('server on fire', 500))).toBe(false);
        expect(isAuthError(new APICodeError('conflict', 2500))).toBe(false);
        expect(isAuthError(new Error('boom'))).toBe(false);
    });

    test('an unavailable keyring is transient, not a rejected session', () => {
        expect(
            isAuthError(new Error('Failed to load session from secrets (ensure you have secrets available): locked')),
        ).toBe(false);
        expect(isAuthError(new Error('Failed to load session from pass (ensure pass is installed): nope'))).toBe(false);
        expect(isAuthError(new Error('Failed to load session in pass: gpg: decryption failed'))).toBe(false);
        expect(isAuthError(new Error('Failed to save session in pass: nope'))).toBe(false);
    });

    test('the keyring carve-out wins over a structural or cause signal', () => {
        const keyring = new Error('Failed to load session from secrets: locked', { cause: new APIHTTPError('x', 401) });
        expect(isAuthError(keyring)).toBe(false);
        expect(isAuthError(Object.assign(new Error('Failed to load session in pass: x'), { statusCode: 401 }))).toBe(false);
    });
});
