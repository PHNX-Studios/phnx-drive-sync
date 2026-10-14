# PHNX Drive Sync

Bidirectional sync engine between `~/Proton Drive` and Proton Drive (`/my-files`),
built directly on the official [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk)
(vendored in `vendor/`).

> **Unofficial third-party application.** PHNX Drive Sync is an independent
> project. It is **not** affiliated with, endorsed by, or supported by Proton AG.
> "Proton" and "Proton Drive" are trademarks of Proton AG, used here only to
> describe interoperability. Proton requires third-party clients to identify
> themselves honestly and not masquerade as first-party software; this
> application sends an `x-pm-appversion` header of the form
> `external-drive-phnx_drive_sync@<version>` and talks only to official endpoints.

Requires: [bun](https://bun.sh) and an authenticated session via the official
`proton-drive` CLI (`proton-drive` re-login if the session expires).

## Install

Download the release tarball for your architecture from the
[releases page](https://github.com/PHNX-Studios/phnx-drive-sync/releases), then
run its installer. It
is self-contained: the engine and the official login CLI are compiled to single
binaries (Bun runtime + all dependencies embedded, glibc 2.17+), and the
installer wires up systemd user units, autostart, icons and the Nautilus
context menu. Everything lands under `~/.local`; the only elevated step is
installing a small set of host packages (fuse3, python3, GTK/AppIndicator,
inotify-tools, gvfs, libnotify, gnome-keyring) via your package manager. When it
cannot elevate (no sudo, an unknown distro, or `--no-system-deps`), the two host
pieces that matter most are fetched into `~/.local` without root: `inotify-tools`
(the fast file watcher) and the Ayatana AppIndicator typelib (the tray icon).
Everything else degrades gracefully on its own.

Installation ends with a **FUSE readiness report**. Files-on-demand needs the
system FUSE stack (`/dev/fuse`, the setuid `fusermount3`, `libfuse3`/`pyfuse3`),
and `fusermount3` cannot be provided without root, so that part is only set up on
the elevated path. If it is missing, the installer says exactly what to install;
the engine still performs full bidirectional sync, but `~/Proton Drive` stays
empty (the tray shows "Mount degraded").

```sh
tar xzf phnx-drive-sync-<version>-linux-<arch>.tar.gz
cd phnx-drive-sync-<version>-linux-<arch>
./install.sh                 # detects the distro, installs host deps, wires everything
phnx-drive-sync login      # the only manual step: sign in to Proton Drive
```

Installer flags: `--no-system-deps` (skip the elevated package-manager step; the
user-level fallback still runs), `--no-deps` (install no dependencies at all),
`--enable-autoupdate` / `--disable-autoupdate` (weekly `phnx-drive-sync update`
via a systemd user timer), and `--force` (reinstall the same version).

Upgrades are handled by re-running a newer tarball's installer: it refuses to
downgrade, no-ops on the same version, and preserves all state under
`~/.local/share/drive-sync` and `~/.local/state/drive-sync`.

`phnx-drive-sync update` trusts the configured release host over TLS and
verifies the tarball's SHA-256 from the release manifest before running the
installer (as the ordinary user). The manifest is arch-aware: it carries an
entry per architecture (`x86_64`, `aarch64`) and the updater picks the one
matching the running binary. It refuses releases whose `min_glibc`/
`min_kernel`/`min_python` exceed the host, so an old machine is never handed a
binary it cannot run. Point it at a mirror with `DRIVE_SYNC_RELEASE_URL` or
`update --url <manifest>`.

## Usage

Once installed the `phnx-drive-sync` command is on `~/.local/bin` (from a dev
checkout use `bun run src/index.ts <cmd>` or `./phnx-drive-sync.sh <cmd>`):

```sh
phnx-drive-sync run            # daemon: initial full pass, then events + watcher + interval
phnx-drive-sync once           # single full pass (exit 0 ok, 2 errors, 3 auth)
phnx-drive-sync once --dry-run # classify only: report planned actions, change nothing
phnx-drive-sync status         # print status.json
phnx-drive-sync unpin <paths…> # free local space; files stay on Proton Drive
phnx-drive-sync pin <paths…>   # download online-only files back to this device
phnx-drive-sync evict [paths…] # bulk "Free up space": no paths = every local file
phnx-drive-sync prefetch on|off|status  # recall-on-hover toggle (default off)
phnx-drive-sync login          # sign in to Proton Drive (bundled official CLI)
phnx-drive-sync restart        # systemctl --user restart + wait for the FUSE mount
phnx-drive-sync update [--check]  # install a newer release, if one is available
phnx-drive-sync version        # print the version
```

`pin`/`unpin`/`evict` talk to the running daemon over a unix socket (`rpc.sock`),
so the daemon must be up (exit 1 otherwise). Directories are expanded
recursively over their files (folders themselves always stay on disk).
`unpin`/`evict` refuse to free bytes that are not synced yet — they run/await a
sync pass first and re-check; exit 2 means some paths failed (per-path detail on
stdout/stderr).

systemd (user): the installer enables and starts the units. To drive them by hand:

```sh
systemctl --user status phnx-drive-sync.service phnx-drive-sync-tray.service
systemctl --user restart phnx-drive-sync.service
journalctl --user -u phnx-drive-sync.service -f
```

The installer deploys the compiled runtime to `~/.local/lib/phnx-drive-sync/`
on the **internal disk** and points the systemd user units and XDG autostart
there — startup never waits on an external drive (state the engine manages
already lives under `~/.local`). Upgrades reuse the same installer.

Auto-start: the service is `enabled`, so it starts at login; the tray is
autostarted via `~/.config/autostart/phnx-drive-sync-tray.desktop` and also via `phnx-drive-sync-tray.service` user unit for resilience. If the engine
ever needs a manual kick, **PHNX Drive Sync (restart engine)** in the application
menu (and on the Desktop) runs `phnx-drive-sync restart` — restarts the service,
waits for the FUSE heartbeat to come back, and reports the result via
`notify-send`. If the sidecar dies while the engine runs, the engine relaunches
it automatically within seconds (see `mount` in `status.json`); the tray's
**Sync now** also heals a degraded mount by restarting the unit.

Tray icon (live status, storage, controls — autostarted):

```sh
tray/phnx-drive-sync-tray.py   # 2x2 status grid, Actions submenu, Pause/Resume
```

The menu shows a 2x2 status grid (sync status | storage, online-only |
reclaimable) followed by an **Actions** submenu (Sync now, Open folder, Show
last log, Free up space) and Pause/Resume + Quit. While a pass runs the status
cell tracks the current item and its `(done/total)` progress.

- **Sync now** sends the daemon `SIGUSR1` (runs an immediate incremental pass,
  ~0.5 s) or starts the unit if paused.
- **Pause/Resume** stops/starts `phnx-drive-sync.service`.
- **Free up space (all local files)** appears whenever there is reclaimable
  space and runs the same bulk evict as `phnx-drive-sync.sh evict` (keep-marked and
  unsynced files stay local).
- Icon states: idle (green), syncing (orange, incl. long full walks), error
  (red: service failed / auth required / last pass errored), paused (grey).

## How a pass works

1. **Event catch-up** — drains tree events since the stored id so the SDK's
   internal node cache reflects external renames/deletes; first run (no id yet)
   purges caches instead so the initial hydration is fresh.
2. **Scan** — local filesystem walk (filters applied, filtered dirs pruned) and
   remote walk (full every Nth pass, cached view in between, refreshed by events).
3. **Classify** — three-way diff against the baseline (`sync` table: last-synced
   facts for both sides). On the very first pass, matching size+mtime pairs are
   silently adopted as baseline (no conflict, no upload).
4. **Execute** — phases in order: mkdir local → mkdir remote → rename local →
   rename remote → download/upload/conflict → local deletes → remote trash.

Change detection: size equal and mtime within 1.5 s = unchanged. Rename pairing
only fires against a steady baseline with a unique size+mtime candidate, so a
bootstrap pass never invents renames.

## Conflict policy

Both sides changed since baseline → **local wins**: local content is uploaded
(new revision), remote content is preserved as
`name (conflict YYYYMMDD-HHMMSS).ext` locally *and* uploaded as a new remote
file. Nothing is ever silently overwritten or dropped.

Deletions mirror both ways (remote deletions land in Proton's trash, so they
are recoverable there).

## Files on demand (selective sync)

`~/Proton Drive` is a FUSE mount (pyfuse3 sidecar) over the real tree at
`~/.local/share/drive-sync/tree`. Every synced path is always visible with its
real size; online-only files cost no disk (`du` ≈ 0, `blocks=0`). Reads never
see zero-fill: reading a placeholder blocks, downloads the content from the
baseline (byte-identical) and materializes the file — OneDrive recall
semantics. Writes to a placeholder materialize first, then write.

- `phnx-drive-sync.sh unpin 'path/…'` — after ensuring the latest local bytes are
  synced, marks the file online-only and drops the local bytes. It stays
  visible through the mount; the next open/recall re-downloads it.
- `phnx-drive-sync.sh pin 'path/…'` — recall explicitly (download + clear the mark),
  byte-identical from the baseline (uid/size/mtime). `pin` also sets a
  **keep-on-this-device** mark: auto-eviction and bulk free will never touch
  that file until an `unpin` (or a free-up-space) clears the mark — last
  explicit instruction wins.
- `phnx-drive-sync.sh evict [path/…]` — bulk *Free up space* (no paths = every
  materialized file). Only clean, synced, non-keep-marked files are freed,
  largest first; unsynced edits and keep-marked files stay local. The same
  action is available from the tray menu.
- Renames/moves of placeholders are metadata-only (remote move included).
- Nautilus/gio trash: a placeholder is trashed remotely; a materialized file
  moves into the local `.Trash-<uid>` (never synced) and is trashed remotely
  on the next pass.

**Recall on hover (prefetch, default off).** With `phnx-drive-sync.sh prefetch on`,
any lookup of a placeholder through the mount (hover, preview, directory stat)
queues a background download instead of waiting for the first open; two
downloads run in parallel, the rest queue. `prefetch off` (the default)
recalls only on open. The override lives in `state.db` (`prefetch` meta key);
without it the sidecar falls back to `DRIVE_SYNC_PREFETCH` (env default).

**Auto-evict on low disk (default off).** With `DRIVE_SYNC_EVICT_FREE_GB=<n>`
set (e.g. in the systemd unit), every pass checks the free space of the
filesystem holding the real tree; below the threshold the largest clean,
non-keep-marked local files are evicted until the threshold clears, and a
`notify-send` report says what was freed.

**New remote files.** `DRIVE_SYNC_NEW_FILES=online` makes files that first
appear remotely materialize as placeholders instead of downloading (folders
still materialize). Default `local` = download, as before.

**Nautilus badges (cloud vs green check).** Every synced file carries a badge via
the gvfs metadata store (`metadata::emblems` keyword → `emblem-<keyword>`
icon): online-only placeholders show a **cloud**, materialized files a
**green check** (`emblem-default`, OneDrive-style "kept on this device";
Yaru's `emblem-favorite` heart reads as "liked", not "synced") — the badge
tracks bytes-on-disk only (keep-marked files get the check too). Folders get
none. The engine applies the diff after every pass and after
pin/unpin/evict/hydrate RPCs (concurrency 8), remembering the last applied
badge per path in `state.db` so restarts and no-op passes spawn nothing;
`DRIVE_SYNC_EMBLEMS=off` disables it entirely. Since Yaru ships no cloud
emblem, a custom `emblem-cloud.svg` is installed into
`~/.local/share/icons/hicolor/scalable/emblems/` on first sync (stale theme
cache invalidated alongside). Nautilus re-reads metadata only on F5 /
re-entering the folder — badges appear after a refresh, not live. Failure
modes degrade quietly: `gio` missing → logged once, badges skipped; mount
down → missing paths deferred until the next pass.

Sidecar requirements: `python3`, `fusermount3`/`libfuse3`, and `pyfuse3`,
`trio`, `cffi` importable with `PYTHONPATH=~/.local/share/drive-sync/python`.
`./install.sh` installs these for you (distro packages where available, falling
back to `pip install --target ~/.local/share/drive-sync/python`). The engine
probes the import at startup; if it fails the engine still runs — the mount
point stays empty and the tray shows "Mount degraded".

Nautilus context menu (multi-select supported): `./install.sh` installs the
scripts into `~/.local/share/nautilus/scripts/`. From a dev checkout:

```sh
mkdir -p ~/.local/share/nautilus/scripts
cp -r "tray/nautilus-scripts/Proton Drive" ~/.local/share/nautilus/scripts/
```

Then in Nautilus: right-click → *Scripts* → *Proton Drive* → **Free up Space**
or **Keep on This Device**; the result comes back as a `notify-send`
notification. Filenames containing newlines are not supported by Nautilus'
script environment.

## Filters

`~/Proton Drive/.protonignore` — gitignore-style globs, one per line,
`- pattern` = exclude (bare patterns also exclude; `+` lines ignored). Matched
against full path and basename; filtered directories are not descended into.
The engine itself additionally never syncs `.protonignore` or `*.drivesync.part`
(upload temp files). Filters reload at the start of every pass, so editing
`.protonignore` takes effect on the pass that edit triggers (the watcher no
longer ignores its own events).

Filters are a **mirror**: a path that matches is treated exactly like a local
deletion, so an already-synced file whose remote copy still exists is moved to
Proton's trash on the next pass (recoverable from Proton, but removed from the
local tree's sync set). Add patterns with care, and expect newly-ignored files
to disappear from Proton Drive.

## State & ops

| What | Where |
|---|---|
| user-facing mount point (FUSE) | `~/Proton Drive` |
| real tree (scan/watch/execute/filters) | `~/.local/share/drive-sync/tree` |
| baseline + remote cache (sqlite) | `~/.local/share/drive-sync/state.db` |
| online-only markers (`online` table) | same db (dropped with their baseline row) |
| keep-on-this-device marks (`pinned` table) | same db (survive recall; dropped with their baseline row) |
| SDK node/crypto cache | `~/.local/share/drive-sync/proton-cache/` |
| sidecar python libs (pyfuse3/trio/cffi) | `~/.local/share/drive-sync/python/` |
| log + `status.json` | `~/.local/state/drive-sync/` |
| daemon pid lock | `~/.local/state/drive-sync/daemon.lock` (stale-aware) |
| pin/unpin rpc socket | `~/.local/state/drive-sync/rpc.sock` (unlinked at boot/shutdown) |
| sidecar heartbeat (tray mount check) | `~/.local/state/drive-sync/mount-ok` |
| tray icon + icons | `~/.local/lib/phnx-drive-sync/tray/` (launcher: `~/.local/bin/phnx-drive-sync-tray`; autostart: `~/.config/autostart/phnx-drive-sync-tray.desktop`) |
| installed runtime (internal disk) | `~/.local/lib/phnx-drive-sync/` (compiled engine + bundled login CLI + sidecar/tray; installed from the release tarball) |

`status.json` carries `state` (`starting|passing|running|idle|stopped|auth-required`),
last pass info, error counts, the recall-on-hover `prefetch` toggle, and
`counts: {…, placeholders, reclaimable}` (placeholder count and the bytes a
bulk free could still reclaim — what the tray storage line shows), plus
`storage: {used, max, driveUsed, fetchedAt}` (account quota from
`/core/v4/users`, refreshed on startup and at most every 5 min during passes —
read by the tray icon). While a pass runs, `progress: {current, done, total}`
names the item in flight (`null` when idle); the tray shows it with an
`(done/total)` counter under the status line.

Env overrides: `DRIVE_SYNC_ROOT` (mount point), `DRIVE_SYNC_TREE` (real tree
location), `DRIVE_SYNC_REMOTE` (path under *My files*,
default: whole drive), `DRIVE_SYNC_HOME` (relocate all state — used for isolated
tests), `DRIVE_SYNC_EVENT_IDLE_MS` (20 s), `DRIVE_SYNC_NEW_FILES` (`local`|`online`),
`DRIVE_SYNC_EVICT_FREE_GB` (auto-evict threshold, 0 = off),
`DRIVE_SYNC_PREFETCH` (sidecar recall-on-hover default, off unless set),
`DRIVE_SYNC_POLL_MS` (watcher-unhealthy safety poll interval, 0 = off),
`DRIVE_SYNC_SHUTDOWN_GRACE_MS` (how long shutdown waits for the in-flight file
operation to finish, default 120000; keep the unit's `TimeoutStopSec` above it).

Beyond these, the systemd unit's env file (`~/.config/phnx-drive-sync/env`)
carries the SDK's `PROTON_DRIVE_CACHE_DIR` and `PROTON_DRIVE_LOG_LEVEL`, and
`DRIVE_SYNC_LIBDIR` is an internal override for where the shipped resources
(`python/`, `assets/`, `tray/`) are found (used by the installer and tests).

**Shutdown.** On `SIGTERM`/`SIGINT` the engine stops scheduling passes, asks the
running pass to stop, and then **finishes the file operation already in flight**
before unmounting and exiting (the pass stops at the next action boundary, so no
upload or download is cut mid-transfer). It waits up to
`DRIVE_SYNC_SHUTDOWN_GRACE_MS` for the pass to unwind; a very large transfer that
exceeds that is abandoned safely (downloads use a `.part` temp file and resume,
uploads re-run) rather than blocking logout forever.

A full remote walk of the current tree (~10.3k nodes, 1.27k folders) takes
~5 min warm, so it runs **once at login** (the initial pass), and afterwards
only when the event stream reports a gap and asks for a resync. Everything
else is incremental: the watcher (inotifywait) and the remote event stream
trigger passes within seconds of a change, and *Sync now* forces one on
demand. There is no periodic *full* walk.

The watcher is a fast path, not a guarantee: if `inotifywait` is missing or
crashes, the event stream is unavailable, or the kernel's inotify watch limit
truncates coverage, the engine falls back to a low-frequency **safety poll**
(`DRIVE_SYNC_POLL_MS`, default 2 min) that runs an incremental pass. While the
watcher is healthy the poll stays silent. inotify-tools `-r` also watches
directories created or moved into the tree after startup, so new subtrees are
covered without a restart.

Auth failures surface in `status.json` (`auth-required`) and are retried each
interval — re-login with the official CLI:
`proton-drive` (credentials live in the GNOME keyring, shared with this engine).

## Development

```sh
bun run deps                        # install vendored dependency trees (cli + SDK + account SDK)
./node_modules/.bin/tsc -p tsconfig.json   # type-check: strict, noEmit
bun test test/                      # classify/placeholder/evict unit tests (temp state)
./phnx-drive-sync.sh once --dry-run      # classify without changing anything
bash packaging/build.sh             # build the portable release tarball into dist/
```

`packaging/build.sh` compiles `src/index.ts` and the login CLI into
self-contained binaries (Bun runtime + all modules embedded, glibc 2.17+),
assembles the runtime resources, and emits
`dist/phnx-drive-sync-<version>-linux-<arch>.tar.gz`, a per-architecture manifest
fragment `dist/latest-<arch>.json`, and a legacy single-arch `dist/latest.json`.
The release workflow merges the fragments into the arch-aware `latest.json` that
`phnx-drive-sync update` consumes (`packaging/merge-manifests.mjs`).
The release version comes from the root `package.json`.

## Known caveats

- One engine instance at a time (pid lock, single writer).
- Through the mount a full-tree `find` takes ~6 s (vs ~50 ms on the raw tree):
  one FUSE lookup+getattr round-trip per node. Interactive access is
  unaffected (stat ≈ 5 ms, bulk reads > 750 MB/s, `du` ~55 ms per folder).
- `once --dry-run` writes only harmless metadata (event id, status, log); the
  baseline table is untouched until a real pass executes.
- Directory renames propagate as mkdir + child renames + trash cascade.
- Empty directories are synced (Proton supports them).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup and pull-request checklist, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations. For
security issues, follow [SECURITY.md](SECURITY.md) and report privately.
Released changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

This project is licensed under the MIT License. Copyright (c) 2026 PHNX Studios.
See [LICENSE](LICENSE). It is a personal, non-commercial open-source project
published by PHNX Studios.

It bundles the official Proton Drive SDK (developed by Proton AG, MIT) and the
Bun runtime, and embeds the JavaScript dependencies of both into the compiled
binaries. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the summary
and the operational rules that apply to third-party clients of Proton's hosted
services; the generated `THIRD_PARTY_LICENSES.txt` (shipped in each release)
lists every embedded package with its license text.

PHNX Drive Sync is an independent, unofficial application and is not
affiliated with or supported by Proton AG.
