#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="$HOME/.local/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PROTON_DRIVE_CACHE_DIR="${PROTON_DRIVE_CACHE_DIR:-$HOME/.local/share/drive-sync/proton-cache}"
export PROTON_DRIVE_LOG_LEVEL="${PROTON_DRIVE_LOG_LEVEL:-WARN}"

# Manual recovery used by the "Drive Sync (restart engine)" desktop launcher.
if [ "${1:-}" = "restart" ]; then
    if systemctl --user restart drive-sync.service; then
        # report success only once the FUSE sidecar is actually beating again —
        # a restarted engine with a dead mount is the failure mode users hit
        mount_ok="$HOME/.local/state/drive-sync/mount-ok"
        for _ in $(seq 1 60); do
            if [ -e "$mount_ok" ] && [ -n "$(find "$mount_ok" -newermt '-15 seconds' -print -quit 2>/dev/null)" ]; then
                notify-send -a "Drive Sync" "Drive Sync" "Engine restarted — Proton Drive mounted" 2>/dev/null || true
                exit 0
            fi
            systemctl --user is-active --quiet drive-sync.service || break
            sleep 1
        done
        notify-send -a "Drive Sync" -u critical "Drive Sync" "Engine restarted, but the FUSE mount did not come up — check: journalctl --user -u drive-sync.service" 2>/dev/null || true
        exit 1
    else
        notify-send -a "Drive Sync" -u critical "Drive Sync" "Engine restart failed — check: systemctl --user status drive-sync" 2>/dev/null || true
        exit 1
    fi
fi

exec bun run "$HOME/Projects/drive-sync/src/index.ts" "$@"
