#!/usr/bin/env bash
# PHNX Drive Sync - portable installer and upgrader.
#
# Run from the extracted release directory (this file sits next to the runtime).

set -euo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

FORCE=0
INSTALL_SYSDEPS=1
INSTALL_USERDEPS=1
AUTOUPDATE=""

print_help() {
    cat <<'EOF'
PHNX Drive Sync - portable installer and upgrader.

Run from the extracted release directory (this file sits next to the runtime):

  ./install.sh [--force] [--no-system-deps] [--no-deps]
               [--enable-autoupdate|--disable-autoupdate]

Everything installs under $HOME. Host packages (fuse3, python3, GTK/AppIndicator,
inotify-tools, gvfs, libnotify, gnome-keyring) are installed with the system
package manager when it is available and can be elevated. When it cannot (no
sudo, unknown distro, no network privileges) the two small user-level pieces
that matter most are fetched into ~/.local without root: inotify-tools (the
fast file watcher) and the Ayatana AppIndicator typelib (the tray icon).

  --no-system-deps   skip the elevated package-manager step (user-level fallback still runs)
  --no-deps          install nothing; rely on what is already on the machine
  --force            reinstall even if the same version is present
  --enable-autoupdate / --disable-autoupdate
                     toggle the weekly `phnx-drive-sync update` user timer

The only manual step afterwards is signing in to Proton Drive:
  phnx-drive-sync login
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=1 ;;
        --no-system-deps) INSTALL_SYSDEPS=0 ;;
        --no-deps) INSTALL_SYSDEPS=0; INSTALL_USERDEPS=0 ;;
        --enable-autoupdate) AUTOUPDATE=enable ;;
        --disable-autoupdate) AUTOUPDATE=disable ;;
        --help | -h) print_help; exit 0 ;;
        *) echo "install.sh: unknown option: $1" >&2; exit 64 ;;
    esac
    shift
done

APP="phnx-drive-sync"
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
[ -x "$SELF_DIR/phnx-drive-sync-engine" ] || die "install.sh: phnx-drive-sync-engine missing; run from the extracted release directory"
[ -f "$SELF_DIR/LICENSE" ] || die "install.sh: LICENSE missing; run from the extracted release directory"
[ -f "$SELF_DIR/THIRD_PARTY_NOTICES.md" ] || die "install.sh: THIRD_PARTY_NOTICES.md missing; run from the extracted release directory"
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
        INOTIFY_PKGS="inotify-tools libinotifytools0"
        APPIND_PKGS="gir1.2-ayatanaappindicator3-0.1 libayatana-appindicator3-1 gir1.2-appindicator3-0.1 libappindicator3-1"
        ;;
    rpm)
        CORE_PKGS="fuse3 python3 python3-gobject inotify-tools glib2 gvfs libnotify gnome-keyring"
        APPIND_CANDIDATES="libayatana-appindicator-gtk3 typelib(AyatanaAppIndicator3)"
        PY_PKGS="python3-pyfuse3 python3-trio python3-cffi"
        INOTIFY_PKGS="inotify-tools inotify-tools-libs"
        APPIND_PKGS="libayatana-appindicator-gtk3 libappindicator-gtk3"
        ;;
    suse)
        CORE_PKGS="fuse3 python3 python3-gobject inotify-tools glib2 gvfs libnotify gnome-keyring"
        APPIND_CANDIDATES="libayatana-appindicator3-1 typelib(AyatanaAppIndicator3)"
        PY_PKGS="python3-pyfuse3 python3-trio python3-cffi"
        INOTIFY_PKGS="inotify-tools libinotifytools0"
        APPIND_PKGS="libayatana-appindicator3-1"
        ;;
    arch)
        CORE_PKGS="fuse3 python python-gobject inotify-tools glib2 gvfs libnotify gnome-keyring"
        APPIND_CANDIDATES="libayatana-appindicator"
        PY_PKGS="python-pyfuse3 python-trio python-cffi"
        INOTIFY_PKGS="inotify-tools"
        APPIND_PKGS="libayatana-appindicator"
        ;;
    *)
        CORE_PKGS=""
        APPIND_CANDIDATES=""
        PY_PKGS=""
        INOTIFY_PKGS=""
        APPIND_PKGS=""
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

