# proton-drive-sync

Bidirectional sync engine between `~/Proton Drive` and Proton Drive (`/my-files`),
built directly on the official [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk)
(vendored in `vendor/`).

Requires: [bun](https://bun.sh) and an authenticated session via the official
`proton-drive` CLI (`proton-drive` re-login if the session expires).

## Usage

```sh
./proton-drive-sync.sh run            # daemon: initial full pass, then events + watcher + interval
./proton-drive-sync.sh once           # single full pass (exit 0 ok, 2 errors, 3 auth)
./proton-drive-sync.sh once --dry-run # classify only: report planned actions, change nothing
./proton-drive-sync.sh status         # print status.json
./proton-drive-sync.sh unpin <paths…> # free local space; files stay on Proton Drive
./proton-drive-sync.sh pin <paths…>   # download online-only files back to this device
./proton-drive-sync.sh evict [paths…] # bulk "Free up space": no paths = every local file
./proton-drive-sync.sh prefetch on|off|status  # recall-on-hover toggle (default off)
./proton-drive-sync.sh restart         # systemctl --user restart + notification
```

`pin`/`unpin`/`evict` talk to the running daemon over a unix socket (`rpc.sock`),
so the daemon must be up (exit 1 otherwise). Directories are expanded
recursively over their files (folders themselves always stay on disk).
`unpin`/`evict` refuse to free bytes that are not synced yet — they run/await a
sync pass first and re-check; exit 2 means some paths failed (per-path detail on
stdout/stderr).

systemd (user):

```sh
./packaging/install.sh       # deploy runtime to ~/.local/lib/proton-drive-sync + wire units/autostart
systemctl --user enable --now proton-drive-sync.service
journalctl --user -u proton-drive-sync.service -f
```

`packaging/install.sh` copies the runtime (engine, sidecar, tray, vendored SDK
sources) to `~/.local/lib/proton-drive-sync/` on the **internal disk** and points the
systemd user units and XDG autostart there — startup never waits on the
external SSD (`~/Projects` is a dev checkout; state the engine manages already
lives under `~/.local`). Re-run it after changing runtime code in the
checkout. As a convenience for the dev checkout, the installer also renders
`proton-ssd-automount.service` (user unit, UUID of the currently-mounted
external SSD) so the drive is mounted at login without opening Files — GNOME
only automounts drives that appear *after* the session starts. Nothing at
runtime depends on that mount; if the drive is unplugged the unit simply
stays inactive.

Auto-start: the service is `enabled`, so it starts at login; the tray is
autostarted via `~/.config/autostart/proton-drive-sync-tray.desktop` and also via `proton-drive-sync-tray.service` user unit for resilience. If the engine
ever needs a manual kick, **Proton Drive Sync (restart engine)** in the application
menu (and on the Desktop) runs `proton-drive-sync.sh restart` — restarts the service,
waits for the FUSE heartbeat to come back, and reports the result via
`notify-send`. If the sidecar dies while the engine runs, the engine relaunches
it automatically within seconds (see `mount` in `status.json`); the tray's
**Sync now** also heals a degraded mount by restarting the unit.

Tray icon (live status, storage, controls — autostarted):

```sh
tray/proton-drive-sync-tray.py   # status, used/free storage, Sync now, Pause/Resume, log
```

- **Sync now** sends the daemon `SIGUSR1` (runs an immediate incremental pass,
  ~0.5 s) or starts the unit if paused.
- **Pause/Resume** stops/starts `proton-drive-sync.service`.
- **Free up space (all local files)** appears whenever there is reclaimable
  space and runs the same bulk evict as `proton-drive-sync.sh evict` (keep-marked and
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

- `proton-drive-sync.sh unpin 'path/…'` — after ensuring the latest local bytes are
  synced, marks the file online-only and drops the local bytes. It stays
  visible through the mount; the next open/recall re-downloads it.
- `proton-drive-sync.sh pin 'path/…'` — recall explicitly (download + clear the mark),
  byte-identical from the baseline (uid/size/mtime). `pin` also sets a
  **keep-on-this-device** mark: auto-eviction and bulk free will never touch
  that file until an `unpin` (or a free-up-space) clears the mark — last
  explicit instruction wins.
- `proton-drive-sync.sh evict [path/…]` — bulk *Free up space* (no paths = every
  materialized file). Only clean, synced, non-keep-marked files are freed,
  largest first; unsynced edits and keep-marked files stay local. The same
  action is available from the tray menu.
- Renames/moves of placeholders are metadata-only (remote move included).
- Nautilus/gio trash: a placeholder is trashed remotely; a materialized file
  moves into the local `.Trash-<uid>` (never synced) and is trashed remotely
  on the next pass.

**Recall on hover (prefetch, default off).** With `proton-drive-sync.sh prefetch on`,
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

**Nautilus badges (cloud vs star).** Every synced file carries a badge via
the gvfs metadata store (`metadata::emblems` keyword → `emblem-<keyword>`
icon): online-only placeholders show a **cloud**, materialized files a
**star** — the badge tracks bytes-on-disk only (keep-marked files are stars
too). Folders get none. The engine applies the diff after every pass and after
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
`trio`, `cffi` importable with `PYTHONPATH=~/.local/share/drive-sync/python`
(the engine probes the import at startup; if it fails the engine still runs —
the mount point stays empty and the tray shows "Mount degraded").

Nautilus context menu (multi-select supported):

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
(upload temp files). Filters reload on every watcher wake.

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
| tray icon + icons | `~/.local/lib/proton-drive-sync/tray/` (launcher: `~/.local/bin/proton-drive-sync-tray`; autostart: `~/.config/autostart/proton-drive-sync-tray.desktop`) |
| installed runtime (internal disk) | `~/.local/lib/proton-drive-sync/` (`packaging/install.sh`; SSD checkout = dev tree only) |

`status.json` carries `state` (`starting|passing|running|idle|stopped|auth-required`),
last pass info, error counts, the recall-on-hover `prefetch` toggle, and
`counts: {…, placeholders, reclaimable}` (placeholder count and the bytes a
bulk free could still reclaim — what the tray storage line shows), plus
`storage: {used, max, driveUsed, fetchedAt}` (account quota from
`/core/v4/users`, refreshed on startup and at most every 5 min during passes —
read by the tray icon).

Env overrides: `DRIVE_SYNC_ROOT` (mount point), `DRIVE_SYNC_TREE` (real tree
location), `DRIVE_SYNC_REMOTE` (path under *My files*,
default: whole drive), `DRIVE_SYNC_HOME` (relocate all state — used for isolated
tests), `DRIVE_SYNC_INTERVAL_MS` (60 s), `DRIVE_SYNC_FULL_EVERY` (10 passes),
`DRIVE_SYNC_EVENT_IDLE_MS` (20 s), `DRIVE_SYNC_NEW_FILES` (`local`|`online`),
`DRIVE_SYNC_EVICT_FREE_GB` (auto-evict threshold, 0 = off),
`DRIVE_SYNC_PREFETCH` (sidecar recall-on-hover default, off unless set).

A full remote walk of the current tree (~10.3k nodes, 1.27k folders) takes
~5 min warm; systemd unit runs fallback intervals at 2 min with a full walk
every 30 min. Watcher (inotifywait) and the event stream trigger passes within
seconds of a change; the interval pass is only a safety net.

Auth failures surface in `status.json` (`auth-required`) and are retried each
interval — re-login with the official CLI:
`proton-drive` (credentials live in the GNOME keyring, shared with this engine).

## Development

```sh
cd vendor/cli && bun install        # bootstrap deps (node_modules is a symlink into vendor)
./node_modules/.bin/tsc -p tsconfig.json   # type-check: strict, noEmit
bun test test/                      # classify/placeholder/evict unit tests (temp state)
./proton-drive-sync.sh once --dry-run      # classify without changing anything
```

## Known caveats

- One engine instance at a time (pid lock, single writer).
- Through the mount a full-tree `find` takes ~6 s (vs ~50 ms on the raw tree):
  one FUSE lookup+getattr round-trip per node. Interactive access is
  unaffected (stat ≈ 5 ms, bulk reads > 750 MB/s, `du` ~55 ms per folder).
- `once --dry-run` writes only harmless metadata (event id, status, log); the
  baseline table is untouched until a real pass executes.
- Directory renames propagate as mkdir + child renames + trash cascade.
- Empty directories are synced (Proton supports them).
