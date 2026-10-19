import { afterEach, describe, expect, test } from 'bun:test';

import {
    _resetForTest,
    hasDefaultRoute,
    isOffline,
    linkIsDown,
    offlineTimestamp,
    reportNetworkError,
    reportSuccess,
    setOffline,
} from '../src/connectivity';
import { status } from '../src/log';

afterEach(() => _resetForTest());

describe('hasDefaultRoute', () => {
    // /proc/net/route: Iface Destination Gateway Flags ...
    const header = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';

    test('detects a real IPv4 default route', () => {
        const table = `${header}\nwlan0\t00000000\t0100A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0`;
        expect(hasDefaultRoute(table)).toBe(true);
    });

    test('rejects a default route with an all-zero gateway', () => {
        const table = `${header}\neth0\t00000000\t00000000\t0001\t0\t0\t100\t00000000\t0\t0\t0`;
        expect(hasDefaultRoute(table)).toBe(false);
    });

    test('rejects tables with only host routes', () => {
        const table = `${header}\neth0\t0A00A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0`;
        expect(hasDefaultRoute(table)).toBe(false);
    });

    test('detects an IPv6 default route from /proc/net/ipv6_route', () => {
        const z32 = '0'.repeat(32);
        const v6 = `${z32} 00000000 ${z32} 00000000 00000000000000000000000000000001 00000000 00000001 eth0`;
        expect(hasDefaultRoute(`${header}`, v6)).toBe(true);
    });

    test('ignores an IPv6 entry with no next hop', () => {
        const z32 = '0'.repeat(32);
        const v6 = `${z32} 00000000 ${z32} 00000000 ${z32} 00000000 00000000 eth0`;
        expect(hasDefaultRoute(`${header}`, v6)).toBe(false);
    });
});

describe('linkIsDown', () => {
    const routeWithDefault = 'Iface\tDestination\tGateway\neth0\t00000000\t0100A8C0';
    const routeNoDefault = 'Iface\tDestination\tGateway\neth0\t0A00A8C0\t00000000';

    const reader = (files: Record<string, string>) => (p: string): string => {
        if (p in files) return files[p];
        throw new Error(`ENOENT ${p}`);
    };

    test('online when a default route exists (regardless of interfaces)', () => {
        const read = reader({ '/proc/net/route': routeWithDefault, '/proc/net/ipv6_route': '' });
        expect(linkIsDown(read, () => [])).toBe(false);
    });

    test('online when no route but a non-loopback interface has carrier', () => {
        const read = reader({
            '/proc/net/route': routeNoDefault,
            '/proc/net/ipv6_route': '',
            '/sys/class/net/eth0/carrier': '1\n',
        });
        expect(linkIsDown(read, () => ['lo', 'eth0'])).toBe(false);
    });

    test('offline when no route and only loopback has carrier', () => {
        const read = reader({
            '/proc/net/route': routeNoDefault,
            '/proc/net/ipv6_route': '',
            '/sys/class/net/lo/carrier': '1\n',
        });
        expect(linkIsDown(read, () => ['lo'])).toBe(true);
    });

    test('offline when no route and no carrier on a present interface', () => {
        const read = reader({
            '/proc/net/route': routeNoDefault,
            '/proc/net/ipv6_route': '',
            '/sys/class/net/eth0/carrier': '0\n',
        });
        expect(linkIsDown(read, () => ['lo', 'eth0'])).toBe(true);
    });

    test('tolerates a missing IPv6 route table (IPv4-only kernels)', () => {
        const read = reader({
            '/proc/net/route': routeNoDefault,
            // /proc/net/ipv6_route intentionally absent
        });
        expect(linkIsDown(read, () => ['lo'])).toBe(true);
    });

    test('conservative: an unreadable route table is not asserted offline', () => {
        const read = (): string => {
            throw new Error('EAccess');
        };
        expect(linkIsDown(read, () => ['lo'])).toBe(false);
    });
});

describe('connectivity transitions', () => {
    test('setOffline flips the flag, timestamp and status.json fields', () => {
        expect(isOffline()).toBe(false);
        setOffline(true, 'boot');
        expect(isOffline()).toBe(true);
        expect(offlineTimestamp()).not.toBeNull();
        expect(status.offline).toBe(true);
        expect(status.offlineSince).toBe(offlineTimestamp());
        setOffline(false, 'success');
        expect(isOffline()).toBe(false);
        expect(offlineTimestamp()).toBeNull();
        expect(status.offline).toBe(false);
    });

    test('setOffline fires the side effect only on an edge (idempotent)', () => {
        setOffline(true, 'link');
        const first = offlineTimestamp();
        setOffline(true, 'link'); // no edge: timestamp must not move
        expect(offlineTimestamp()).toBe(first);
    });

    test('reportNetworkError only escalates on a real network failure', () => {
        reportNetworkError(new Error('download size mismatch'));
        expect(isOffline()).toBe(false);
        const offline = new Error('nope');
        offline.name = 'OfflineError';
        reportNetworkError(offline);
        expect(isOffline()).toBe(true);
    });

    test('reportSuccess clears an offline state', () => {
        setOffline(true, 'reactive');
        reportSuccess();
        expect(isOffline()).toBe(false);
    });
});