# --- user-level fallback for host tools we could not install system-wide ---
# Downloading a distro package and unpacking it into ~/.local needs no root.
# The service unit searches ~/.local/bin (PATH) and ~/.local/lib
# (LD_LIBRARY_PATH); the tray launcher searches ~/.local/lib/girepository-1.0.
# Only the two pieces a missing system package would otherwise cost the user
# (the fast watcher and the tray icon) are fetched; the rest degrades on its own.

user_download_pkg() {
    # $1 = package name, $2 = destination directory (no root required)
    local pkg="$1" dir="$2"
    case "$PKG_MGR" in
        apt-get) ( cd "$dir" && apt-get download "$pkg" ) >/dev/null 2>&1 ;;
        dnf) command -v dnf >/dev/null 2>&1 && dnf download --destdir "$dir" "$pkg" >/dev/null 2>&1 ;;
        yum) command -v yumdownloader >/dev/null 2>&1 && yumdownloader --destdir "$dir" "$pkg" >/dev/null 2>&1 ;;
        zypper) zypper --pkg-cache-dir "$dir" --non-interactive install --download-only "$pkg" >/dev/null 2>&1 ;;
        pacman) pacman -Sw --noconfirm --cachedir "$dir" "$pkg" >/dev/null 2>&1 ;;
        *) return 1 ;;
    esac
}

user_extract_pkg() {
    # $1 = package archive, $2 = extraction root
    local file="$1" dir="$2"
    mkdir -p "$dir"
    case "$file" in
        *.deb)
            command -v dpkg-deb >/dev/null 2>&1 || return 1
            dpkg-deb -x "$file" "$dir" >/dev/null 2>&1 ;;
        *.rpm)
            command -v rpm2cpio >/dev/null 2>&1 || return 1
            command -v cpio >/dev/null 2>&1 || return 1
            ( cd "$dir" && rpm2cpio "$file" | cpio -idm --quiet ) >/dev/null 2>&1 ;;
        *.pkg.tar.*)
            command -v bsdtar >/dev/null 2>&1 || return 1
            ( cd "$dir" && bsdtar -xf "$file" ) >/dev/null 2>&1 ;;
        *) return 1 ;;
    esac
}

user_have_inotifywait() {
    if command -v inotifywait >/dev/null 2>&1; then return 0; fi
    if [ -x "$HOME/.local/bin/inotifywait" ]; then return 0; fi
    return 1
}

user_install_inotifytools() {
    if user_have_inotifywait; then return 0; fi
    [ -n "$INOTIFY_PKGS" ] || return 0
    log "  fetching inotify-tools into ~/.local (system package unavailable)"
    mkdir -p "$HOME/.local/bin" "$HOME/.local/lib"
    local pkg dir file got=0
    for pkg in $INOTIFY_PKGS; do
        dir="$(mktemp -d)" || continue
        if user_download_pkg "$pkg" "$dir"; then
            file="$(find "$dir" -maxdepth 1 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.pkg.tar.*' \) -print -quit 2>/dev/null)"
            if [ -n "$file" ] && user_extract_pkg "$file" "$dir/x"; then
                find "$dir/x" -type f -name 'inotifywait' -exec install -m 0755 {} "$HOME/.local/bin/" \; 2>/dev/null || true
                find "$dir/x" -name 'libinotifytools.so*' -exec cp -a {} "$HOME/.local/lib/" \; 2>/dev/null || true
                if [ -x "$HOME/.local/bin/inotifywait" ]; then got=1; fi
            fi
        fi
        rm -rf "$dir"
    done
    if [ "$got" -ne 1 ]; then
        warn "  could not fetch inotify-tools; install it for fast change detection (the slow safety poll is used otherwise)."
        return 0
    fi
    if LD_LIBRARY_PATH="$HOME/.local/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$HOME/.local/bin/inotifywait" 2>/dev/null | grep -q 'not found'; then
        warn "  fetched inotifywait has unresolved libraries; fast change detection may be unavailable."
    else
        log "  installed ~/.local/bin/inotifywait"
    fi
}

user_have_appindicator() {
    command -v python3 >/dev/null 2>&1 || return 1
    # Probe under a clean environment: a snap/IDE parent shell can export a
    # polluted GSETTINGS_SCHEMA_DIR / XDG_DATA_DIRS that makes GTK abort while
    # loading settings, which would otherwise look like "the typelib is missing".
    # The probe only needs python3 + GI, so `env -i` is safe here.
    env -i PATH="/usr/bin:/bin" HOME="$HOME" \
        GI_TYPELIB_PATH="$HOME/.local/lib/girepository-1.0" \
        python3 -c 'import gi
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3
except Exception:
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3' >/dev/null 2>&1
}

