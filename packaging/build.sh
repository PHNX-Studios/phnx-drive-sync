#!/usr/bin/env bash
# Build a single, portable, self-contained release tarball for PHNX Drive Sync.
#
# Output (in dist/):
#   phnx-drive-sync-<version>-linux-<arch>.tar.gz
#   latest.json            (release manifest consumed by `phnx-drive-sync update`)
#
# The tarball contains the engine compiled to a self-contained glibc-2.17 binary
# (Bun runtime + all node_modules + SDK WASM embedded), the FUSE sidecar as a
# static musl binary (no libc dependency at all), the bundled login CLI, the
# Python tray/GUI sources, assets, units and install.sh.
#
# Usage:  packaging/build.sh
# Env:    BUN=/path/to/bun   CARGO=/path/to/cargo   RELEASE_BASE_URL=https://host/path
# Needs:  a Rust toolchain with the <arch>-unknown-linux-musl target and a musl C
#         compiler for the bundled SQLite (Debian/Ubuntu: musl-tools).
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
SIDECAR_VERSION="$(sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' sidecar/Cargo.toml | head -n1)"
[ "$SIDECAR_VERSION" = "$VERSION" ] ||
    { echo "build: sidecar/Cargo.toml is $SIDECAR_VERSION but package.json is $VERSION; bump both" >&2; exit 1; }

case "$(uname -m)" in
    x86_64 | amd64) TARGET=x64; TARBALL_ARCH=x86_64 ;;
    aarch64 | arm64) TARGET=arm64; TARBALL_ARCH=aarch64 ;;
    *) echo "build: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
RUST_TARGET="$TARBALL_ARCH-unknown-linux-musl"

CARGO="${CARGO:-}"
if [ -z "$CARGO" ]; then
    if command -v cargo >/dev/null 2>&1; then CARGO="$(command -v cargo)"
    elif [ -x "$HOME/.cargo/bin/cargo" ]; then CARGO="$HOME/.cargo/bin/cargo"
    else echo "build: cargo not found (https://rustup.rs); the FUSE sidecar is required" >&2; exit 1; fi
fi

NAME="phnx-drive-sync-$VERSION-linux-$TARBALL_ARCH"
STAGE="dist/$NAME"
TARBALL="dist/$NAME.tar.gz"

echo "build: $NAME (bun target bun-linux-$TARGET)"

# The vendored packages are not bun workspaces, so each dependency tree is
# installed on its own. This matters for the SDK's own deps (e.g. @boltffi/runtime
# resolves from vendor/client/js/node_modules, not vendor/cli's).
for depdir in vendor/cli vendor/client/js vendor/incubating/account/js; do
    if [ ! -d "$depdir/node_modules" ]; then
        echo "build: installing $depdir dependencies"
        ( cd "$depdir" && "$BUN" install --frozen-lockfile )
    fi
done

rm -rf dist
mkdir -p "$STAGE"

# --- engine: self-contained single-file executable -----------------------
echo "build: compiling engine"
"$BUN" build ./src/index.ts \
    --compile \
    --target="bun-linux-$TARGET" \
    --minify \
    --outfile "$STAGE/phnx-drive-sync-engine"

# --- FUSE sidecar: static musl binary ---------------------------------------
echo "build: compiling FUSE sidecar ($RUST_TARGET)"
if command -v rustup >/dev/null 2>&1; then
    rustup target add "$RUST_TARGET" >/dev/null
fi
# the bundled SQLite is C: cc-rs looks for <arch>-linux-musl-gcc, while distros
# ship the musl wrapper as plain musl-gcc
CC_VAR="CC_${RUST_TARGET//-/_}"
if [ -z "${!CC_VAR:-}" ] && ! command -v "$TARBALL_ARCH-linux-musl-gcc" >/dev/null 2>&1; then
    command -v musl-gcc >/dev/null 2>&1 ||
        { echo "build: no musl C compiler (install musl-tools / musl-gcc)" >&2; exit 1; }
    export "$CC_VAR=musl-gcc"
fi
"$CARGO" build --release --locked --manifest-path sidecar/Cargo.toml --target "$RUST_TARGET"
SIDECAR_BIN="sidecar/target/$RUST_TARGET/release/phnx-drive-sync-fuse"
# must not depend on the host libc: that is the whole point of the musl build.
# (ldd is no judge: it exits 0 on the static-PIE binaries the musl target makes.)
if readelf -lW "$SIDECAR_BIN" | grep -q 'Requesting program interpreter' ||
    readelf -dW "$SIDECAR_BIN" | grep -q '(NEEDED)'; then
    echo "build: $SIDECAR_BIN is dynamically linked; expected a static binary" >&2
    exit 1
