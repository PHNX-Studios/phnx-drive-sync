#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="$HOME/.local/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PROTON_DRIVE_CACHE_DIR="${PROTON_DRIVE_CACHE_DIR:-$HOME/.local/share/drive-sync/proton-cache}"
export PROTON_DRIVE_LOG_LEVEL="${PROTON_DRIVE_LOG_LEVEL:-WARN}"

# Manual recovery used by the "Drive Sync (restart engine)" desktop launcher.
if [ "${1:-}" = "restart" ]; then
    if systemctl --user restart drive-sync.service; then
        notify-send -a "Drive Sync" "Drive Sync" "Engine restarted" 2>/dev/null || true
    else
        notify-send -a "Drive Sync" -u critical "Drive Sync" "Engine restart failed — check: systemctl --user status drive-sync" 2>/dev/null || true
        exit 1
    fi
    exit 0
fi

exec bun run "$HOME/Projects/drive-sync/src/index.ts" "$@"
