import { readdirSync, statSync, type Dirent } from 'node:fs';

import { isPartial, treeRoot } from './config';
import type { EntryPresence, EntrySync, ListEntry } from './rpc';
import { fileEq, steady } from './sync';
import * as st from './state';

/** Absolute path in the real tree for a rel path ('' is the tree root). */
export function absOf(rel: string): string {
    return rel === '' ? treeRoot : `${treeRoot}/${rel}`;
}

export function baseName(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
}

/**
 * Per-entry sync status for one directory (the GUI's file browser), read-only.
 *
 * Mirrors the FUSE sidecar's readdir: tree children (materialized) plus `online`
 * markers (placeholders) directly under `relDir`, hiding the gvfs trash dirs and
 * the same engine-internal files the sidecar hides. Each entry carries the facts
 * the engine alone owns: `presence` (bytes on disk or remote-only), `sync`
 * (clean/dirty/unsynced relative to the baseline) and the keep-mark.
 *
 * `relDir` is '' for the sync root. Empty on any unreadable directory.
 */
export function listDirStatus(relDir: string): ListEntry[] {
    const rows = st.syncAll();
    const online = st.onlineAll();
    const pinned = new Set(st.pinnedAll());
    const prefix = relDir === '' ? '' : relDir + '/';
    const out: ListEntry[] = [];
    const seen = new Set<string>();

    const build = (rel: string, type: 'file' | 'dir', size: number | null, mtime: number | null, presence: EntryPresence): ListEntry => {
        let sync: EntrySync = 'n/a';
        if (type === 'file') {
            const row = rows.get(rel);
            if (!row || row.lsize === null || row.lmtime === null || row.rsize === null || row.rmtime === null) {
                sync = 'unsynced';
            } else if (presence === 'online') {
                sync = steady(row) ? 'clean' : 'dirty';
            } else {
                const ok = size !== null && mtime !== null && fileEq(size, mtime, row.lsize, row.lmtime);
                sync = steady(row) && ok ? 'clean' : 'dirty';
            }
        }
        return { path: rel, name: baseName(rel), type, presence, sync, pinned: pinned.has(rel), size, mtime };
    };

    let dirents: Dirent[] = [];
    try {
        dirents = readdirSync(absOf(relDir), { withFileTypes: true });
    } catch {
        dirents = [];
    }
    for (const d of dirents) {
        const name = d.name;
        if (name === '.protonignore' || isPartial(name)) continue;
        if (name === '.Trash' || name.startsWith('.Trash-')) continue; // gvfs trash: passthrough but hidden (sidecar parity)
        if (d.isSymbolicLink()) continue;
        const rel = prefix + name;
        if (d.isDirectory()) {
            out.push(build(rel, 'dir', null, null, 'local'));
            seen.add(rel);
        } else if (d.isFile()) {
            let size: number | null = null;
            let mtime: number | null = null;
            try {
                const s = statSync(absOf(rel));
                size = s.size;
                mtime = s.mtimeMs;
            } catch {
                /* vanished between readdir and stat: report what we know */
            }
            out.push(build(rel, 'file', size, mtime, 'local'));
            seen.add(rel);
        }
    }

    // placeholders: files whose bytes are absent locally (online markers) but whose
    // baseline row still carries their facts; only direct children of relDir
    for (const [rel, row] of rows) {
        if (row.type !== 'file' || seen.has(rel) || !online.has(rel)) continue;
        if (!rel.startsWith(prefix)) continue;
        const rest = rel.slice(prefix.length);
        if (rest === '' || rest.includes('/')) continue;
        out.push(build(rel, 'file', row.rsize, row.rmtime, 'online'));
        seen.add(rel);
    }

    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return out;
}
