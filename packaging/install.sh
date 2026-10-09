#!/usr/bin/env bash
# Deploy the Proton Drive Sync runtime to the internal disk and (re)wire
# autostart. The SSD checkout stays the dev tree; re-run this after changing
# runtime code there. State (tree/db/logs) already lives under ~/.local and is
# never touched here.
set -euo pipefail

SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$HOME/.local/lib/proton-drive-sync"
BIN="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
AUTOSTART_DIR="$HOME/.config/autostart"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"

command -v rsync >/dev/null || { echo "install.sh: rsync is required" >&2; exit 1; }
command -v bun >/dev/null || [ -x "$HOME/.bun/bin/bun" ] || {
    echo "install.sh: bun not found (needed at runtime via drive-sync.sh)" >&2
    exit 1
}

mkdir -p "$LIB" "$BIN" "$UNIT_DIR" "$AUTOSTART_DIR" "$APPS_DIR" "$ICON_DIR"

echo "install: runtime -> $LIB"
rsync -a --delete "$SRC/src/" "$LIB/src/"
rsync -a --delete "$SRC/python/" "$LIB/python/"
rsync -a --delete "$SRC/tray/" "$LIB/tray/"
rsync -a --delete "$SRC/assets/" "$LIB/assets/"
mkdir -p "$LIB/vendor/cli"
rsync -a --delete "$SRC/vendor/cli/src/" "$LIB/vendor/cli/src/"
rsync -a --delete "$SRC/vendor/cli/node_modules/" "$LIB/vendor/cli/node_modules/"
# runtime imports resolve via tsconfig "paths" into TS sources (not the
# node_modules symlink farm): @protontech/drive-sdk -> vendor/client/js/src,
# proton-drive-sdk-account -> vendor/incubating/account/js/src
cp -f "$SRC/tsconfig.json" "$LIB/tsconfig.json"
cp -f "$SRC/vendor/cli/tsconfig.json" "$LIB/vendor/cli/tsconfig.json"
mkdir -p "$LIB/vendor/client/js" "$LIB/vendor/incubating/account/js"
rsync -a --delete "$SRC/vendor/client/js/src/" "$LIB/vendor/client/js/src/"
rsync -a --delete "$SRC/vendor/incubating/account/js/src/" "$LIB/vendor/incubating/account/js/src/"
# src/version.ts imports ../package.json at runtime
cp -f "$SRC/vendor/client/js/package.json" "$LIB/vendor/client/js/package.json"
cp -f "$SRC/vendor/incubating/account/js/package.json" "$LIB/vendor/incubating/account/js/package.json"
# only unhoisted runtime dep of the client sources (walk-up from
# vendor/client/js/src); everything else is in cli/node_modules
mkdir -p "$LIB/vendor/client/js/node_modules/@boltffi"
rsync -a --delete "$SRC/vendor/client/js/node_modules/@boltffi/runtime/" \
    "$LIB/vendor/client/js/node_modules/@boltffi/runtime/"
cp -f "$SRC/vendor/cli/package.json" "$LIB/vendor/cli/package.json"
cp -f "$SRC/README.md" "$LIB/README.md"
# bun resolves @protontech/* from src/ via this symlink (same as the checkout)
ln -sfn vendor/cli/node_modules "$LIB/node_modules"
install -m 755 "$SRC/proton-drive-sync.sh" "$LIB/proton-drive-sync.sh"

echo "install: launchers -> $BIN"
install -m 755 "$SRC/packaging/bin/proton-drive-sync-tray" "$BIN/proton-drive-sync-tray"
ln -sfn "$LIB/proton-drive-sync.sh" "$BIN/proton-drive-sync"

echo "install: systemd user units + autostart + restart launcher"
install -m 644 "$SRC/packaging/systemd/user/proton-drive-sync.service" "$UNIT_DIR/proton-drive-sync.service"
install -m 644 "$SRC/packaging/systemd/user/proton-drive-sync-tray.service" "$UNIT_DIR/proton-drive-sync-tray.service"
install -m 644 "$SRC/packaging/autostart/proton-drive-sync-tray.desktop" "$AUTOSTART_DIR/proton-drive-sync-tray.desktop"
install -m 644 "$SRC/packaging/proton-drive-sync-restart.desktop" "$APPS_DIR/proton-drive-sync-restart.desktop"
install -m 644 "$SRC/packaging/proton-drive-sync-restart.desktop" "$HOME/Desktop/proton-drive-sync-restart.desktop" 2>/dev/null || true
install -m 644 "$SRC/assets/proton-drive-sync.svg" "$ICON_DIR/proton-drive-sync.svg"
# keep the live Nautilus scripts pointing at the installed launcher (they
# used to hard-code the SSD checkout and broke whenever the tree moved)
NAUTILUS_SCRIPTS="$HOME/.local/share/nautilus/scripts/Proton Drive"
mkdir -p "$NAUTILUS_SCRIPTS"
install -m 755 "$SRC/tray/nautilus-scripts/Proton Drive/Free up Space" "$NAUTILUS_SCRIPTS/Free up Space"
install -m 755 "$SRC/tray/nautilus-scripts/Proton Drive/Keep on This Device" "$NAUTILUS_SCRIPTS/Keep on This Device"

# remove pre-rename artifacts (old names) if present
rm -f "$BIN/drive-sync" "$BIN/drive-sync-tray" "$BIN/drive-sync-tray-wait" \
      "$AUTOSTART_DIR/drive-sync-tray.desktop" \
      "$APPS_DIR/drive-sync-restart.desktop" \
      "$HOME/Desktop/drive-sync-restart.desktop" \
      "$ICON_DIR/drive-sync.svg" \
      "$UNIT_DIR/drive-sync.service" "$UNIT_DIR/drive-sync-tray.service" \
      "$UNIT_DIR/drive-sync.service.bak" "$UNIT_DIR/drive-sync.service.p3.bak"
# superseded: SSD automount was extracted from this project (machine-local,
# see storage-ssd-automount.service) — drop the old project-owned copy
systemctl --user disable --now proton-ssd-automount.service 2>/dev/null || true
rm -f "$UNIT_DIR/proton-ssd-automount.service"
rm -rf "$HOME/.local/lib/drive-sync"

systemctl --user daemon-reload
systemctl --user enable proton-drive-sync.service proton-drive-sync-tray.service
# restart (not just --now) so a re-install picks up the new code; the engine
# remounts the FUSE sidecar itself within seconds
systemctl --user restart proton-drive-sync.service proton-drive-sync-tray.service

echo "install: done — units active:"
systemctl --user is-active proton-drive-sync.service proton-drive-sync-tray.service
