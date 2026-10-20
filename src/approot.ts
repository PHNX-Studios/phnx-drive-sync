import { existsSync } from 'node:fs';
import path from 'node:path';

import { envAlias } from './config';

/**
 * Root directory of the shipped application resources (`assets/`, `tray/`,
 * `gui/`). It differs between a dev checkout and an installed, compiled build:
 *
 * - compiled single-file binary (`bun build --compile`): `process.execPath` is
 *   `<libdir>/phnx-drive-sync-engine` and `import.meta.dir` is the virtual
 *   `/$bunfs/root`, so the executable's own directory is the anchor.
 * - `bun run src/index.ts` from a checkout: `process.execPath` is the bun
 *   binary, so fall back to the source-tree root (one level above `src/`).
 * - `PHNX_DRIVE_SYNC_LIBDIR` (or the legacy `DRIVE_SYNC_LIBDIR`) overrides both
 *   (used by the installer and tests).
 *
 * The discriminating marker is `assets/emblem-cloud.svg`, which exists in both
 * the checkout root and the installed libdir, but not next to the bun interpreter.
 */
function findAppRoot(): string {
    const candidates = [
        envAlias('LIBDIR'),
        path.dirname(process.execPath),
        path.resolve(import.meta.dir, '..'),
        import.meta.dir,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    for (const dir of candidates) {
        if (existsSync(path.join(dir, 'assets', 'emblem-cloud.svg'))) return dir;
    }
    return path.dirname(process.execPath);
}

export const appRoot = findAppRoot();

const SIDECAR_BIN = 'phnx-drive-sync-fuse';

/**
 * The FUSE sidecar binary the engine spawns: next to the engine in an installed
 * libdir, else the cargo build output of a checkout (release, then debug).
 * Falls back to the libdir path so a missing binary is reported where it belongs.
 */
function findSidecar(): string {
    const installed = path.join(appRoot, SIDECAR_BIN);
    const candidates = [
        installed,
        path.join(appRoot, 'sidecar', 'target', 'release', SIDECAR_BIN),
        path.join(appRoot, 'sidecar', 'target', 'debug', SIDECAR_BIN),
    ];
    return candidates.find((p) => existsSync(p)) ?? installed;
}

export const sidecarPath = findSidecar();

/** Custom Nautilus cloud badge the engine installs into the user icon theme. */
export const emblemAssetPath = path.join(appRoot, 'assets', 'emblem-cloud.svg');