fi
install -m 0755 "$SIDECAR_BIN" "$STAGE/phnx-drive-sync-fuse"

# --- official login CLI (best effort; enables `phnx-drive-sync login`) --
JS_VERSION="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' vendor/client/js/package.json | head -n1)"
if [ -f vendor/cli/scripts/build-cli.mjs ]; then
    echo "build: compiling login CLI"
    # build-cli.mjs resolves its entry relative to vendor/cli, so run it there
    # and point the output at an absolute path.
    if ! ( cd vendor/cli && CLI_OUTPUT_DIR="$ROOT/$STAGE" CLI_VERSION="$VERSION" JS_VERSION="${JS_VERSION:-0.0.1}" \
        "$BUN" scripts/build-cli.mjs src/proton-drive.ts "bun-linux-$TARGET" >/dev/null ); then
        echo "build: WARNING: login CLI build failed; 'phnx-drive-sync login' will require a system proton-drive" >&2
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

cp -a tray "$STAGE/"
cp -a gui "$STAGE/"
cp -a assets "$STAGE/"

cp -a packaging/systemd/user/phnx-drive-sync.service \
      packaging/systemd/user/phnx-drive-sync-tray.service \
      packaging/systemd/user/phnx-drive-sync-update.service \
      packaging/systemd/user/phnx-drive-sync-update.timer \
      "$STAGE/share/systemd/user/"

cp -a packaging/desktop/phnx-drive-sync-restart.desktop.in "$STAGE/share/"
cp -a packaging/desktop/phnx-drive-sync-gui.desktop.in "$STAGE/share/"
cp -a packaging/desktop/phnx-drive-sync-tray.desktop.in "$STAGE/share/autostart/"

cp -a packaging/bin/phnx-drive-sync-tray "$STAGE/share/bin/"
cp -a packaging/bin/phnx-drive-sync-gui "$STAGE/share/bin/"
cp -a "tray/nautilus-scripts/Proton Drive/." "$STAGE/share/nautilus-scripts/Proton Drive/"

cp -a packaging/install.sh "$STAGE/install.sh"
cp -a README.md "$STAGE/README.md"
# license + third-party attributions must travel with every distributed copy
cp -a LICENSE THIRD_PARTY_NOTICES.md "$STAGE/"

# full license texts for every package embedded in the compiled binaries
if "$BUN" packaging/collect-licenses.mjs "$STAGE/THIRD_PARTY_LICENSES.txt" vendor/cli/node_modules; then
    :
else
    echo "build: WARNING: could not collect embedded dependency licenses" >&2
fi
# ... and every crate statically linked into the sidecar
if ! "$BUN" packaging/collect-crate-licenses.mjs "$CARGO" sidecar/Cargo.toml "$RUST_TARGET" \
    >>"$STAGE/THIRD_PARTY_LICENSES.txt"; then
    echo "build: WARNING: could not collect the sidecar's crate licenses" >&2
fi
chmod +x "$STAGE/install.sh" "$STAGE/phnx-drive-sync-engine" "$STAGE/phnx-drive-sync-fuse"
[ -x "$STAGE/proton-drive" ] && chmod +x "$STAGE/proton-drive"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

# drop build cruft that must not ship
find "$STAGE" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -type f \( -name '*.pyc' -o -name '*.map' \) -delete 2>/dev/null || true

# --- archive + release manifest ------------------------------------------
echo "build: packing $TARBALL"
tar -C dist -czf "$TARBALL" "$NAME"
SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
BASE="${RELEASE_BASE_URL:-https://github.com/PHNX-Studios/phnx-drive-sync/releases/download/v$VERSION}"

# Per-arch fragment: the release job merges these into an arch-aware latest.json
# (see packaging/merge-manifests.mjs).
cat > "dist/latest-$TARBALL_ARCH.json" <<EOF
{
  "version": "$VERSION",
  "arch": "$TARBALL_ARCH",
  "url": "$BASE/$NAME.tar.gz",
  "sha256": "$SHA",
  "min_glibc": "2.17",
  "min_kernel": "3.10",
  "min_python": "3.8"
}
EOF

# Single-arch manifest (legacy shape) for local/dev use; the published release
# uses the merged, arch-aware latest.json.
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
echo "  dist/latest-$TARBALL_ARCH.json"
echo "  sha256: $SHA"
