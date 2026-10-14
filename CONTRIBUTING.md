# Contributing to PHNX Drive Sync

Thanks for your interest in improving PHNX Drive Sync. This is an independent,
unofficial project and is not affiliated with Proton AG.

## Ground rules

- Be respectful. This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Keep changes focused. One logical change per pull request.
- Never commit secrets, session tokens, personal paths, or a real `state.db`.
- Do not weaken the sync safety invariants. The behavior is documented in the
  README under "Conflict policy" and "Files on demand".

## Development setup

Requirements: [Bun](https://bun.sh) >= 1.4.2. Everything else is installed at
runtime by the packaged installer.

```sh
git clone https://github.com/PHNX-Studios/phnx-drive-sync.git
cd phnx-drive-sync

# install the vendored dependency trees (cli + SDK + account SDK)
bun run deps

# type-check (strict, noEmit)
./node_modules/.bin/tsc -p tsconfig.json

# unit tests (scoped: a bare `bun test` walks the ~930 vendored SDK tests)
bun test test/

# classify only, change nothing
./phnx-drive-sync.sh once --dry-run

# build the portable release tarball into dist/
bash packaging/build.sh
```

## Pull request checklist

- [ ] `tsc -p tsconfig.json` is clean (strict).
- [ ] `bun test test/` passes.
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
