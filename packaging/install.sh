#!/usr/bin/env bash
# Proton Drive Sync - portable installer and upgrader.
#
# Run from the extracted release directory (this file sits next to the runtime):
#
#   ./install.sh [--force] [--no-system-deps] [--enable-autoupdate|--disable-autoupdate]
#
# Everything installs under $HOME. The only elevated step is installing a small
# set of host packages (fuse3, python3, GTK/AppIndicator, ...) with the system
# package manager; skip it with --no-system-deps and the engine still runs
# (degrading files-on-demand and/or the tray when those pieces are absent).
#
# The only manual step afterwards is signing in to Proton Drive:
#   proton-drive-sync login

set -euo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

FORCE=0
INSTALL_SYSDEPS=1
AUTOUPDATE=""

print_help() {
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=1 ;;
        --no-system-deps) INSTALL_SYSDEPS=0 ;;
        --enable-autoupdate) AUTOUPDATE=enable ;;
        --disable-autoupdate) AUTOUPDATE=disable ;;
        --help | -h) print_help; exit 0 ;;
        *) echo "install.sh: unknown option: $1" >&2; exit 64 ;;
    esac
    shift
done

APP="proton-drive-sync"
LIB="$HOME/.local/lib/$APP"
BIN="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/$APP"
UNIT_DIR="$HOME/.config/systemd/user"
AUTOSTART_DIR="$HOME/.config/autostart"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
NAUTILUS_DIR="$HOME/.local/share/nautilus/scripts/Proton Drive"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
PYDIR="$DATA_HOME/drive-sync/python"

log() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() {
    printf '%s\n' "$*" >&2
    exit 1
}

[ -f "$SELF_DIR/VERSION" ] || die "install.sh: VERSION missing; run from the extracted release directory"
[ -x "$SELF_DIR/proton-drive-sync-engine" ] || die "install.sh: proton-drive-sync-engine missing; run from the extracted release directory"
NEW_VERSION="$(cat "$SELF_DIR/VERSION")"

# --- version guard (no-op on equal, refuse downgrade) --------------------
ver_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | tail -n1)" = "$1" ]; }
installed_version() { if [ -f "$LIB/VERSION" ]; then cat "$LIB/VERSION"; else printf '0.0.0'; fi; }

OLD_VERSION="$(installed_version)"
if [ "$FORCE" -eq 0 ] && [ -f "$LIB/VERSION" ]; then
    if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
        log "$APP $OLD_VERSION is already installed (use --force to reinstall)."
        exit 0
    fi
    if ver_gt "$OLD_VERSION" "$NEW_VERSION"; then
        warn "$APP $OLD_VERSION is newer than this package ($NEW_VERSION); refusing to downgrade (use --force to override)."
        exit 1
    fi
    log "Upgrading $APP $OLD_VERSION -> $NEW_VERSION"
fi

# --- distro / package manager detection ----------------------------------
PKG_MGR=""
for m in apt-get dnf zypper pacman yum; do
    if command -v "$m" >/dev/null 2>&1; then
        PKG_MGR="$m"
        break
    fi
done

case "$PKG_MGR" in
    apt-get) PKG_FAM=debian ;;
    dnf | yum) PKG_FAM=rpm ;;
    zypper) PKG_FAM=suse ;;
    pacman) PKG_FAM=arch ;;
    *) PKG_FAM=unknown ;;
esac

case "$PKG_FAM" in
    debian)
        CORE_PKGS="fuse3 python3 python3-gi inotify-tools libglib2.0-bin gvfs libnotify-bin gnome-keyring"
        APPIND_CANDIDATES="gir1.2-ayatanaappindicator3-0.1 gir1.2-appindicator3-0.1 libayatana-appindicator3-1"
        PY_PKGS="python3-pyfuse3 python3-trio python3-cffi"
        ;;
    rpm)
        CORE_PKGS="fuse3 python3 python3-gobject inotify-tools glib2 gvfs libnotify gnome-keyring"
        APPIND_CANDIDATES="libayatana-appindicator-gtk3 typelib(AyatanaAppIndicator3)"
        PY_PKGS="python3-pyfuse3 python3-trio python3-cffi"
        ;;
    suse)
        CORE_PKGS="fuse3 python3 python3-gobject inotify-tools glib2 gvfs libnotify gnome-keyring"
        APPIND_CANDIDATES="libayatana-appindicator3-1 typelib(AyatanaAppIndicator3)"
        PY_PKGS="python3-pyfuse3 python3-trio python3-cffi"
        ;;
    arch)
        CORE_PKGS="fuse3 python python-gobject inotify-tools glib2 gvfs libnotify gnome-keyring"
        APPIND_CANDIDATES="libayatana-appindicator"
        PY_PKGS="python-pyfuse3 python-trio python-cffi"
        ;;
    *)
        CORE_PKGS=""
        APPIND_CANDIDATES=""
        PY_PKGS=""
        ;;