user_copy_appind_libs() {
    # Copy the implementation libraries only when the system lacks them, so a
    # user-level copy never shadows a system lib through LD_LIBRARY_PATH.
    local root="$1" soname
    for soname in libayatana-appindicator3.so.1 libappindicator3.so.1; do
        if ldconfig -p 2>/dev/null | grep -q "$soname"; then continue; fi
        find "$root" -name "${soname%.so.1}*" -exec cp -a {} "$HOME/.local/lib/" \; 2>/dev/null || true
    done
}

user_install_appindicator() {
    if user_have_appindicator; then return 0; fi
    [ -n "$APPIND_PKGS" ] || return 0
    log "  fetching the AppIndicator typelib into ~/.local (system package unavailable)"
    mkdir -p "$HOME/.local/lib/girepository-1.0" "$HOME/.local/lib"
    local pkg dir file got=0
    for pkg in $APPIND_PKGS; do
        dir="$(mktemp -d)" || continue
        if user_download_pkg "$pkg" "$dir"; then
            file="$(find "$dir" -maxdepth 1 -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.pkg.tar.*' \) -print -quit 2>/dev/null)"
            if [ -n "$file" ] && user_extract_pkg "$file" "$dir/x"; then
                find "$dir/x" -name '*.typelib' -exec cp -a {} "$HOME/.local/lib/girepository-1.0/" \; 2>/dev/null || true
                user_copy_appind_libs "$dir/x"
                got=1
            fi
        fi
        rm -rf "$dir"
    done
    if [ "$got" -ne 1 ]; then
        warn "  could not fetch the AppIndicator typelib; the tray icon will be unavailable."
        return 0
    fi
    if user_have_appindicator; then
        log "  installed the AppIndicator typelib in ~/.local"
    else
        warn "  fetched AppIndicator files but the typelib still does not load; the tray may be unavailable."
    fi
}

if [ "$INSTALL_USERDEPS" -eq 1 ] && [ "$PKG_FAM" != unknown ]; then
    user_install_inotifytools
    user_install_appindicator
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

# --- FUSE readiness (files-on-demand needs the system fuse3 stack) ---------
# Mounting requires the setuid-root fusermount3 helper, which only the system
# fuse3 package can provide (a user-level copy cannot be setuid), so this is the
# one dependency the no-root fallback cannot cover. Report the outcome here
# rather than let the user discover an empty mount later.
fuse_check() {
    local ok=1 hint perms
    case "$PKG_MGR" in
        apt-get) hint="sudo apt install fuse3" ;;
        dnf) hint="sudo dnf install fuse3" ;;
        yum) hint="sudo yum install fuse3" ;;
        zypper) hint="sudo zypper install fuse3" ;;
        pacman) hint="sudo pacman -S fuse3" ;;
        *) hint="install the fuse3 package" ;;
    esac
    if [ ! -e /dev/fuse ]; then
        warn "FUSE: /dev/fuse is missing (the fuse kernel module is not loaded)"
        ok=0
    fi
    if ! command -v fusermount3 >/dev/null 2>&1 && [ ! -x /usr/bin/fusermount3 ] && [ ! -x /bin/fusermount3 ]; then
        warn "FUSE: fusermount3 not installed; the mount needs it  [$hint]"
        ok=0
    fi
    if command -v python3 >/dev/null 2>&1 && ! PYTHONPATH="$PYDIR${PYTHONPATH:+:$PYTHONPATH}" python3 -c 'import pyfuse3' >/dev/null 2>&1; then
        warn "FUSE: pyfuse3 is not importable; install python3-pyfuse3 (or 'pip install --user pyfuse3')"
        ok=0
    fi
    if [ -e /dev/fuse ] && [ "$(id -u)" -ne 0 ]; then
        perms="$(stat -c '%a' /dev/fuse 2>/dev/null || true)"
        if [ "$perms" = "660" ] && ! id -nG 2>/dev/null | tr ' ' '\n' | grep -qx fuse; then
            warn "FUSE: /dev/fuse is group-only; add yourself to the 'fuse' group and re-login  [sudo usermod -aG fuse \"$USER\"]"
            ok=0
        fi
    fi
    if [ "$ok" -eq 1 ]; then
        log "FUSE files-on-demand: ready"
    else
        warn "  The engine still syncs (plain bidirectional sync); ~/Proton Drive stays empty until then (the tray shows 'Mount degraded')."
    fi
}

