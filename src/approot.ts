import { existsSync } from 'node:fs';
import path from 'node:path';

import { envAlias } from './config';

/**
 * Root directory of the shipped application resources (`python/`, `assets/`,
 * `tray/`). It differs between a dev checkout and an installed, compiled build:
 *
 * - compiled single-file binary (`bun build --compile`): `process.execPath` is
 *   `<libdir>/phnx-drive-sync-engine` and `import.meta.dir` is the virtual
 *   `/$bunfs/root`, so the executable's own directory is the anchor.
 * - `bun run src/index.ts` from a checkout: `process.execPath` is the bun
 *   binary, so fall back to the source-tree root (one level above `src/`).
 * - `PHNX_DRIVE_SYNC_LIBDIR` (or the legacy `DRIVE_SYNC_LIBDIR`) overrides both
 *   (used by the installer and tests).
 *
 * The discriminating marker is `python/sidecar.py`, which exists in both the
 * checkout root and the installed libdir, but not next to the bun interpreter.
 */
function findAppRoot(): string {
    const candidates = [
        envAlias('LIBDIR'),
        path.dirname(process.execPath),
        path.resolve(import.meta.dir, '..'),
        import.meta.dir,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    for (const dir of candidates) {
        if (existsSync(path.join(dir, 'python', 'sidecar.py'))) return dir;
    }
    return path.dirname(process.execPath);
}

export const appRoot = findAppRoot();

/** The FUSE sidecar script the engine spawns. */
export const sidecarPath = path.join(appRoot, 'python', 'sidecar.py');

/** Custom Nautilus cloud badge the engine installs into the user icon theme. */
export const emblemAssetPath = path.join(appRoot, 'assets', 'emblem-cloud.svg');