esac

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then SUDO="sudo"
    elif command -v doas >/dev/null 2>&1; then SUDO="doas"
    elif command -v pkexec >/dev/null 2>&1; then SUDO="pkexec"
    fi
fi

# If sudo would prompt but there is no terminal, skip quietly rather than emit a
# burst of failing package-manager calls (the runtime still installs and runs).
if [ "$INSTALL_SYSDEPS" -eq 1 ] && [ "$SUDO" = sudo ] && [ ! -t 0 ] && ! sudo -n true 2>/dev/null; then
    warn "sudo requires a password and no terminal is available; skipping system dependency install."
    INSTALL_SYSDEPS=0
fi

pkg_install_all() {
    case "$PKG_MGR" in
        apt-get) $SUDO apt-get install -y --no-install-recommends "$@" ;;
        dnf | yum) $SUDO "$PKG_MGR" install -y "$@" ;;
        zypper) $SUDO zypper --non-interactive install "$@" ;;
        pacman) $SUDO pacman -S --noconfirm --needed "$@" ;;
        *) return 1 ;;
    esac
}

# Install a single package, tolerating name differences across distro versions.
pkg_try() {
    pkg_install_all "$1" >/dev/null 2>&1 || warn "  (could not install optional package: $1)"
}

if [ "$INSTALL_SYSDEPS" -eq 1 ]; then
    log "Checking host dependencies ($PKG_FAM)..."
    if [ -z "$PKG_MGR" ] || [ "$PKG_FAM" = unknown ]; then
        warn "Unknown package manager; skipping automatic dependency install."
        warn "For files-on-demand install: fuse3, python3, inotify-tools, gtk3 + AppIndicator, gvfs, libnotify, gnome-keyring."
    elif [ -z "$SUDO" ] && [ "$(id -u)" -ne 0 ]; then
        warn "No sudo/doas/pkexec; skipping system dependency install."
    else
        # shellcheck disable=SC2086
        if ! pkg_install_all $CORE_PKGS; then
            warn "Some host packages did not install together; retrying individually."
            for p in $CORE_PKGS; do pkg_try "$p"; done
        fi
        # AppIndicator: only one of the candidate names exists per distro version.
        for p in $APPIND_CANDIDATES; do pkg_try "$p"; done
        for p in $PY_PKGS; do pkg_try "$p"; done
    fi
fi

# --- Python sidecar deps fallback (files-on-demand) ----------------------
# Probe including the engine's own PYTHONPATH (deps may already live there).
if command -v python3 >/dev/null 2>&1 && ! PYTHONPATH="$PYDIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'import pyfuse3, trio, cffi' >/dev/null 2>&1; then
    log "Installing Python sidecar dependencies into $PYDIR ..."
    mkdir -p "$PYDIR"
    PIP_ARGS=(--target "$PYDIR" --upgrade)
    if [ -d "$SELF_DIR/python/wheels" ]; then
        PIP_ARGS+=(--no-index --find-links "$SELF_DIR/python/wheels")
    fi
    if python3 -m pip --version >/dev/null 2>&1; then
        if ! python3 -m pip install "${PIP_ARGS[@]}" -r "$SELF_DIR/python/requirements.txt"; then
            warn "pip install failed; files-on-demand may be unavailable (the mount will degrade)."
        fi
    else
        warn "python3-pip not available; install pyfuse3/trio/cffi via your package manager for files-on-demand."
    fi
fi

# --- detect a usable systemd user session (wiring + safe upgrade) ---------
SYSTEMD_USER=0
if command -v systemctl >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "${XDG_RUNTIME_DIR}/systemd/private" ]; then
    SYSTEMD_USER=1
fi

# --- deploy runtime -------------------------------------------------------
log "Installing $APP $NEW_VERSION -> $LIB"
mkdir -p "$BIN" "$CONFIG_DIR" "$UNIT_DIR" "$AUTOSTART_DIR" "$APPS_DIR" "$ICON_DIR" "$NAUTILUS_DIR"

# stop the units before swapping the runtime: a restarted engine must never see
# a half-copied libdir (its mount monitor could relaunch the sidecar mid-copy)
if [ "$SYSTEMD_USER" -eq 1 ]; then
    systemctl --user stop proton-drive-sync-tray.service proton-drive-sync.service 2>/dev/null || true
fi

# app code only; user state lives under ~/.local/{share,state}/drive-sync and is never touched
rm -rf "$LIB"
mkdir -p "$LIB"
cp -a "$SELF_DIR/proton-drive-sync-engine" "$LIB/"
[ -f "$SELF_DIR/proton-drive" ] && cp -a "$SELF_DIR/proton-drive" "$LIB/"
cp -a "$SELF_DIR/python" "$LIB/"
cp -a "$SELF_DIR/tray" "$LIB/"
cp -a "$SELF_DIR/assets" "$LIB/"
cp -a "$SELF_DIR/README.md" "$LIB/README.md" 2>/dev/null || true
printf '%s\n' "$NEW_VERSION" > "$LIB/VERSION"