fuse_check

# --- detect a usable systemd user session (wiring + safe upgrade) ---------
SYSTEMD_USER=0
if command -v systemctl >/dev/null 2>&1 && [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "${XDG_RUNTIME_DIR}/systemd/private" ]; then
    SYSTEMD_USER=1
fi

# --- deploy runtime -------------------------------------------------------
log "Installing $APP $NEW_VERSION -> $LIB"
mkdir -p "$BIN" "$CONFIG_DIR" "$UNIT_DIR" "$AUTOSTART_DIR" "$APPS_DIR" "$ICON_DIR" "$NAUTILUS_DIR"

# escape a path for use as a POSIX ERE (pkill -f treats the pattern as one)
re_escape() { printf '%s' "$1" | sed 's/[][\\{}.^$*+?()|]/\\&/g'; }

# stop the units before swapping the runtime: a restarted engine must never see
# a half-copied libdir (its mount monitor could relaunch the sidecar mid-copy)
if [ "$SYSTEMD_USER" -eq 1 ]; then
    systemctl --user stop phnx-drive-sync-tray.service phnx-drive-sync.service 2>/dev/null || true
    # also retire a pre-rename (proton-drive-sync) install so its daemon cannot
    # keep running alongside the new one after the upgrade
    systemctl --user stop proton-drive-sync-tray.service proton-drive-sync.service \
        proton-drive-sync-update.timer proton-drive-sync-update.service 2>/dev/null || true
    systemctl --user disable proton-drive-sync.service proton-drive-sync-tray.service \
        proton-drive-sync-update.timer 2>/dev/null || true
    # a tray launched via XDG autostart lives outside the unit's cgroup; stop it
    # too, or it keeps the single-instance lock and the freshly installed tray
    # exits. Match the exact installed script path (escaped, not a loose name)
    # so an unrelated shell whose arguments contain the name is never hit.
    if command -v pkill >/dev/null 2>&1; then
        pkill -f "$(re_escape "$HOME/.local/lib/phnx-drive-sync/tray/phnx-drive-sync-tray.py")" 2>/dev/null || true
        pkill -f "$(re_escape "$HOME/.local/lib/proton-drive-sync/tray/proton-drive-sync-tray.py")" 2>/dev/null || true
    fi
fi

# app code only; user state lives under ~/.local/{share,state}/drive-sync and is never touched
rm -rf "$LIB"
mkdir -p "$LIB"
cp -a "$SELF_DIR/phnx-drive-sync-engine" "$LIB/"
[ -f "$SELF_DIR/proton-drive" ] && cp -a "$SELF_DIR/proton-drive" "$LIB/"
cp -a "$SELF_DIR/python" "$LIB/"
cp -a "$SELF_DIR/tray" "$LIB/"
cp -a "$SELF_DIR/assets" "$LIB/"
cp -a "$SELF_DIR/README.md" "$LIB/README.md" 2>/dev/null || true
cp -a "$SELF_DIR/LICENSE" "$LIB/LICENSE"
cp -a "$SELF_DIR/THIRD_PARTY_NOTICES.md" "$LIB/THIRD_PARTY_NOTICES.md"
cp -a "$SELF_DIR/THIRD_PARTY_LICENSES.txt" "$LIB/THIRD_PARTY_LICENSES.txt" 2>/dev/null || true
printf '%s\n' "$NEW_VERSION" > "$LIB/VERSION"

install -m 0755 "$SELF_DIR/phnx-drive-sync-engine" "$LIB/phnx-drive-sync-engine"
ln -sfn "$LIB/phnx-drive-sync-engine" "$BIN/phnx-drive-sync"
install -m 0755 "$SELF_DIR/share/bin/phnx-drive-sync-tray" "$BIN/phnx-drive-sync-tray"

# per-user env (never clobber an existing one)
if [ ! -f "$CONFIG_DIR/env" ]; then
    cat > "$CONFIG_DIR/env" <<EOF
# PHNX Drive Sync environment (read by phnx-drive-sync.service).
# Defaults are baked into the engine; uncomment to override.
PROTON_DRIVE_CACHE_DIR=$DATA_HOME/drive-sync/proton-cache
PROTON_DRIVE_LOG_LEVEL=WARN
# DRIVE_SYNC_NEW_FILES=online
# DRIVE_SYNC_EVICT_FREE_GB=5
# DRIVE_SYNC_PREFETCH=off
EOF
fi

