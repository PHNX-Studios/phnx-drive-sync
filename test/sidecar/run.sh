#!/usr/bin/env bash
# Run the sidecar characterization suite.
#
# From a snap-confined shell (e.g. the VS Code snap's terminal) fusermount3 cannot
# mount, so the suite is re-run in a transient, unconfined systemd --user unit -
# the same reason the engine spawns the sidecar under systemd.
#
# Usage:  test/sidecar/run.sh [unittest args...]
#   PHNX_SIDECAR_CMD="path/to/binary"  test/sidecar/run.sh   # test another build
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../.." && pwd)"

# the default binary under test: (re)build it so the suite never runs a stale one
if [ -z "${PHNX_SIDECAR_CMD:-}" ] && [ -z "${PHNX_SIDECAR_UNCONFINED:-}" ]; then
    cargo build --release --quiet --manifest-path "$ROOT/sidecar/Cargo.toml"
fi

label="$(tr -d '\0' </proc/self/attr/current 2>/dev/null || true)"
if [[ "$label" == snap.* ]] && [ -z "${PHNX_SIDECAR_UNCONFINED:-}" ]; then
    props=(--setenv=PHNX_SIDECAR_UNCONFINED=1 --setenv=HOME="$HOME")
    for var in PHNX_SIDECAR_CMD PHNX_SIDECAR_SHOW_LOG; do
        [ -n "${!var:-}" ] && props+=(--setenv="$var=${!var}")
    done
    exec systemd-run --user --pipe --wait --quiet --same-dir "${props[@]}" \
        bash "$HERE/run.sh" "$@"
fi

cd "$ROOT"
exec python3 -m unittest discover -s test/sidecar -p 'test_*.py' "$@"
