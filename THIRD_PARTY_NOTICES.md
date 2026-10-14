# Third-Party Notices

Proton Drive Sync (`proton-drive-sync`) is an independent, unofficial project
released under the MIT License (see [LICENSE](./LICENSE)). It is **not
affiliated with, endorsed by, or supported by Proton AG**.

Proton Drive Sync is a personal, non-commercial open-source project published by
PHNX Studios. It relies on the Proton Drive SDK's allowance for personal,
non-commercial projects and is not offered for commercial or production use.

The project redistributes and/or links against the following third-party
components. Their licenses apply to those components; the notices below are
provided to satisfy their attribution terms.

## Proton Drive SDK (`vendor/`)

The source tree under `vendor/` is the official Proton Drive SDK, developed by
Proton AG.

- License: MIT
- Copyright: Copyright (c) 2025-2026 Proton AG
- Full text: [`vendor/LICENSE.md`](./vendor/LICENSE.md)
- Upstream: https://github.com/ProtonDriveApps/sdk

The SDK is vendored because the runtime resolves its TypeScript sources directly
(see `tsconfig.json` `paths`), and the release build embeds the SDK (including
its WebAssembly crypto module) into the compiled engine and login CLI binaries.

### Proton hosted-service terms are separate from the code license

The MIT license covers use of the SDK source code only. Access to Proton's
hosted services (including Proton Drive) is governed by Proton's terms of
service, independent of this license. In particular, this application follows
the SDK's integration rules:

- It sends an honest `x-pm-appversion` header and does not masquerade as an
  official Proton first-party client.
- It talks only to official Proton endpoints.
- It syncs via the Drive event stream rather than polling or repeated full-tree
  traversals.

## Bun runtime

The single-file binaries produced by `packaging/build.sh` embed the Bun runtime.

- License: MIT
- Copyright: Copyright (c) Bun contributors
- Upstream: https://github.com/oven-sh/bun

## Embedded JavaScript dependencies

The compiled binaries embed the npm dependencies of `vendor/cli` (and the
vendored SDK), including but not limited to `@boltffi/runtime`, `@noble/hashes`,
`comlink`, `ttag`, and their transitive dependencies. Each package retains its
own license.

The full license identifier and, where available, the license text of every
package in the vendored dependency tree is generated at build time into
[`THIRD_PARTY_LICENSES.txt`](./THIRD_PARTY_LICENSES.txt) and shipped in the
release tarball (and installed alongside this file). That generated file is the
authoritative list for a given release.

The Python sidecar dependencies (`pyfuse3`, `trio`, `cffi`) are **not**
redistributed with this project: `install.sh` installs them from the host
distribution's packages or from PyPI into the user's home directory. Their
licenses are handled by their respective upstreams.

## Generating a full dependency list

[`THIRD_PARTY_LICENSES.txt`](./THIRD_PARTY_LICENSES.txt) is produced by
`packaging/collect-licenses.mjs`, which `packaging/build.sh` runs automatically.
To regenerate it by hand:

```sh
cd vendor/cli && bun install --frozen-lockfile && cd ../..
bun packaging/collect-licenses.mjs THIRD_PARTY_LICENSES.txt vendor/cli/node_modules
```

This file should be regenerated whenever `vendor/` is refreshed to a new SDK
release.