install -m 0755 "$SELF_DIR/proton-drive-sync-engine" "$LIB/proton-drive-sync-engine"
ln -sfn "$LIB/proton-drive-sync-engine" "$BIN/proton-drive-sync"
install -m 0755 "$SELF_DIR/share/bin/proton-drive-sync-tray" "$BIN/proton-drive-sync-tray"

# per-user env (never clobber an existing one)
if [ ! -f "$CONFIG_DIR/env" ]; then
    cat > "$CONFIG_DIR/env" <<EOF
# Proton Drive Sync environment (read by proton-drive-sync.service).
# Defaults are baked into the engine; uncomment to override.
PROTON_DRIVE_CACHE_DIR=$DATA_HOME/drive-sync/proton-cache
PROTON_DRIVE_LOG_LEVEL=WARN
# DRIVE_SYNC_NEW_FILES=online
# DRIVE_SYNC_EVICT_FREE_GB=5
# DRIVE_SYNC_PREFETCH=off
EOF
fi

# --- systemd units, autostart, icons, context menu ------------------------
install -m 0644 "$SELF_DIR/share/systemd/user/proton-drive-sync.service" "$UNIT_DIR/"
install -m 0644 "$SELF_DIR/share/systemd/user/proton-drive-sync-tray.service" "$UNIT_DIR/"
install -m 0644 "$SELF_DIR/share/systemd/user/proton-drive-sync-update.service" "$UNIT_DIR/"
install -m 0644 "$SELF_DIR/share/systemd/user/proton-drive-sync-update.timer" "$UNIT_DIR/"

render() {
    # escape chars that are special in a sed replacement (& = match, | = delimiter)
    local esc
    esc="$(printf '%s' "$HOME" | sed 's/[&|\\]/\\&/g')"
    sed "s|@HOME@|$esc|g" "$1" >"$2"
}
render "$SELF_DIR/share/autostart/proton-drive-sync-tray.desktop.in" "$AUTOSTART_DIR/proton-drive-sync-tray.desktop"
render "$SELF_DIR/share/proton-drive-sync-restart.desktop.in" "$APPS_DIR/proton-drive-sync-restart.desktop"
[ -d "$HOME/Desktop" ] && render "$SELF_DIR/share/proton-drive-sync-restart.desktop.in" "$HOME/Desktop/proton-drive-sync-restart.desktop" || true

install -m 0644 "$SELF_DIR/assets/proton-drive-sync.svg" "$ICON_DIR/proton-drive-sync.svg"
install -m 0755 "$SELF_DIR/share/nautilus-scripts/Proton Drive/Free up Space" "$NAUTILUS_DIR/"
install -m 0755 "$SELF_DIR/share/nautilus-scripts/Proton Drive/Keep on This Device" "$NAUTILUS_DIR/"

# remove artifacts from the pre-rename layout
rm -f "$BIN/drive-sync" "$BIN/drive-sync-tray" "$BIN/drive-sync-tray-wait" \
    "$AUTOSTART_DIR/drive-sync-tray.desktop" \
    "$APPS_DIR/drive-sync-restart.desktop" \
    "$HOME/Desktop/drive-sync-restart.desktop" \
    "$ICON_DIR/drive-sync.svg" \
    "$UNIT_DIR/drive-sync.service" "$UNIT_DIR/drive-sync-tray.service" 2>/dev/null || true

# --- activate -------------------------------------------------------------
if [ "$SYSTEMD_USER" -eq 1 ]; then
    systemctl --user daemon-reload
    systemctl --user enable proton-drive-sync.service proton-drive-sync-tray.service >/dev/null 2>&1 || true
    systemctl --user restart proton-drive-sync.service proton-drive-sync-tray.service ||
        warn "could not (re)start the units; run: systemctl --user restart proton-drive-sync"
    case "$AUTOUPDATE" in
        enable) systemctl --user enable --now proton-drive-sync-update.timer >/dev/null 2>&1 || true ;;
        disable) systemctl --user disable --now proton-drive-sync-update.timer >/dev/null 2>&1 || true ;;
    esac
else
    warn "No systemd user session detected; start the engine manually with: $BIN/proton-drive-sync run"
fi

log ""
log "$APP $NEW_VERSION installed."
log "The only manual step is signing in to Proton Drive:"
log "  $BIN/proton-drive-sync login"
log ""
log "Status:  $BIN/proton-drive-sync status"
log "Logs:    journalctl --user -u proton-drive-sync.service -f"