# --- systemd units, autostart, icons, context menu ------------------------
install -m 0644 "$SELF_DIR/share/systemd/user/phnx-drive-sync.service" "$UNIT_DIR/"
install -m 0644 "$SELF_DIR/share/systemd/user/phnx-drive-sync-tray.service" "$UNIT_DIR/"
install -m 0644 "$SELF_DIR/share/systemd/user/phnx-drive-sync-update.service" "$UNIT_DIR/"
install -m 0644 "$SELF_DIR/share/systemd/user/phnx-drive-sync-update.timer" "$UNIT_DIR/"

render() {
    # escape chars that are special in a sed replacement (& = match, | = delimiter)
    local esc
    esc="$(printf '%s' "$HOME" | sed 's/[&|\\]/\\&/g')"
    sed "s|@HOME@|$esc|g" "$1" >"$2"
}
render "$SELF_DIR/share/autostart/phnx-drive-sync-tray.desktop.in" "$AUTOSTART_DIR/phnx-drive-sync-tray.desktop"
render "$SELF_DIR/share/phnx-drive-sync-restart.desktop.in" "$APPS_DIR/phnx-drive-sync-restart.desktop"
[ -d "$HOME/Desktop" ] && render "$SELF_DIR/share/phnx-drive-sync-restart.desktop.in" "$HOME/Desktop/phnx-drive-sync-restart.desktop" || true

install -m 0644 "$SELF_DIR/assets/phnx-drive-sync.svg" "$ICON_DIR/phnx-drive-sync.svg"
install -m 0755 "$SELF_DIR/share/nautilus-scripts/Proton Drive/Free up Space" "$NAUTILUS_DIR/"
install -m 0755 "$SELF_DIR/share/nautilus-scripts/Proton Drive/Keep on This Device" "$NAUTILUS_DIR/"

# remove artifacts from the immediate pre-rename (proton-drive-sync) layout so an
# upgrade never leaves a duplicate launcher, unit, autostart entry or icon behind
rm -f "$BIN/proton-drive-sync" "$BIN/proton-drive-sync-tray" \
    "$AUTOSTART_DIR/proton-drive-sync-tray.desktop" \
    "$APPS_DIR/proton-drive-sync-restart.desktop" \
    "$HOME/Desktop/proton-drive-sync-restart.desktop" \
    "$ICON_DIR/proton-drive-sync.svg" \
    "$UNIT_DIR/proton-drive-sync.service" "$UNIT_DIR/proton-drive-sync-tray.service" \
    "$UNIT_DIR/proton-drive-sync-update.service" "$UNIT_DIR/proton-drive-sync-update.timer" 2>/dev/null || true
rm -rf "$HOME/.local/lib/proton-drive-sync"

# remove artifacts from the older drive-sync layout
rm -f "$BIN/drive-sync" "$BIN/drive-sync-tray" "$BIN/drive-sync-tray-wait" \
    "$AUTOSTART_DIR/drive-sync-tray.desktop" \
    "$APPS_DIR/drive-sync-restart.desktop" \
    "$HOME/Desktop/drive-sync-restart.desktop" \
    "$ICON_DIR/drive-sync.svg" \
    "$UNIT_DIR/drive-sync.service" "$UNIT_DIR/drive-sync-tray.service" 2>/dev/null || true

# --- activate -------------------------------------------------------------
if [ "$SYSTEMD_USER" -eq 1 ]; then
    systemctl --user daemon-reload
    systemctl --user enable phnx-drive-sync.service phnx-drive-sync-tray.service >/dev/null 2>&1 || true
    systemctl --user restart phnx-drive-sync.service phnx-drive-sync-tray.service ||
        warn "could not (re)start the units; run: systemctl --user restart phnx-drive-sync"
    case "$AUTOUPDATE" in
        enable) systemctl --user enable --now phnx-drive-sync-update.timer >/dev/null 2>&1 || true ;;
        disable) systemctl --user disable --now phnx-drive-sync-update.timer >/dev/null 2>&1 || true ;;
    esac
else
    warn "No systemd user session detected; start the engine manually with: $BIN/phnx-drive-sync run"
fi

log ""
log "$APP $NEW_VERSION installed."
log "The only manual step is signing in to Proton Drive:"
log "  $BIN/phnx-drive-sync login"
log ""
log "Status:  $BIN/phnx-drive-sync status"
log "Logs:    journalctl --user -u phnx-drive-sync.service -f"
