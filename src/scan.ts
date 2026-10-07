import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { isPartial, treeRoot } from './config';
import { isFiltered } from './filters';
import { log } from './log';

export interface LocalNode {
    dir: boolean;
    size: number;
    mtimeMs: number;
}

export async function walkLocal(): Promise<Map<string, LocalNode>> {
    const out = new Map<string, LocalNode>();
    await walk(treeRoot, '');
    return out;

    async function walk(abs: string, rel: string): Promise<void> {
        let dirents;
        try {
            dirents = await readdir(abs, { withFileTypes: true });
        } catch (e) {
            log('WARN', `cannot read local dir ${abs}`, e);
            return;
        }
        for (const d of dirents) {
            if (d.isSymbolicLink()) continue;
            const childRel = rel === '' ? d.name : `${rel}/${d.name}`;
            if (childRel === '.protonignore') continue;
            if (isFiltered(childRel)) continue;
            const childAbs = path.join(abs, d.name);
            if (d.isDirectory()) {
                out.set(childRel, { dir: true, size: 0, mtimeMs: 0 });
                await walk(childAbs, childRel);
            } else if (d.isFile()) {
                if (isPartial(childRel)) continue;
                try {
                    const st = await stat(childAbs);
                    out.set(childRel, { dir: false, size: st.size, mtimeMs: st.mtimeMs });
                } catch (e) {
                    log('WARN', `cannot stat local file ${childRel}`, e);
                }
            }
        }
    }
}
