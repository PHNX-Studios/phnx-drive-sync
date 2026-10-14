#!/usr/bin/env bun
/*
 * Merge the per-arch release manifest fragments emitted by packaging/build.sh
 * (dist/latest-<arch>.json) into one arch-aware latest.json:
 *
 *   {
 *     "version": "0.2.0",
 *     "min_glibc": "2.17", "min_kernel": "3.10", "min_python": "3.8",
 *     "arches": { "x86_64": { "url": "...", "sha256": "..." },
 *                 "aarch64": { "url": "...", "sha256": "..." } }
 *   }
 *
 * Usage: bun packaging/merge-manifests.mjs <output.json> <fragment.json>...
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
    console.error('usage: merge-manifests.mjs <output.json> <fragment.json>...');
    process.exit(2);
}

const meta = {};
const arches = {};
let seenVersion = null;

for (const file of inputs) {
    let m;
    try {
        m = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        console.error(`merge-manifests: could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
    if (!m.version || !m.arch || !m.url || !m.sha256) {
        console.error(`merge-manifests: ${file} is missing version/arch/url/sha256`);
        process.exit(1);
    }
    if (seenVersion && seenVersion !== m.version) {
        console.error(`merge-manifests: version mismatch (${seenVersion} vs ${m.version} in ${file})`);
        process.exit(1);
    }
    seenVersion = m.version;
    if (arches[m.arch]) {
        console.error(`merge-manifests: duplicate architecture ${m.arch} (${file})`);
        process.exit(1);
    }
    arches[m.arch] = { url: m.url, sha256: m.sha256 };
    for (const k of ['min_glibc', 'min_kernel', 'min_python']) {
        if (!m[k]) continue;
        if (meta[k] && meta[k] !== m[k]) {
            console.error(`merge-manifests: conflicting ${k} (${meta[k]} vs ${m[k]} in ${file})`);
            process.exit(1);
        }
        meta[k] = m[k];
    }
}

const ordered = {
    version: seenVersion,
    ...(meta.min_glibc ? { min_glibc: meta.min_glibc } : {}),
    ...(meta.min_kernel ? { min_kernel: meta.min_kernel } : {}),
    ...(meta.min_python ? { min_python: meta.min_python } : {}),
    arches,
};

writeFileSync(out, `${JSON.stringify(ordered, null, 2)}\n`);
console.error(`merge-manifests: wrote ${out} (${Object.keys(arches).join(', ')})`);
