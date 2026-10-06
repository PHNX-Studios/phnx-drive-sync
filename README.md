# drive-sync

Bidirectional sync engine between `~/Proton Drive` and Proton Drive (`/my-files`),
built directly on the official [Proton Drive SDK](https://github.com/ProtonDriveApps/sdk)
(vendored in `vendor/`).

Requires: [bun](https://bun.sh) and an authenticated session via the official
`proton-drive` CLI (`proton-drive` re-login if the session expires).

## Usage

```sh
./drive-sync.sh run            # daemon: initial full pass, then events + watcher + interval
./drive-sync.sh once           # single full pass (exit 0 ok, 2 errors, 3 auth)
./drive-sync.sh once --dry-run # classify only: report planned actions, change nothing
./drive-sync.sh status         # print status.json
```

systemd (user):

```sh
systemctl --user enable --now drive-sync.service
journalctl --user -u drive-sync.service -f
```

Tray icon (live status, storage, controls — autostarted):

```sh
tray/drive-sync-tray.py   # status, used/free storage, Sync now, Pause/Resume, log
```

- **Sync now** sends the daemon `SIGUSR1` (runs an immediate incremental pass,
  ~0.5 s) or starts the unit if paused.
- **Pause/Resume** stops/starts `drive-sync.service`.
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

## Filters

`~/Proton Drive/.protonignore` — gitignore-style globs, one per line,
`- pattern` = exclude (bare patterns also exclude; `+` lines ignored). Matched
against full path and basename; filtered directories are not descended into.
The engine itself additionally never syncs `.protonignore` or `*.drivesync.part`
(upload temp files). Filters reload on every watcher wake.

## State & ops

| What | Where |
|---|---|
| baseline + remote cache (sqlite) | `~/.local/share/drive-sync/state.db` |
| SDK node/crypto cache | `~/.local/share/drive-sync/proton-cache/` |
| log + `status.json` | `~/.local/state/drive-sync/` |
| daemon pid lock | `~/.local/state/drive-sync/daemon.lock` (stale-aware) |
| tray icon + icons | `~/Projects/drive-sync/tray/` (autostart: `~/.config/autostart/drive-sync-tray.desktop`) |

`status.json` carries `state` (`starting|passing|running|idle|stopped|auth-required`),
last pass info, error counts and `storage: {used, max, driveUsed, fetchedAt}`
(account quota from `/core/v4/users`, refreshed on startup and at most every
5 min during passes — read by the tray icon).

Env overrides: `DRIVE_SYNC_ROOT`, `DRIVE_SYNC_REMOTE` (path under *My files*,
default: whole drive), `DRIVE_SYNC_HOME` (relocate all state — used for isolated
tests), `DRIVE_SYNC_INTERVAL_MS` (60 s), `DRIVE_SYNC_FULL_EVERY` (10 passes),
`DRIVE_SYNC_EVENT_IDLE_MS` (20 s).

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
./drive-sync.sh once --dry-run      # classify without changing anything
```

## Known caveats

- One engine instance at a time (pid lock, single writer).
- `once --dry-run` writes only harmless metadata (event id, status, log); the
  baseline table is untouched until a real pass executes.
- Directory renames propagate as mkdir + child renames + trash cascade.
- Empty directories are synced (Proton supports them).
