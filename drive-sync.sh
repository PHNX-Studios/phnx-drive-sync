#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="$HOME/.local/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PROTON_DRIVE_CACHE_DIR="${PROTON_DRIVE_CACHE_DIR:-$HOME/.local/share/drive-sync/proton-cache}"
export PROTON_DRIVE_LOG_LEVEL="${PROTON_DRIVE_LOG_LEVEL:-WARN}"
exec bun run "$HOME/Projects/drive-sync/src/index.ts" "$@"
