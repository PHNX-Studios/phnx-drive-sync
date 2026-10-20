# PHNX Drive Sync

[![CI](https://github.com/PHNX-Studios/phnx-drive-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/PHNX-Studios/phnx-drive-sync/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/PHNX-Studios/phnx-drive-sync)](https://github.com/PHNX-Studios/phnx-drive-sync/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux-blue.svg)](#install)

## Overview

Bidirectional sync engine between `~/Proton Drive` and Proton Drive
(`/my-files`), built directly on the official
[Proton Drive SDK](https://github.com/ProtonDriveApps/sdk) (vendored in
`vendor/`).

What it provides:

- **Bidirectional sync** with a three-way baseline diff, rename pairing, and
  conflict copies (local wins, remote preserved).
- **Files on demand:** a FUSE mount whose placeholders stay visible with their
  real size and materialize on open (OneDrive-style recall).
- **File manager GUI:** a GTK4 + Libadwaita window over the mount, with
  per-file sync badges and full file management.
- **Tray icon** with live sync status, storage, and quick actions.
- **Nautilus integration:** cloud/check badges and a right-click context menu.
- **Self-updating** single release tarball with systemd user units and
  autostart.

> **Unofficial third-party application.** PHNX Drive Sync is an independent
> project. It is **not** affiliated with, endorsed by, or supported by Proton AG.
> "Proton" and "Proton Drive" are trademarks of Proton AG, used here only to
> describe interoperability. Proton requires third-party clients to identify
> themselves honestly and not masquerade as first-party software; this
> application sends an `x-pm-appversion` header of the form
> `external-drive-phnx_drive_sync@<version>` and talks only to official endpoints.

## Table of contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Authentication and sessions](#authentication-and-sessions)
  - [How sign-in works](#how-sign-in-works)
  - [Where the session lives](#where-the-session-lives)
  - [Token refresh](#token-refresh)
  - [Session states](#session-states)
  - [Recovering from an expired session](#recovering-from-an-expired-session)
  - [Logging out](#logging-out)
- [Install](#install)
  - [Quick install](#quick-install)
  - [Installer flags](#installer-flags)
  - [FUSE readiness](#fuse-readiness)
  - [Upgrades and self-update](#upgrades-and-self-update)
- [Command reference](#command-reference)
- [User interfaces](#user-interfaces)
  - [File manager GUI](#file-manager-gui)
  - [Tray icon](#tray-icon)
  - [Nautilus context menu](#nautilus-context-menu)
  - [Nautilus badges](#nautilus-badges)
- [How sync works](#how-sync-works)
  - [A sync pass](#a-sync-pass)
  - [Conflict policy](#conflict-policy)
- [Files on demand](#files-on-demand)
  - [Placeholders and recall](#placeholders-and-recall)
  - [Recall on hover (prefetch)](#recall-on-hover-prefetch)
  - [Auto-evict on low disk](#auto-evict-on-low-disk)
  - [New remote files](#new-remote-files)
  - [Sidecar requirements](#sidecar-requirements)
- [Filters](#filters)
- [Configuration and state](#configuration-and-state)
  - [State locations](#state-locations)
  - [status.json](#statusjson)
  - [Environment variables](#environment-variables)
  - [Service management](#service-management)
  - [Shutdown](#shutdown)
  - [Sync cadence and the watcher](#sync-cadence-and-the-watcher)
  - [Auth failures](#auth-failures)
- [Development](#development)
- [Known caveats](#known-caveats)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- [bun](https://bun.sh) to build and run from a source checkout. The release
  tarball is self-contained (a compiled engine plus the bundled login CLI), so
  an installed copy needs no external runtime.
- An authenticated Proton Drive session. Sign in with `phnx-drive-sync login`
  (see [Authentication and sessions](#authentication-and-sessions)); the session
  is shared with the official CLI through the GNOME keyring.

Files on demand additionally needs the system FUSE stack. The GUI needs GTK4 +
Libadwaita and the tray needs GTK3 + AppIndicator; the installer sets these up
and each degrades gracefully when missing. See [Install](#install) and
[User interfaces](#user-interfaces).

## Authentication and sessions

Sign-in is delegated entirely to the official Proton Drive CLI; PHNX Drive Sync
never handles your password or account secrets itself. This section describes
how sign-in works, where the session lives, and what the engine does as that
session changes state.

### How sign-in works

`phnx-drive-sync login` is a thin wrapper around the official CLI that is bundled
with the release (or falls back to a system `proton-drive`):

1. It prints a short third-party disclosure to stderr (Proton requires clients
   to identify themselves honestly), then runs `proton-drive auth login`.
2. The CLI opens your browser to a Proton sign-in page. The password is entered
   in the browser only - never on the command line. You can even complete the
   sign-in on another device; the terminal waits until it finishes.
3. On success the CLI stores the session in the OS secret store (see
   [Where the session lives](#where-the-session-lives)) and login returns.

If the bundled CLI is missing (`phnx-drive-sync login` exits `127`), reinstall,
or install the official CLI and run `proton-drive auth login` directly - both
write to the same store.

### Where the session lives

The authenticated session is kept in the **OS secret store**, not in `state.db`,
the logs, or the config files (see [SECURITY.md](SECURITY.md)). On Linux that is
GNOME Keyring / libsecret under the service `ch.proton.drive/drive-sdk-cli`.

The stored entry contains:

| Field | Purpose |
| --- | --- |
| `session.uid` | Proton user id. |
| `session.accessToken` | Short-lived bearer token for API calls. |
| `session.refreshToken` | Longer-lived token used to renew the access token. |
| `userKeyPassword` | Unlocks the user's keys so Drive content can be decrypted. |
| `cachePassword` | Random secret that encrypts the SDK's local crypto cache. |
| `telemetryEnabled` | Whether optional telemetry is enabled. |

`PROTON_DRIVE_CREDENTIALS_STORE` selects the backend: `keychain` (default, the OS
secret store), `pass` (a GPG-encrypted password-store entry), or `unsafe_file`
(plaintext `auth-session.json` in the app data folder - testing only, never for
real use). The default needs no configuration. To use a non-default store, set
the variable for the engine (in the systemd env file,
`~/.config/phnx-drive-sync/env`, which also carries the SDK's
`PROTON_DRIVE_CACHE_DIR` and `PROTON_DRIVE_LOG_LEVEL`) and for the login command
(in your shell environment), so the CLI and the engine agree on where the session
lives.

Because both the official CLI and the engine read this same store, one sign-in
serves both. `phnx-drive-sync login` and `proton-drive auth login` are
interchangeable for the purposes of this app.

### Token refresh

The SDK renews the short-lived access token automatically from the refresh token
on every authenticated request, so an ordinary token expiry never interrupts
syncing. The engine classifies a response as an authentication failure only when
it matches a small set of signals (`401`/`403`, `unauthorized`, `forbidden`,
`session`, `refresh token`, two-factor, `authentication required`). A transient
failure (a network blip, a temporary 2FA prompt) therefore recovers on its own
once the SDK can refresh again.

### Session states

The engine's `status.json` carries a `state` field with one of:

| State | Meaning |
| --- | --- |
| `starting` | Engine is booting (before the first pass). |
| `passing` | A sync pass is in flight. |
| `running` | Steady state: initial pass done, listening for changes. |
| `idle` | `once` mode finished a single pass. |
| `stopped` | Engine is shut down (or `once --dry-run`). |
| `auth-required` | The session was rejected; syncing is paused until sign-in. |

The auth-relevant behavior differs by when the failure happens:

- **Steady state (session expires while running).** The pass that hits the
  rejection sets `state: auth-required`, records the message in `lastError`, and
  the engine keeps running. It retries on the next change (a watcher event, a
  remote event, or the safety poll), so a temporary failure heals itself. The
  tray icon turns red and the GUI shows "auth required" while in this state.
- **Startup (no session, or it is already invalid).** The engine cannot resolve
  the remote root without a valid session, so it fails during startup or the
  initial full pass and exits. The systemd unit restarts it every 10 s
  (`Restart=on-failure`), which surfaces as a red "service failed" tray state
  rather than `auth-required`. The fix is to sign in; the unit then comes up on
  its own.
- **`once` mode.** Exit code `3` means the pass hit an authentication failure
  (`0` ok, `2` other errors). A missing or invalid session at startup fails
  earlier and exits `1` instead.

### Recovering from an expired session

To recover after a rejection:

1. Sign in again: `phnx-drive-sync login` (or `proton-drive auth login`). This
   writes a fresh session to the keyring.
2. Restart the engine so it re-reads the keyring:
   `phnx-drive-sync restart` (or
   `systemctl --user restart phnx-drive-sync.service`).

The running engine loads the session once at startup; it does not re-read the
keyring on a later pass, so a restart is the reliable way to pick up a new
session after a full re-login. (A transient failure that only needs a token
refresh recovers without any action, because the SDK refreshes in place.)

### Logging out

`proton-drive auth logout` removes the keyring entry (and the CLI's local
caches). A running engine loads the session only at startup, so it is not
notified of the change and keeps using its in-memory session; it notices only on
its next restart, when it finds no session and fails to initialize (exiting until
you sign in again). To sign out completely, run `proton-drive auth logout` and
restart the engine, for example with `phnx-drive-sync restart`.

## Install

Download the release tarball for your architecture from the
[releases page](https://github.com/PHNX-Studios/phnx-drive-sync/releases), then
run its installer. It is self-contained: the engine and the official login CLI
are compiled to single binaries (Bun runtime + all dependencies embedded, glibc
2.17+), and the installer wires up systemd user units, autostart, icons and the
Nautilus context menu.

Everything lands under `~/.local`; the only elevated step is installing a small
set of host packages (fuse3, python3, GTK/AppIndicator, inotify-tools, gvfs,
libnotify, gnome-keyring, and GTK4/Libadwaita for the file manager GUI) via your
package manager. When it cannot elevate (no sudo, an unknown distro, or
`--no-system-deps`), the two host pieces that matter most are fetched into
`~/.local` without root: `inotify-tools` (the fast file watcher) and the Ayatana
AppIndicator typelib (the tray icon). Everything else degrades gracefully on its
own.

### Quick install

```sh
tar xzf phnx-drive-sync-<version>-linux-<arch>.tar.gz
cd phnx-drive-sync-<version>-linux-<arch>
./install.sh                 # detects the distro, installs host deps, wires everything
phnx-drive-sync login        # the only manual step: sign in to Proton Drive
```

### Installer flags

| Flag | Effect |
| --- | --- |
| `--no-system-deps` | Skip the elevated package-manager step; the user-level fallback still runs. |
| `--no-deps` | Install no dependencies at all. |
| `--enable-autoupdate` | Enable a weekly `phnx-drive-sync update` via a systemd user timer. |
| `--disable-autoupdate` | Disable the weekly auto-update timer. |
| `--force` | Reinstall even the same version. |

### FUSE readiness

Installation ends with a **FUSE readiness report**. Files-on-demand needs the
system FUSE stack (`/dev/fuse` and the setuid `fusermount3` from `fuse3`),
and `fusermount3` cannot be provided without root, so that part is only set up on
the elevated path. If it is missing, the installer says exactly what to install;
the engine still performs full bidirectional sync, but `~/Proton Drive` stays
empty (the tray shows "Mount degraded").

### Upgrades and self-update

Upgrades are handled by re-running a newer tarball's installer: it refuses to
downgrade, no-ops on the same version, and preserves all state under
`~/.local/share/phnx-drive-sync` and `~/.local/state/phnx-drive-sync`. Upgrading
from the older `drive-sync` layout migrates those directories in place (baseline,
placeholder and keep marks, the real tree and the SDK cache move with them), so
nothing is re-downloaded.

`phnx-drive-sync update` trusts the configured release host over TLS and verifies
the tarball's SHA-256 from the release manifest before running the installer (as
the ordinary user). The manifest is arch-aware: it carries an entry per
architecture (`x86_64`, `aarch64`) and the updater picks the one matching the
running binary. It refuses releases whose `min_glibc`/`min_kernel`/`min_python`
exceed the host, so an old machine is never handed a binary it cannot run. Point
it at a mirror with `PHNX_DRIVE_SYNC_RELEASE_URL` or `update --url <manifest>`.

## Command reference

Once installed the `phnx-drive-sync` command is on `~/.local/bin` (from a dev
checkout use `bun run src/index.ts <cmd>` or `./phnx-drive-sync.sh <cmd>`):

| Command | What it does |
| --- | --- |
| `phnx-drive-sync run` | Daemon: initial full pass, then events + watcher + interval. |
| `phnx-drive-sync once` | Single full pass (exit 0 ok, 2 errors, 3 auth). |
| `phnx-drive-sync once --dry-run` | Classify only: report planned actions, change nothing. |
| `phnx-drive-sync status` | Print `status.json`. |
| `phnx-drive-sync unpin <paths...>` | Free local space; files stay on Proton Drive. |
| `phnx-drive-sync pin <paths...>` | Download online-only files back to this device. |
| `phnx-drive-sync evict [paths...]` | Bulk "Free up space": no paths = every local file. |
| `phnx-drive-sync prefetch on\|off\|status` | Recall-on-hover toggle (default off). |
| `phnx-drive-sync login` | Sign in to Proton Drive (bundled official CLI); see [Authentication and sessions](#authentication-and-sessions). |
| `phnx-drive-sync restart` | `systemctl --user restart` + wait for the FUSE mount. |
| `phnx-drive-sync update [--check]` | Install a newer release, if one is available. |
| `phnx-drive-sync version` | Print the version. |
| `phnx-drive-sync-gui [PATH]` | Open the file manager GUI; see [File manager GUI](#file-manager-gui). |

`pin`/`unpin`/`evict` talk to the running daemon over a unix socket (`rpc.sock`),
so the daemon must be up (exit 1 otherwise). Directories are expanded recursively
over their files (folders themselves always stay on disk). `unpin`/`evict` refuse
to free bytes that are not synced yet: they run/await a sync pass first and
re-check; exit 2 means some paths failed (per-path detail on stdout/stderr).

## User interfaces

Three clients sit on top of the engine: the file manager GUI, the tray icon, and
Nautilus. All read state from `status.json` and act through the mount or the
engine's `rpc.sock`; none talks to Proton's API directly.

### File manager GUI

A GTK4 + Libadwaita window over `~/Proton Drive` (also in the application menu):

```sh
phnx-drive-sync-gui          # open the sync root
phnx-drive-sync-gui "Docs"   # open a folder (relative to the root, or absolute under ~/Proton Drive)
phnx-drive-sync-gui --version
phnx-drive-sync-gui --help
```

The window lists the current folder in four sortable columns (Name, Size,
Modified, Sync). Each entry shows its state as a badge - **cloud** for
online-only, **green check** for on this device, **amber** for pending, and a
neutral marker for **not synced yet** - and the header shows a storage line
("X of Y used", plus reclaimable bytes and the online-only count) and a progress
bar that names the item in flight during a pass.

Actions (header menu and right-click context menu, adapting to the selection):

- **Open** - a file opens in the default application, a folder navigates into it.
- **Keep on this device** (pin) - download online-only files and clear the mark.
- **Free up space** (unpin) - free the selected files; they stay on Proton Drive
  and remain visible through the mount. (The header menu labels this item "Free
  up space (selection)".)
- **Free up space (all local files)** - the bulk evict (every clean, synced,
  non-keep-marked local file), behind a confirm dialog.
- **New folder**, **Rename**, **Move to trash**.
- **Sync now** - trigger an incremental pass.
- **Edit ignore filters** - open `~/Proton Drive/.protonignore` in the default
  editor (created empty if it does not exist).

The hamburger menu also holds **Preferences** and **About PHNX Drive Sync**. The
Preferences window (Sync page, "Files on demand" group) has:

- **Recall on hover** - a switch for the prefetch toggle (see
  [Recall on hover](#recall-on-hover-prefetch)); it writes through to the engine
  immediately.
- **Advanced settings** - the path of the systemd environment file
  (`~/.config/phnx-drive-sync/env`), shown selectable.

Keyboard shortcuts: `Return` opens, `Ctrl+R` / `F5` syncs now, `Ctrl+Shift+N`
creates a folder, `F2` renames, `Delete` moves to trash. Multi-selection works
and the item actions adapt to it; engine-backed items are hidden while the
service is stopped, when the window instead shows a "Sync engine not running"
page with the `systemctl --user start phnx-drive-sync.service` hint and clears
itself once the engine returns.

The list updates live, not only on navigation: the GUI watches `status.json`'s
`revision` and re-reads the visible folder whenever a pass or an action changes
file status, repainting each badge in place (selection and scroll position are
preserved); during a long pass it also re-reads at a short cadence so files
settle as they sync. It talks to the mount for file operations (so placeholder
recall, metadata-only renames and remote trash all apply automatically) and to
the running engine over `rpc.sock` for status and sync control.

Requires GTK4 + Libadwaita (`gir1.2-gtk-4.0`, `gir1.2-adw-1`), installed by
`install.sh`. `phnx-drive-sync-gui --self-check` builds the window and exits (used
by CI; it needs a display, e.g. under `xvfb-run`).

### Tray icon

Live status, storage and controls; autostarted:

```sh
tray/phnx-drive-sync-tray.py   # 2x2 status grid, top-level actions, Pause/Resume
```

The menu shows a 2x2 status grid (sync status | storage, online-only |
reclaimable) followed by top-level action items - **Sync now**, **Open PHNX
Drive Sync** (the file manager GUI), **Open Proton Drive folder**, **Show last
log** and **Free up space** (revealed when something is reclaimable) - then
Pause/Resume + Quit. There are no submenus. While a pass runs the status cell
tracks the current item and its `(done/total)` progress.

- **Sync now** sends the daemon `SIGUSR1` (runs an immediate incremental pass,
  ~0.5 s) or starts the unit if paused.
- **Pause/Resume** stops/starts `phnx-drive-sync.service`.
- **Free up space (all local files)** appears whenever there is reclaimable space
  and runs the same bulk evict as `phnx-drive-sync evict` (keep-marked and
  unsynced files stay local).
- Icon states: idle (green), syncing (orange, incl. long full walks), error
  (red: service failed / auth required / last pass errored), paused (grey).

### Nautilus context menu

Multi-select supported. The installer puts the scripts in
`~/.local/share/nautilus/scripts/`; from a dev checkout:

```sh
mkdir -p ~/.local/share/nautilus/scripts
cp -r "tray/nautilus-scripts/Proton Drive" ~/.local/share/nautilus/scripts/
```

Then in Nautilus: right-click -> *Scripts* -> *Proton Drive* -> **Free up Space**
or **Keep on This Device**; the result comes back as a `notify-send`
notification. Filenames containing newlines are not supported by Nautilus'
script environment.

### Nautilus badges

Every synced file carries a badge via the gvfs metadata store
(`metadata::emblems` keyword -> `emblem-<keyword>` icon): online-only
placeholders show a **cloud**, materialized files a **green check**
(`emblem-default`, OneDrive-style "kept on this device"; Yaru's
`emblem-favorite` heart reads as "liked", not "synced") - the badge tracks
bytes-on-disk only (keep-marked files get the check too). Folders get none.

The engine applies the diff after every pass and after pin/unpin/evict/hydrate
RPCs (concurrency 8), remembering the last applied badge per path in `state.db`
so restarts and no-op passes spawn nothing; `PHNX_DRIVE_SYNC_EMBLEMS=off`
disables it entirely. Since Yaru ships no cloud emblem, a custom
`emblem-cloud.svg` is installed into
`~/.local/share/icons/hicolor/scalable/emblems/` on first sync (stale theme cache
invalidated alongside). Nautilus re-reads metadata only on F5 / re-entering the
folder - badges appear after a refresh, not live. Failure modes degrade quietly:
`gio` missing -> logged once, badges skipped; mount down -> missing paths
deferred until the next pass.

## How sync works

### A sync pass

1. **Event catch-up** - drains tree events since the stored id so the SDK's
   internal node cache reflects external renames/deletes; first run (no id yet)
   purges caches instead so the initial hydration is fresh.
2. **Scan** - local filesystem walk (filters applied, filtered dirs pruned) and
   remote walk (full every Nth pass, cached view in between, refreshed by
   events).
3. **Classify** - three-way diff against the baseline (`sync` table: last-synced
   facts for both sides). On the very first pass, matching size+mtime pairs are
   silently adopted as baseline (no conflict, no upload).
4. **Execute** - phases in order: mkdir local -> mkdir remote -> rename local ->
   rename remote -> download/upload/conflict -> local deletes -> remote trash.

Change detection: size equal and mtime within 1.5 s = unchanged. Rename pairing
only fires against a steady baseline with a unique size+mtime candidate, so a
bootstrap pass never invents renames.

### Conflict policy

Both sides changed since baseline -> **local wins**: local content is uploaded
(new revision), remote content is preserved as
`name (conflict YYYYMMDD-HHMMSS).ext` locally *and* uploaded as a new remote
file. Nothing is ever silently overwritten or dropped.

Deletions mirror both ways (remote deletions land in Proton's trash, so they are
recoverable there).

## Files on demand

`~/Proton Drive` is a FUSE mount (the `phnx-drive-sync-fuse` sidecar) over the real tree at
`~/.local/share/phnx-drive-sync/tree`. Every synced path is always visible with
its real size; online-only files cost no disk (`du` ~ 0, `blocks=0`). Reads never
see zero-fill: reading a placeholder blocks, downloads the content from the
baseline (byte-identical) and materializes the file - OneDrive recall semantics.
Writes to a placeholder materialize first, then write.

### Placeholders and recall

- `phnx-drive-sync unpin 'path/...'` - after ensuring the latest local bytes are
  synced, marks the file online-only and drops the local bytes. It stays visible
  through the mount; the next open/recall re-downloads it.
- `phnx-drive-sync pin 'path/...'` - recall explicitly (download + clear the
  mark), byte-identical from the baseline (uid/size/mtime). `pin` also sets a
  **keep-on-this-device** mark: auto-eviction and bulk free will never touch that
  file until an `unpin` (or a free-up-space) clears the mark - last explicit
  instruction wins.
- `phnx-drive-sync evict [path/...]` - bulk *Free up space* (no paths = every
  materialized file). Only clean, synced, non-keep-marked files are freed,
  largest first; unsynced edits and keep-marked files stay local. The same action
  is available from the tray menu and the GUI.
- Renames/moves of placeholders are metadata-only (remote move included).
- Nautilus/gio trash: a placeholder is trashed remotely; a materialized file
  moves into the local `.Trash-<uid>` (never synced) and is trashed remotely on
  the next pass.

### Recall on hover (prefetch)

Default off. With `phnx-drive-sync prefetch on`, any lookup of a placeholder
through the mount (hover, preview, directory stat) queues a background download
instead of waiting for the first open; two downloads run in parallel, the rest
queue. `prefetch off` (the default) recalls only on open. The override lives in
`state.db` (`prefetch` meta key); without it the sidecar falls back to
`PHNX_DRIVE_SYNC_PREFETCH` (env default). Toggle it from the GUI's Preferences or
the CLI.

### Auto-evict on low disk

Default off. With `PHNX_DRIVE_SYNC_EVICT_FREE_GB=<n>` set (e.g. in the systemd
unit), every pass checks the free space of the filesystem holding the real tree;
below the threshold the largest clean, non-keep-marked local files are evicted
until the threshold clears, and a `notify-send` report says what was freed.

### New remote files

`PHNX_DRIVE_SYNC_NEW_FILES=online` makes files that first appear remotely
materialize as placeholders instead of downloading (folders still materialize).
Default `local` = download, as before.

### Offline behavior

The mount does not depend on connectivity: placeholders are served from the
baseline db, so `~/Proton Drive` stays browsable with the network down, and the
engine **never exits because it cannot reach the API** (at login it mounts first,
then retries the API with backoff instead of crash-looping).

While the engine believes it is offline, opening an online-only file fails
**immediately** with `ENETDOWN` ("Network is down") instead of hanging through the
SDK's retries and returning `EIO` ("Input/output error"). The same fast failure
applies to renaming/trashing a placeholder, and `pin` reports a single
`you're offline - N file(s) need internet to download.` Any state stays safe: the
online-only marker is kept on failure (I5), no `.part` temp is left behind, and a
retry after reconnect downloads normally. When connectivity returns, the engine
runs one reconciling full pass automatically; recall-on-hover is dropped (not
queued) while offline.

Offline is detected three ways and combined (a *hint*, never a guarantee): a cheap
kernel link probe (default route + carrier), the SDK's own `transfersPaused`/
`transfersResumed` events, and classification of a real network failure. A
black-holed link that still looks "up" is caught by the last one, so the first
open after such a failure can still be slow, but every following open fails fast.
The tray shows "Offline - reconnecting..." and the file manager shows an offline
banner; a desktop notification is sent once per offline/online transition.

### Sidecar requirements

The sidecar is a static binary (`~/.local/lib/phnx-drive-sync/phnx-drive-sync-fuse`,
written in Rust, no libc or Python dependency) shipped in the release tarball; it
only needs `/dev/fuse` and the setuid `fusermount3` from the system `fuse3`
package. If the binary is missing or cannot mount, the engine still runs - the
mount point stays empty and the tray shows "Mount degraded". Upgrading from 0.5
or earlier removes the pip-installed `pyfuse3`/`trio`/`cffi` that the former
Python sidecar used (`~/.local/share/phnx-drive-sync/python/`).

## Filters

`~/Proton Drive/.protonignore` - gitignore-style globs, one per line,
`- pattern` = exclude (bare patterns also exclude; `+` lines ignored). Matched
against full path and basename; filtered directories are not descended into. The
engine itself additionally never syncs `.protonignore` or `*.drivesync.part`
(upload temp files). Filters reload at the start of every pass, so editing
`.protonignore` takes effect on the pass that edit triggers (the watcher no
longer ignores its own events).

Filters are a **mirror**: a path that matches is treated exactly like a local
deletion, so an already-synced file whose remote copy still exists is moved to
Proton's trash on the next pass (recoverable from Proton, but removed from the
local tree's sync set). Add patterns with care, and expect newly-ignored files to
disappear from Proton Drive.

## Configuration and state

### State locations

| What | Where |
| --- | --- |
| user-facing mount point (FUSE) | `~/Proton Drive` |
| real tree (scan/watch/execute/filters) | `~/.local/share/phnx-drive-sync/tree` |
| baseline + remote cache (sqlite) | `~/.local/share/phnx-drive-sync/state.db` |
| online-only markers (`online` table) | same db (dropped with their baseline row) |
| keep-on-this-device marks (`pinned` table) | same db (survive recall; dropped with their baseline row) |
| SDK node/crypto cache | `~/.local/share/phnx-drive-sync/proton-cache/` |
| log + `status.json` | `~/.local/state/phnx-drive-sync/` |
| daemon pid lock | `~/.local/state/phnx-drive-sync/daemon.lock` (stale-aware) |
| pin/unpin rpc socket | `~/.local/state/phnx-drive-sync/rpc.sock` (unlinked at boot/shutdown) |
| sidecar heartbeat (tray mount check) | `~/.local/state/phnx-drive-sync/mount-ok` |
| tray icon + icons | `~/.local/lib/phnx-drive-sync/tray/` (launcher: `~/.local/bin/phnx-drive-sync-tray`; autostart: `~/.config/autostart/phnx-drive-sync-tray.desktop`) |
| file manager GUI | `~/.local/lib/phnx-drive-sync/gui/` (launcher: `~/.local/bin/phnx-drive-sync-gui`; app entry: `~/.local/share/applications/phnx-drive-sync-gui.desktop`) |
| installed runtime (internal disk) | `~/.local/lib/phnx-drive-sync/` (compiled engine + FUSE sidecar binary + bundled login CLI + tray/gui; installed from the release tarball) |

### status.json

`status.json` carries `state` (`starting|passing|running|idle|stopped|auth-required`),
last pass info, a monotonic `revision` that advances whenever a pass or a
mutating RPC may have changed file status (the file manager GUI watches it to
refresh the visible folder live), error counts, the recall-on-hover `prefetch`
toggle, and `counts: {..., placeholders, reclaimable}` (placeholder count and the
bytes a bulk free could still reclaim - what the tray storage line shows), plus
`storage: {used, max, driveUsed, fetchedAt}` (account quota from
`/core/v4/users`, refreshed on startup and at most every 5 min during passes -
read by the tray icon). While a pass runs, `progress: {current, done, total}`
names the item in flight (`null` when idle); the tray shows it with an
`(done/total)` counter under the status line. A degraded FUSE mount surfaces as
`mount` (the tray and GUI read it to show "Mount degraded"), and connectivity as
`offline` + `offlineSince` (the tray/GUI show the offline state).

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PHNX_DRIVE_SYNC_ROOT` | `~/Proton Drive` | FUSE mount point (user-facing). |
| `PHNX_DRIVE_SYNC_TREE` | `~/.local/share/phnx-drive-sync/tree` | Real tree (scan/watch/execute/filters). |
| `PHNX_DRIVE_SYNC_REMOTE` | whole drive | Remote path under *My files*. |
| `PHNX_DRIVE_SYNC_HOME` | XDG base dirs | Relocate all state; used for isolated tests. |
| `PHNX_DRIVE_SYNC_EVENT_IDLE_MS` | `20000` | Event-stream idle debounce. |
| `PHNX_DRIVE_SYNC_NEW_FILES` | `local` | `local` (download) or `online` (placeholder) on first remote appearance. |
| `PHNX_DRIVE_SYNC_EVICT_FREE_GB` | `0` | Auto-evict threshold in GB; `0` disables. |
| `PHNX_DRIVE_SYNC_PREFETCH` | off unless set | Sidecar recall-on-hover default. |
| `PHNX_DRIVE_SYNC_POLL_MS` | `120000` | Watcher-unhealthy safety poll interval; `0` disables. |
| `PHNX_DRIVE_SYNC_SHUTDOWN_GRACE_MS` | `120000` | Stop-grace for the in-flight file operation; keep the systemd unit's `TimeoutStopSec` above it. |
| `PHNX_DRIVE_SYNC_EMBLEMS` | on | Set `off` to disable Nautilus badges. |
| `PHNX_DRIVE_SYNC_CONNECTIVITY_POLL_MS` | `5000` | Kernel link-probe interval for proactive offline detection; `0` disables the probe (reactive fast-fail still applies). |
| `PHNX_DRIVE_SYNC_RECONNECT_MIN_MS` | `5000` | First API-reconnect delay after an offline boot; doubles up to the max. |
| `PHNX_DRIVE_SYNC_RECONNECT_MAX_MS` | `120000` | Ceiling for the API-reconnect backoff. |
| `PHNX_DRIVE_SYNC_OFFLINE_NOTIFY_COOLDOWN_MS` | `1800000` | Minimum gap between offline transition notifications (30 min). |
| `PHNX_DRIVE_SYNC_RPC_CONNECT_TIMEOUT_S` | `10` | Sidecar: how long a recall may wait for the engine's RPC socket before failing `ENOTCONN`. |
| `PHNX_DRIVE_SYNC_RPC_RESPONSE_TIMEOUT_S` | `1800` | Sidecar: how long a recall may wait for the engine's answer (large-file headroom). |
| `PHNX_DRIVE_SYNC_RELEASE_URL` | GitHub releases | Release host/mirror for `update`. |
| `PHNX_DRIVE_SYNC_LIBDIR` | auto | Internal: where shipped resources (`phnx-drive-sync-fuse`, `assets/`, `tray/`, `gui/`) are found. |

Beyond these, the systemd unit's env file (`~/.config/phnx-drive-sync/env`)
carries the SDK's `PROTON_DRIVE_CACHE_DIR` and `PROTON_DRIVE_LOG_LEVEL`. Every
`PHNX_DRIVE_SYNC_*` name keeps its historical `DRIVE_SYNC_*` spelling as a
deprecated alias (the canonical name wins); the engine, the FUSE sidecar and the
GUI all read the canonical name first, so an existing env file or script keeps
working unchanged.

### Service management

systemd (user): the installer enables and starts the units. To drive them by
hand:

```sh
systemctl --user status phnx-drive-sync.service phnx-drive-sync-tray.service
systemctl --user restart phnx-drive-sync.service
journalctl --user -u phnx-drive-sync.service -f
```

The installer deploys the compiled runtime to `~/.local/lib/phnx-drive-sync/` on
the **internal disk** and points the systemd user units and XDG autostart there -
startup never waits on an external drive (state the engine manages already lives
under `~/.local`). Upgrades reuse the same installer.

Auto-start: the service is `enabled`, so it starts at login; the tray is
autostarted via `~/.config/autostart/phnx-drive-sync-tray.desktop` and also via
`phnx-drive-sync-tray.service` user unit for resilience. If the engine ever needs
a manual kick, **PHNX Drive Sync (restart engine)** in the application menu (and
on the Desktop) runs `phnx-drive-sync restart` - restarts the service, waits for
the FUSE heartbeat to come back, and reports the result via `notify-send`. If the
sidecar dies while the engine runs, the engine relaunches it automatically within
seconds (see `mount` in `status.json`); the tray's **Sync now** also heals a
degraded mount by restarting the unit.

### Shutdown

On `SIGTERM`/`SIGINT` the engine stops scheduling passes, asks the running pass to
stop, and then **finishes the file operation already in flight** before unmounting
and exiting (the pass stops at the next action boundary, so no upload or download
is cut mid-transfer). It waits up to `PHNX_DRIVE_SYNC_SHUTDOWN_GRACE_MS` for the
pass to unwind; a very large transfer that exceeds that is abandoned safely
(downloads use a `.part` temp file and resume, uploads re-run) rather than
blocking logout forever.

### Sync cadence and the watcher

A full remote walk of the current tree (~10.3k nodes, 1.27k folders) takes ~5 min
warm, so it runs **once at login** (the initial pass), and afterwards only when
the event stream reports a gap and asks for a resync. Everything else is
incremental: the watcher (inotifywait) and the remote event stream trigger passes
within seconds of a change, and *Sync now* forces one on demand. There is no
periodic *full* walk.

The watcher is a fast path, not a guarantee: if `inotifywait` is missing or
crashes, the event stream is unavailable, or the kernel's inotify watch limit
truncates coverage, the engine falls back to a low-frequency **safety poll**
(`PHNX_DRIVE_SYNC_POLL_MS`, default 2 min) that runs an incremental pass. While
the watcher is healthy the poll stays silent. inotify-tools `-r` also watches
directories created or moved into the tree after startup, so new subtrees are
covered without a restart.

### Auth failures

Auth failures surface in `status.json` as `auth-required` and in the tray icon,
and recover either automatically (a token refresh) or after a re-login plus a
restart. The full behavior, the session states and the recovery steps are in
[Authentication and sessions](#authentication-and-sessions).

### Offline

At login with no network the engine still mounts `~/Proton Drive` (placeholders
are served from the baseline db), reports `offline` in `status.json`, and retries
the API with backoff instead of exiting - so the unit stays `active` and there is
no systemd restart loop. Opening an online-only file returns `ENETDOWN`
immediately; once connectivity returns the engine finishes the API handshake and
runs one reconciling pass. See [Offline behavior](#offline-behavior).

## Development

```sh
bun run deps                        # install vendored dependency trees (cli + SDK + account SDK)
./node_modules/.bin/tsc -p tsconfig.json   # type-check: strict, noEmit
bun test test/                      # classify/placeholder/evict/offline/connectivity unit tests (temp state)
./phnx-drive-sync.sh once --dry-run    # classify without changing anything
test/sidecar/run.sh                 # build the FUSE sidecar and run its characterization suite (real mounts)
(cd sidecar && cargo test)          # sidecar unit tests
xvfb-run -a python3 -m unittest discover -s test/gui  # GUI unit tests (widget tests need a display)
xvfb-run -a python3 gui/phnx-drive-sync-gui.py --self-check  # headless GUI smoke
ruff check .                        # lint the Python GUI, tray and tests
npx markdownlint-cli2               # lint the Markdown docs
bash packaging/build.sh             # build the portable release tarball into dist/
```

`packaging/build.sh` compiles `src/index.ts` and the login CLI into self-contained
binaries (Bun runtime + all modules embedded, glibc 2.17+) and the FUSE sidecar
into a static musl binary (needs a Rust toolchain and a musl C compiler, e.g.
`musl-tools`), assembles the runtime
resources, and emits `dist/phnx-drive-sync-<version>-linux-<arch>.tar.gz`, a
per-architecture manifest fragment `dist/latest-<arch>.json`, and a legacy
single-arch `dist/latest.json`. The release workflow merges the fragments into the
arch-aware `latest.json` that `phnx-drive-sync update` consumes
(`packaging/merge-manifests.mjs`). The release version comes from the root
`package.json`.

## Known caveats

- One engine instance at a time (pid lock, single writer).
- Through the mount a full-tree `find` takes ~6 s (vs ~50 ms on the raw tree): one
  FUSE lookup+getattr round-trip per node. Interactive access is unaffected (stat
  ~ 5 ms, bulk reads > 750 MB/s, `du` ~55 ms per folder).
- `once --dry-run` writes only harmless metadata (event id, status, log); the
  baseline table is untouched until a real pass executes.
- Directory renames propagate as mkdir + child renames + trash cascade.
- Empty directories are synced (Proton supports them).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup and pull-request checklist, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations. For security
issues, follow [SECURITY.md](SECURITY.md) and report privately. Released changes
are listed in [CHANGELOG.md](CHANGELOG.md).

## License

This project is licensed under the MIT License. Copyright (c) 2026 PHNX Studios.
See [LICENSE](LICENSE). It is a personal, non-commercial open-source project
published by PHNX Studios.

It bundles the official Proton Drive SDK (developed by Proton AG, MIT) and the Bun
runtime, and embeds the JavaScript dependencies of both into the compiled
binaries. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the summary and
the operational rules that apply to third-party clients of Proton's hosted
services; the generated `THIRD_PARTY_LICENSES.txt` (shipped in each release) lists
every embedded package with its license text.

PHNX Drive Sync is an independent, unofficial application and is not affiliated
with or supported by Proton AG.
