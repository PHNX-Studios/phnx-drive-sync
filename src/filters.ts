import { existsSync, readFileSync } from 'node:fs';

import { filtersFile } from './config';

let rules: RegExp[] | null = null;

function globToRegExp(pattern: string): RegExp {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                out += '.*';
                i++;
                if (pattern[i + 1] === '/') i++;
            } else {
                out += '[^/]*';
            }
        } else if (c === '?') {
            out += '[^/]';
        } else if ('\\^$.|+()[]{}'.includes(c)) {
            out += '\\' + c;
        } else {
            out += c;
        }
    }
    return new RegExp('^' + out + '$');
}

function parseFilters(): RegExp[] {
    if (!existsSync(filtersFile)) return [];
    const out: RegExp[] = [];
    const content = readFileSync(filtersFile, 'utf8').replace(/^﻿/, '');
    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        let pattern: string;
        if (line.startsWith('- ')) pattern = line.slice(2).trim();
        else if (line.startsWith('-') || line.startsWith('+')) continue;
        else pattern = line;
        pattern = pattern.replace(/^\/+/, '');
        if (!pattern) continue;
        out.push(globToRegExp(pattern));
    }
    return out;
}

export function loadFilters(): void {
    rules = parseFilters();
}

export function isFiltered(rel: string): boolean {
    if (rules === null) loadFilters();
    const rs = rules!;
    if (rs.length === 0) return false;
    const base = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
    for (const r of rs) {
        if (r.test(rel) || r.test(base)) return true;
    }
    return false;
}
