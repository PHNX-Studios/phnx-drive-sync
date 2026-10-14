#!/usr/bin/env bash
# Build a single, portable, self-contained release tarball for Proton Drive Sync.
#
# Output (in dist/):
#   proton-drive-sync-<version>-linux-<arch>.tar.gz
#   latest.json            (release manifest consumed by `proton-drive-sync update`)
#
# The tarball contains the engine compiled to a self-contained glibc-2.17 binary
# (Bun runtime + all node_modules + SDK WASM embedded), the bundled login CLI,
# the Python sidecar/tray sources, assets, units and install.sh.
#
# Usage:  packaging/build.sh
# Env:    BUN=/path/to/bun   RELEASE_BASE_URL=https://host/path
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUN="${BUN:-}"
if [ -z "$BUN" ]; then
    if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)"
    elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"
    else echo "build: bun not found (https://bun.sh)" >&2; exit 1; fi
fi

VERSION="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' package.json | head -n1)"
[ -n "$VERSION" ] || { echo "build: could not read version from package.json" >&2; exit 1; }

case "$(uname -m)" in
    x86_64 | amd64) TARGET=x64; TARBALL_ARCH=x86_64 ;;
    aarch64 | arm64) TARGET=arm64; TARBALL_ARCH=aarch64 ;;
    *) echo "build: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

NAME="proton-drive-sync-$VERSION-linux-$TARBALL_ARCH"
STAGE="dist/$NAME"
TARBALL="dist/$NAME.tar.gz"

echo "build: $NAME (bun target bun-linux-$TARGET)"

# Runtime deps must be installed once (node_modules is a symlink farm in dev).
if [ ! -d vendor/cli/node_modules ]; then
    echo "build: installing vendor/cli dependencies"
    ( cd vendor/cli && "$BUN" install --frozen-lockfile )
fi

rm -rf dist
mkdir -p "$STAGE"

# --- engine: self-contained single-file executable -----------------------
echo "build: compiling engine"
"$BUN" build ./src/index.ts \
    --compile \
    --target="bun-linux-$TARGET" \
    --minify \
    --outfile "$STAGE/proton-drive-sync-engine"

# --- official login CLI (best effort; enables `proton-drive-sync login`) --
JS_VERSION="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' vendor/client/js/package.json | head -n1)"
if [ -f vendor/cli/scripts/build-cli.mjs ]; then
    echo "build: compiling login CLI"
    # build-cli.mjs resolves its entry relative to vendor/cli, so run it there
    # and point the output at an absolute path.
    if ! ( cd vendor/cli && CLI_OUTPUT_DIR="$ROOT/$STAGE" CLI_VERSION="$VERSION" JS_VERSION="${JS_VERSION:-0.0.1}" \
        "$BUN" scripts/build-cli.mjs src/proton-drive.ts "bun-linux-$TARGET" >/dev/null ); then
        echo "build: WARNING: login CLI build failed; 'proton-drive-sync login' will require a system proton-drive" >&2
        rm -f "$STAGE/proton-drive"
    fi
fi

# --- runtime resources ----------------------------------------------------
echo "build: assembling runtime"
mkdir -p \
    "$STAGE/share/systemd/user" \
    "$STAGE/share/autostart" \
    "$STAGE/share/bin" \
    "$STAGE/share/nautilus-scripts/Proton Drive"

cp -a python "$STAGE/"
cp -a tray "$STAGE/"
cp -a assets "$STAGE/"

cp -a packaging/systemd/user/proton-drive-sync.service \
      packaging/systemd/user/proton-drive-sync-tray.service \
      packaging/systemd/user/proton-drive-sync-update.service \
      packaging/systemd/user/proton-drive-sync-update.timer \
      "$STAGE/share/systemd/user/"

cp -a packaging/desktop/proton-drive-sync-restart.desktop.in "$STAGE/share/"
cp -a packaging/desktop/proton-drive-sync-tray.desktop.in "$STAGE/share/autostart/"

cp -a packaging/bin/proton-drive-sync-tray "$STAGE/share/bin/"
cp -a "tray/nautilus-scripts/Proton Drive/." "$STAGE/share/nautilus-scripts/Proton Drive/"

cp -a packaging/install.sh "$STAGE/install.sh"
cp -a README.md "$STAGE/README.md"
# license + third-party attributions must travel with every distributed copy
cp -a LICENSE THIRD_PARTY_NOTICES.md "$STAGE/"
chmod +x "$STAGE/install.sh" "$STAGE/proton-drive-sync-engine"
[ -x "$STAGE/proton-drive" ] && chmod +x "$STAGE/proton-drive"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

# drop build cruft that must not ship
find "$STAGE" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -type f \( -name '*.pyc' -o -name '*.map' \) -delete 2>/dev/null || true

# --- archive + release manifest ------------------------------------------
echo "build: packing $TARBALL"
tar -C dist -czf "$TARBALL" "$NAME"
SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
BASE="${RELEASE_BASE_URL:-https://github.com/proton-drive-sync/proton-drive-sync/releases/download/v$VERSION}"
cat > dist/latest.json <<EOF
{
  "version": "$VERSION",
  "url": "$BASE/$NAME.tar.gz",
  "sha256": "$SHA",
  "min_glibc": "2.17",
  "min_kernel": "3.10",
  "min_python": "3.8"
}
EOF

echo "build: done"
echo "  $TARBALL"
echo "  dist/latest.json"
echo "  sha256: $SHA"
