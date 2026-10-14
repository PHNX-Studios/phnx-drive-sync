# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT `LICENSE` (PHNX Studios), `THIRD_PARTY_NOTICES.md`, and a build-generated
  `THIRD_PARTY_LICENSES.txt` covering the bundled Proton Drive SDK, the Bun
  runtime, and every embedded dependency.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and a GitHub Actions
  CI workflow (type-check, scoped unit tests, and release-tarball build).
- A third-party disclosure printed by `login` and an unofficial-application
  disclaimer in the README.

### Changed

- `install.sh` requires the license and notice files to be present in the
  release directory and installs them.
- `package.json` is no longer private and uses the vendored TypeScript for
  `typecheck`.

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
  portable `install.sh`, and `phnx-drive-sync update` with SHA-256
  verification and host-version gates.
- Graceful shutdown that finishes the in-flight file operation before exiting.

[Unreleased]: https://github.com/PHNX-Studios/phnx-drive-sync/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PHNX-Studios/phnx-drive-sync/releases/tag/v0.2.0
