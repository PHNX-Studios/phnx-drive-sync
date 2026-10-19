# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-19

### Added

- Offline handling for online-only files. When the engine knows it is offline
  (a kernel link probe, the SDK's `transfersPaused`/`transfersResumed` events, or
  a classified network failure), opening a placeholder fails immediately with
  `ENETDOWN` ("Network is down") instead of hanging through the SDK's retries and
  returning `EIO`. Renaming/trashing a placeholder and `pin` fail fast the same
  way (nothing is mutated), recall-on-hover drops while offline, the offline
  state surfaces in `status.json` (`offline`, `offlineSince`), the tray and GUI,
  and a reconciling full pass runs automatically when connectivity returns.
- The mount no longer depends on connectivity: at login offline the engine mounts
  first and retries the API with backoff, so the unit stays active (no systemd
  restart loop), placeholders stay browsable, and recovery is automatic.

### Changed

- New environment variables: `PHNX_DRIVE_SYNC_CONNECTIVITY_POLL_MS`,
  `PHNX_DRIVE_SYNC_RECONNECT_MIN_MS`, `PHNX_DRIVE_SYNC_RECONNECT_MAX_MS`,
  `PHNX_DRIVE_SYNC_OFFLINE_NOTIFY_COOLDOWN_MS`, and the sidecar RPC timeouts
  `PHNX_DRIVE_SYNC_RPC_CONNECT_TIMEOUT_S` / `PHNX_DRIVE_SYNC_RPC_RESPONSE_TIMEOUT_S`.

## [0.4.0] - 2026-10-16

### Changed

- Environment overrides move to the `PHNX_DRIVE_SYNC_*` prefix; every historical
  `DRIVE_SYNC_*` name is kept as a deprecated alias (the canonical name wins),
  across the engine, the FUSE sidecar, the GUI and the systemd env file, so an
  existing `~/.config/phnx-drive-sync/env` keeps working unchanged.

## [0.3.2] - 2026-10-15

### Fixed

- File manager GUI context menu: the item actions (Keep on this device, Free up
  space, Open, Rename, Move to trash and the background actions) now reliably
  fire. The menu is rendered from real buttons that activate the window's `win.*`
  actions directly, instead of a `Gtk.PopoverMenu` model whose actions a popover
  parented to a `Gtk.ColumnView` cell did not always resolve.

## [0.3.1] - 2026-10-15

### Changed

- File manager GUI live status: each entry's status badge (and size/mtime) now
  repaints in place whenever the engine reports a change, instead of only when
  the user navigates or acts through the GUI. The engine publishes a monotonic
  `revision` in `status.json`, bumped at the end of every pass and after every
  mutating RPC; the GUI watches it and re-reads the visible folder, preserving
  the selection and scroll position. During a long pass it also re-reads at a
  short cadence so files settle as they sync.

## [0.3.0] - 2026-10-15

### Added

- File manager GUI (`phnx-drive-sync-gui`): a GTK4 + Libadwaita window over the
  `~/Proton Drive` mount with per-file sync status (online-only, on this device,
  pending), folder navigation, open, keep-on-this-device, free up space
  (selection and all-local-files), new folder, rename, move to trash, Sync now,
  a recall-on-hover toggle and an ignore-filters editor.
- File manager GUI right-click context menu for files and folders: Open, Keep on
  this device, Free up space, Rename and Move to trash, plus a background menu
  (New folder, Sync now, Free up space for all local files, Edit ignore filters).
  Items adapt to the selection and engine-dependent items are hidden while the
  sync engine is stopped.
- Engine RPC `list` (read-only per-directory status for the GUI) and `sync`
  (trigger an incremental pass without depending on systemd/SIGUSR1).

### Changed

- `install.sh` installs GTK4 + Libadwaita and the GUI launcher and desktop entry.
- Tray menu: all actions are now top level (the Actions submenu is gone), with a
  new **Open PHNX Drive Sync** item that launches the file manager GUI alongside
  **Sync now**, Open folder, Show last log and Free up space.
- State and data now live under `phnx-drive-sync` (`~/.local/share/phnx-drive-sync`,
  `~/.local/state/phnx-drive-sync`), matching the app/lib/config/unit names.
  Existing `drive-sync` directories are migrated in place on upgrade, so the
  baseline, placeholders, keep-marks, real tree and SDK cache carry over.

## [0.2.0] - 2026-10-14

First public release.

### Added

- Bidirectional sync between `~/Proton Drive` and Proton Drive, built on the
  official Proton Drive SDK, with a three-way baseline diff, rename pairing,
  conflict copies (local wins, remote preserved), and `.protonignore` filters.
- Files on demand: a FUSE mount with visible placeholders that materialize on
  open (OneDrive-style recall), plus `pin` / `unpin` / `evict`,
  keep-on-this-device marks, optional auto-evict on low disk, and
  recall-on-hover prefetch.
- Nautilus cloud/check badges and context-menu scripts; a tray icon with sync
  status, storage, and Free up space.
- Single self-updating release tarball: a compiled engine and login CLI, a
  portable `install.sh`, and `phnx-drive-sync update` with SHA-256 verification
  and host-version gates.
- Arch-aware release manifest: the updater selects the artifact matching the
  running architecture (`x86_64`, `aarch64`).
- Graceful shutdown that finishes the in-flight file operation before exiting.
- MIT `LICENSE` (PHNX Studios), `THIRD_PARTY_NOTICES.md`, and a build-generated
  `THIRD_PARTY_LICENSES.txt` covering the bundled Proton Drive SDK, the Bun
  runtime, and every embedded dependency.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and GitHub Actions CI
  (type-check, scoped unit tests, and release-tarball builds for x86_64 and
  aarch64).

### Changed

- `install.sh` requires the license and notice files to be present in the
  release directory and installs them.
- `package.json` is no longer private and uses the vendored TypeScript for
  `typecheck`.

[Unreleased]: https://github.com/PHNX-Studios/phnx-drive-sync/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/PHNX-Studios/phnx-drive-sync/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/PHNX-Studios/phnx-drive-sync/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/PHNX-Studios/phnx-drive-sync/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/PHNX-Studios/phnx-drive-sync/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PHNX-Studios/phnx-drive-sync/releases/tag/v0.2.0
