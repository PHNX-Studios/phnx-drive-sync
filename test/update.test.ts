import { describe, expect, test } from 'bun:test';

import { cmpVersions, hostArch, isNewer, selectArtifact, type ReleaseManifest } from '../src/update';

describe('cmpVersions / isNewer', () => {
    test('compares numerically, not lexically', () => {
        expect(cmpVersions('0.10.0', '0.9.0')).toBe(1);
        expect(cmpVersions('1.0.0', '1.0.0')).toBe(0);
        expect(cmpVersions('0.2.0', '0.2.1')).toBe(-1);
        expect(cmpVersions('v0.3.0', '0.2.9')).toBe(1);
        expect(cmpVersions('1.0', '1.0.0')).toBe(0);
    });

    test('isNewer never treats equal or older as an upgrade', () => {
        expect(isNewer('0.2.1', '0.2.0')).toBe(true);
        expect(isNewer('0.2.0', '0.2.0')).toBe(false);
        expect(isNewer('0.1.9', '0.2.0')).toBe(false);
    });
});

describe('hostArch', () => {
    test('maps node/bun arch names to release arch names', () => {
        expect(hostArch('x64')).toBe('x86_64');
        expect(hostArch('arm64')).toBe('aarch64');
        expect(hostArch('riscv64')).toBe('riscv64');
    });
});

describe('selectArtifact', () => {
    const archManifest: ReleaseManifest = {
        version: '0.2.0',
        min_glibc: '2.17',
        arches: {
            x86_64: { url: 'https://x/x86_64.tar.gz', sha256: 'aa' },
            aarch64: { url: 'https://x/aarch64.tar.gz', sha256: 'bb' },
        },
    };

    test('picks the artifact for the requested architecture', () => {
        expect(selectArtifact(archManifest, 'x86_64')).toEqual({ url: 'https://x/x86_64.tar.gz', sha256: 'aa' });
        expect(selectArtifact(archManifest, 'aarch64')).toEqual({ url: 'https://x/aarch64.tar.gz', sha256: 'bb' });
    });

    test('throws when the manifest has no artifact for the architecture', () => {
        expect(() => selectArtifact(archManifest, 'riscv64')).toThrow(/architecture riscv64/);
    });

    test('falls back to legacy single-arch url/sha256', () => {
        const legacy: ReleaseManifest = { version: '0.2.0', url: 'https://x/only.tar.gz', sha256: 'cc' };
        expect(selectArtifact(legacy, 'aarch64')).toEqual({ url: 'https://x/only.tar.gz', sha256: 'cc' });
    });

    test('never uses a legacy url when an arches map is present but lacks the host arch', () => {
        const mixed = {
            version: '0.2.0',
            arches: { x86_64: { url: 'https://x/x86_64.tar.gz', sha256: 'aa' } },
            url: 'https://x/legacy.tar.gz',
            sha256: 'cc',
        } as ReleaseManifest;
        expect(() => selectArtifact(mixed, 'aarch64')).toThrow(/architecture aarch64/);
    });

    test('throws when neither arches nor legacy fields are usable', () => {
        expect(() => selectArtifact({ version: '0.2.0' } as ReleaseManifest, 'x86_64')).toThrow(/no artifact/);
        expect(() =>
            selectArtifact({ version: '0.2.0', arches: { x86_64: { url: '', sha256: '' } } } as ReleaseManifest, 'x86_64'),
        ).toThrow(/architecture x86_64/);
    });
});
