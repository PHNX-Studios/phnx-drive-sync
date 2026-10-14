# Security Policy

Proton Drive Sync is an independent, unofficial project and is not affiliated
with Proton AG. It handles Proton account credentials, mounts a FUSE filesystem,
and installs a self-updating background service, so security reports are taken
seriously.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the impact, and steps to reproduce.

If private reporting is unavailable, open a minimal issue asking for a private
contact channel and disclose no details in the issue itself.

Please include, where relevant:

- Affected version (`proton-drive-sync version`) and how it was installed.
- Distribution and kernel (`uname -r`), and whether files-on-demand (FUSE) was
  active.
- A proof of concept or a precise reproduction, if you have one.

We aim to acknowledge reports within a few days. This is a volunteer project, so
please be patient with timelines.

## Supported versions

Only the latest published release is supported. Fixes are shipped as a new
release and delivered through the built-in updater.

## Security-relevant surface

The following areas are security-sensitive; reports touching them are especially
welcome:

- **Credential handling.** Login delegates to the official `proton-drive` CLI
  and stores the session in the GNOME keyring. The engine never writes
  credentials to `state.db` or the logs.
- **Update trust model.** `proton-drive-sync update` trusts the configured
  release host over TLS, verifies the release manifest's SHA-256 before running
  the installer, and refuses releases whose `min_glibc` / `min_kernel` /
  `min_python` exceed the host. Reports of a bypass or downgrade path are
  in scope.
- **Local IPC.** `pin` / `unpin` / `evict` / `prefetch` talk to the daemon over a
  Unix domain socket under `$XDG_RUNTIME_DIR`. The socket must not allow other
  local users to act on your files; report any permission or injection issue.
- **FUSE sidecar.** The Python sidecar materializes on-demand files on read. A
  path-traversal or symlink escape out of the real tree is in scope.
- **Installer.** `install.sh` fetches and unpacks host packages into `~/.local`
  when it cannot use the system package manager (no root). Report any case where
  it would execute or install untrusted content.

## Out of scope

- The behavior or availability of Proton's hosted services, which are governed
  by Proton's own terms and security process.
- Vulnerabilities in the vendored Proton Drive SDK itself. Please report those
  upstream at https://github.com/ProtonDriveApps/sdk. We will still bump the
  vendored copy once a fix is available.
