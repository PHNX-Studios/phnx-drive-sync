import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { release as osRelease, tmpdir } from 'node:os';
import path from 'node:path';

import { VERSION } from './version';
import { envAlias } from './config';

/**
 * Self-update: fetch a small release manifest, compare versions, verify the
 * tarball's sha256, then hand off to the shipped `install.sh --force` (which
 * performs the guarded upgrade and restarts the units).
 *
 * The manifest is fetched and verified inside the engine binary itself, so an
 * old host does not depend on a modern `curl`/`wget` or an up-to-date CA store
 * beyond what Bun already provides.
 *
 * `PHNX_DRIVE_SYNC_RELEASE_URL` (or the legacy `DRIVE_SYNC_RELEASE_URL`)
 * overrides the manifest location; `--url <url>` too.
 */
const DEFAULT_MANIFEST_URL =
    envAlias('RELEASE_URL') ??
    'https://github.com/PHNX-Studios/phnx-drive-sync/releases/latest/download/latest.json';

export interface ReleaseArtifact {
    url: string;
    sha256: string;
}

export interface ReleaseManifest {
    version: string;
    /** Per-arch artifacts, keyed by our arch names (`x86_64`, `aarch64`). */
    arches?: Record<string, ReleaseArtifact>;
    /** Legacy single-arch fields, used when `arches` is absent. */
    url?: string;
    sha256?: string;
    /** Host floors; `update` refuses to install a release the host cannot run. */
    min_glibc?: string;
    min_kernel?: string;
    min_python?: string;
}

/** Release arch key for the running binary (`x64` -> `x86_64`, `arm64` -> `aarch64`). */
export function hostArch(arch: string = process.arch): string {
    if (arch === 'x64') return 'x86_64';
    if (arch === 'arm64') return 'aarch64';
    return arch;
}

/**
 * Pick the download for `arch` from a manifest. Prefers the per-arch `arches`
 * map; falls back to the legacy top-level `url`/`sha256` for single-arch
 * manifests. Throws when the manifest has no artifact for this architecture.
 */
export function selectArtifact(m: ReleaseManifest, arch: string = hostArch()): ReleaseArtifact {
    if (m.arches) {
        const a = m.arches[arch];
        if (a?.url && a?.sha256) return a;
        // Never fall back to a legacy single-arch url here: it may be a
        // different architecture, which would install the wrong binary.
        throw new Error(`no release artifact for architecture ${arch}`);
    }
    if (m.url && m.sha256) return { url: m.url, sha256: m.sha256 };
    throw new Error('release manifest has no artifact url/sha256');
}

/** Compare dotted versions numerically. Returns -1, 0 or 1. */
export function cmpVersions(a: string, b: string): number {
    const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

/** True when `remote` is strictly newer than `local` (never a downgrade). */
export function isNewer(remote: string, local: string): boolean {
    return cmpVersions(remote, local) > 0;
}

function runCapture(cmd: string, args: string[]): string {
    try {
        const r = spawnSync(cmd, args, { encoding: 'utf8' });
        return `${r.stdout ?? ''}${r.stderr ?? ''}`;
    } catch {
        return '';
    }
}

function glibcVersion(): string | null {
    const m = runCapture('ldd', ['--version']).match(/GLIBC\s+(\d+\.\d+)/i);
    return m ? m[1] : null;
}

function kernelVersion(): string {
    return osRelease().replace(/^(\d+\.\d+).*/, '$1');
}

function pythonVersion(): string | null {
    const m = runCapture('python3', ['--version']).match(/Python\s+(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
}

/** Human-readable reasons the host cannot run the manifest's release. */
function hostBlockers(m: ReleaseManifest): string[] {
    const out: string[] = [];
    if (m.min_glibc) {
        const g = glibcVersion();
        if (g && cmpVersions(g, m.min_glibc) < 0) out.push(`glibc ${g} < required ${m.min_glibc}`);
    }
    if (m.min_kernel) {
        out.push(...(cmpVersions(kernelVersion(), m.min_kernel) < 0 ? [`kernel ${kernelVersion()} < required ${m.min_kernel}`] : []));
    }
    if (m.min_python) {
        const p = pythonVersion();
        if (p && cmpVersions(p, m.min_python) < 0) out.push(`python3 ${p} < required ${m.min_python}`);
    }
    return out;
}

async function download(url: string, dest: string): Promise<void> {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    // stream to disk (a release tarball must not be buffered wholesale in RAM)
    await Bun.write(dest, res);
}

function sha256File(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function findInstaller(root: string): string | null {
    const direct = path.join(root, 'install.sh');
    if (existsSync(direct)) return direct;
    for (const name of readdirSync(root)) {
        const nested = path.join(root, name, 'install.sh');
        if (existsSync(nested)) return nested;
    }
    return null;
}

/**
 * Entry point for `phnx-drive-sync update`.
 * Exit codes: 0 up to date / installed, 1 failure, 2 no newer release with --check.
 */
export async function runUpdate(args: string[]): Promise<number> {
    const checkOnly = args.includes('--check');
    const force = args.includes('--force');
    let manifestUrl = DEFAULT_MANIFEST_URL;
    const urlIdx = args.indexOf('--url');
    if (urlIdx !== -1) {
        const v = args[urlIdx + 1];
        if (!v || v.startsWith('--')) {
            console.error('update: --url requires a manifest URL');
            return 1;
        }
        manifestUrl = v;
    }

    console.log(`phnx-drive-sync ${VERSION}`);

    let manifest: ReleaseManifest;
    try {
        const res = await fetch(manifestUrl, {
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000),
            headers: { accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        manifest = (await res.json()) as ReleaseManifest;
    } catch (e) {
        console.error(`update: could not fetch release manifest (${manifestUrl}): ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    if (!manifest.version) {
        console.error('update: release manifest is missing version');
        return 1;
    }

    const hasNewer = isNewer(manifest.version, VERSION);
    console.log(`latest:  ${manifest.version}`);
    if (!force && !hasNewer) {
        console.log(`up to date (${VERSION} is the newest release)`);
        return 0;
    }
    console.log(`update available: ${VERSION} -> ${manifest.version}`);
    if (checkOnly) return hasNewer ? 2 : 0;

    const blockers = hostBlockers(manifest);
    if (blockers.length > 0) {
        console.error(`update: ${manifest.version} is not supported on this host:`);
        for (const b of blockers) console.error(`  - ${b}`);
        console.error('update: staying on the installed version.');
        return 1;
    }

    let artifact: ReleaseArtifact;
    try {
        artifact = selectArtifact(manifest);
    } catch (e) {
        console.error(`update: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }

    const work = path.join(tmpdir(), `phnx-drive-sync-update-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    const tarball = path.join(work, 'release.tar.gz');
    try {
        console.log(`downloading ${artifact.url}`);
        await download(artifact.url, tarball);
        const got = sha256File(tarball);
        if (got.toLowerCase() !== artifact.sha256.toLowerCase()) {
            console.error(`update: sha256 mismatch (expected ${artifact.sha256}, got ${got}); aborting`);
            return 1;
        }
        console.log('sha256 verified; extracting...');
        if (spawnSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'inherit' }).status !== 0) {
            console.error('update: extraction failed');
            return 1;
        }
        const installer = findInstaller(work);
        if (!installer) {
            console.error('update: no install.sh found in the release archive');
            return 1;
        }
        console.log('running installer...');
        return spawnSync('bash', [installer, '--force'], { stdio: 'inherit', env: process.env }).status ?? 1;
    } finally {
        try {
            rmSync(work, { recursive: true, force: true });
        } catch {
            /* best-effort cleanup */
        }
    }
}
