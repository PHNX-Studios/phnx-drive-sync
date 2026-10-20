#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="$HOME/.local/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PROTON_DRIVE_CACHE_DIR="${PROTON_DRIVE_CACHE_DIR:-$HOME/.local/share/phnx-drive-sync/proton-cache}"
export PROTON_DRIVE_LOG_LEVEL="${PROTON_DRIVE_LOG_LEVEL:-WARN}"

# Every mode, `restart` included, is handled by the engine itself (src/index.ts):
# its restart waits on the sidecar heartbeat at the configured state dir.

# location-relative so the same script runs from the SSD checkout (dev) and
# from the installed copy at ~/.local/lib/phnx-drive-sync (systemd/autostart);
# readlink -f also covers invocation via the ~/.local/bin/phnx-drive-sync symlink
here="$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd)"
exec bun run "$here/src/index.ts" "$@"
