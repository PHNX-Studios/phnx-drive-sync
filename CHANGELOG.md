# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- File manager GUI (`phnx-drive-sync-gui`): a GTK4 + Libadwaita window over the
  `~/Proton Drive` mount with per-file sync status (online-only, on this device,
  pending), folder navigation, open, keep-on-this-device, free up space
  (selection and all-local-files), new folder, rename, move to trash, Sync now,
  a recall-on-hover toggle and an ignore-filters editor.
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

[Unreleased]: https://github.com/PHNX-Studios/phnx-drive-sync/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PHNX-Studios/phnx-drive-sync/releases/tag/v0.2.0
