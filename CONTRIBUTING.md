# Contributing to PHNX Drive Sync

Thanks for your interest in improving PHNX Drive Sync. This is an independent,
unofficial project and is not affiliated with Proton AG.

## Ground rules

- Be respectful. This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Keep changes focused. One logical change per pull request.
- Never commit secrets, session tokens, personal paths, or a real `state.db`.
- Do not weaken the sync safety invariants. The behavior is documented in the
  README under "Conflict policy" and "Files on demand".
- `main` is protected: changes land through a pull request and the CI checks
  (type-check, unit tests, GUI, lint, FUSE sidecar and the release build) must
  pass; force-pushes are rejected.

## Development setup

Requirements: [Bun](https://bun.sh) >= 1.4.2 and a [Rust](https://rustup.rs)
toolchain (the FUSE sidecar in `sidecar/`). Release builds also need the musl
target and a musl C compiler (`rustup target add x86_64-unknown-linux-musl`;
Debian/Ubuntu: `musl-tools`). Everything else is installed at runtime by the
packaged installer.

```sh
git clone https://github.com/PHNX-Studios/phnx-drive-sync.git
cd phnx-drive-sync

# install the vendored dependency trees (cli + SDK + account SDK)
bun run deps

# type-check (strict, noEmit)
./node_modules/.bin/tsc -p tsconfig.json

# unit tests (scoped: a bare `bun test` also walks the vendored SDK tests)
bun test test/

# GUI unit tests and a headless smoke (widget tests need a display)
xvfb-run -a python3 -m unittest discover -s test/gui
xvfb-run -a python3 gui/phnx-drive-sync-gui.py --self-check

# FUSE sidecar: unit tests, lints, then the characterization suite (builds the
# release binary and mounts temp dirs; needs fuse3). From a snap-confined
# terminal the suite re-runs itself in an unconfined systemd --user unit, since
# fusermount3 cannot mount from there.
(cd sidecar && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
test/sidecar/run.sh

# lint the Python GUI, tray and tests
ruff check .

# classify only, change nothing
./phnx-drive-sync.sh once --dry-run

# build the portable release tarball into dist/
bash packaging/build.sh
```

## Pull request checklist

- [ ] `tsc -p tsconfig.json` is clean (strict).
- [ ] `bun test test/` passes.
- [ ] If the FUSE sidecar changed: `cargo fmt`, `cargo clippy -D warnings` and
      `cargo test` are clean in `sidecar/`, and `test/sidecar/run.sh` passes.
- [ ] `ruff check .` is clean (Python GUI, tray and tests).
- [ ] New behavior has tests where practical (`test/`).
- [ ] README updated if user-visible behavior changes.
- [ ] No personal paths, credentials, or machine-specific values committed.
- [ ] All added text uses plain hyphens, not en/em dashes.

## Commit messages

Write a short imperative subject line, e.g. `sync: fix dir-cascade trash`. Add a
body when the change needs context; explain the "why", not just the "what".

## Reporting bugs and security issues

- Bugs and feature requests: open a GitHub issue.
- Security vulnerabilities: **do not** open a public issue. See
  [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE), the same license as the project.
