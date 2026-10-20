#!/usr/bin/env bun
/*
 * Collect third-party license notices for the Rust crates compiled into the
 * FUSE sidecar, as a section to append to THIRD_PARTY_LICENSES.txt.
 *
 * Usage:
 *   bun packaging/collect-crate-licenses.mjs <cargo> <Cargo.toml> <target-triple> >> THIRD_PARTY_LICENSES.txt
 *
 * Uses `cargo metadata` resolved for the release target. Build-only crates (e.g.
 * the C compiler driver) are listed too: over-inclusion is harmless, omitting a
 * statically linked crate is a license violation. Every LICENSE, COPYING or
 * NOTICE file of a crate is included, so dual-licensed crates carry both texts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [cargo, manifest, target] = process.argv.slice(2);
if (!cargo || !manifest || !target) {
    console.error('usage: collect-crate-licenses.mjs <cargo> <Cargo.toml> <target-triple>');
    process.exit(64);
}

const meta = JSON.parse(
    execFileSync(
        cargo,
        ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest, '--filter-platform', target],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
);

const own = new Set(meta.workspace_members);
const resolved = new Set(meta.resolve.nodes.map((n) => n.id));
const crates = meta.packages
    .filter((p) => resolved.has(p.id) && !own.has(p.id))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

function licenseFiles(dir) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((n) => /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)/i.test(n))
        .sort()
        .map((n) => [n, readFileSync(join(dir, n), 'utf8')]);
}

const lines = [
    '',
    '',
    'FUSE sidecar (phnx-drive-sync-fuse): Rust crates',
    '================================================',
    '',
    `Crates: ${crates.length} (resolved for ${target})`,
    '',
    'These crates are compiled into the statically linked phnx-drive-sync-fuse',
    'binary (libsqlite3-sys also embeds the SQLite amalgamation, which is in the',
    'public domain). Each retains its own license; the declared SPDX expression and',
    'the license texts shipped with each crate follow.',
    '',
];

for (const p of crates) {
    lines.push('------------------------------------------------------------------------');
    lines.push(`${p.name}@${p.version}`);
    lines.push(`License: ${p.license ?? (p.license_file ? `see ${p.license_file}` : 'UNKNOWN')}`);
    if (p.repository) lines.push(`Repository: ${p.repository}`);
    lines.push('');
    const dir = dirname(p.manifest_path);
    const files = licenseFiles(dir);
    if (p.license_file && existsSync(join(dir, p.license_file)) && !files.some(([n]) => n === p.license_file)) {
        files.push([p.license_file, readFileSync(join(dir, p.license_file), 'utf8')]);
    }
    if (files.length === 0) lines.push('(No license file was found in the crate directory.)');
    for (const [name, text] of files) {
        lines.push(`[${name}]`);
        lines.push(text.trimEnd());
        lines.push('');
    }
}

process.stdout.write(lines.join('\n') + '\n');
console.error(`collect-crate-licenses: ${crates.length} crates`);
