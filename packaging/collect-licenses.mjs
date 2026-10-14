#!/usr/bin/env bun
/*
 * Collect third-party license notices for the packages that are present in the
 * vendored dependency tree and can be embedded into the compiled binaries.
 *
 * Usage:
 *   bun packaging/collect-licenses.mjs <output-file> [root ...]
 *
 * Defaults to walking vendor/cli/node_modules. Over-inclusion is intentional:
 * shipping an attribution for a package that is not ultimately bundled is
 * harmless, while omitting one that is bundled is a license violation.
 */
import {
    existsSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const outPath = process.argv[2] ?? 'THIRD_PARTY_LICENSES.txt';
const roots = process.argv.slice(3);
if (roots.length === 0) roots.push('vendor/cli/node_modules');

const LICENSE_NAMES = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENSE-MIT',
    'LICENSE.BSD',
    'LICENCE',
    'LICENCE.md',
    'license',
    'licence',
    'COPYING',
    'COPYING.md',
    'NOTICE',
];

const seenReal = new Set();
const packages = new Map();

function readPackage(dir) {
    const pj = join(dir, 'package.json');
    if (!existsSync(pj)) return null;
    try {
        const p = JSON.parse(readFileSync(pj, 'utf8'));
        if (!p.name || !p.version) return null;
        return p;
    } catch {
        return null;
    }
}

function licenseId(p) {
    const l = p.license ?? p.licenses;
    if (!l) return 'UNKNOWN (see license file)';
    if (typeof l === 'string') return l;
    if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type ?? 'UNKNOWN')).join(', ');
    return l.type ?? 'UNKNOWN (see license file)';
}

function repositoryOf(p) {
    const r = p.repository;
    if (!r) return null;
    if (typeof r === 'string') return r;
    return r.url ?? null;
}

function licenseText(dir) {
    for (const name of LICENSE_NAMES) {
        const f = join(dir, name);
        try {
            if (existsSync(f) && statSync(f).isFile()) {
                return [name, readFileSync(f, 'utf8')];
            }
        } catch {
            /* ignore unreadable */
        }
    }
    return null;
}

function walk(dir, depth) {
    if (depth > 15) return;
    let real;
    try {
        real = realpathSync(dir);
    } catch {
        return;
    }
    if (seenReal.has(real)) return; // guard against symlink cycles
    seenReal.add(real);

    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    const p = readPackage(dir);
    if (p) {
        const key = `${p.name}@${p.version}`;
        if (!packages.has(key)) packages.set(key, { p, dir, file: licenseText(dir) });
    }

    for (const e of entries) {
        if (e.name === '.bin' || e.name === '.cache') continue;
        const full = join(dir, e.name);
        let isDir = e.isDirectory();
        if (!isDir && e.isSymbolicLink()) {
            try {
                isDir = statSync(full).isDirectory();
            } catch {
                isDir = false;
            }
        }
        if (isDir) walk(full, depth + 1);
    }
}

for (const root of roots) {
    if (existsSync(root)) walk(root, 0);
}

const sorted = [...packages.values()].sort((a, b) =>
    `${a.p.name}@${a.p.version}`.localeCompare(`${b.p.name}@${b.p.version}`),
);

const lines = [
    'Third-Party License Notices',
    '===========================',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Packages:  ${sorted.length}`,
    '',
    'These packages are present in the vendored dependency tree and may be bundled',
    'into the compiled phnx-drive-sync binaries. Each retains its own license; the',
    'declared identifier and, where available, the license text follow.',
    '',
];

for (const { p, file } of sorted) {
    lines.push('------------------------------------------------------------------------');
    lines.push(`${p.name}@${p.version}`);
    lines.push(`License: ${licenseId(p)}`);
    const repo = repositoryOf(p);
    if (repo) lines.push(`Repository: ${repo}`);
    lines.push('');
    if (file) {
        lines.push(`[${file[0]}]`);
        lines.push(file[1].trimEnd());
    } else {
        lines.push('(No license file was found in the package directory.)');
    }
    lines.push('');
}

writeFileSync(outPath, lines.join('\n'));
console.error(`collect-licenses: wrote ${outPath} (${sorted.length} packages)`);
