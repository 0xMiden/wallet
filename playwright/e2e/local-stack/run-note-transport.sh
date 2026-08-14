#!/usr/bin/env bash
# Build (cached) + run the note-transport service on 127.0.0.1:57292.
# Reads NOTE_TRANSPORT_REPO / NOTE_TRANSPORT_REF from versions.env.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$here/versions.env"
work="${RUNNER_TEMP:-/tmp}/note-transport"
if [ ! -x "$work/target/release/miden-note-transport-node-bin" ]; then
  rm -rf "$work"; git clone --depth 1 --branch "$NOTE_TRANSPORT_REF" "$NOTE_TRANSPORT_REPO" "$work"
  ( cd "$work" && cargo build --release --locked --bin miden-note-transport-node-bin )
fi
# Build-only mode, used by the cache-warming workflow on main: it needs the
# compiled artifact in the cache, not a running service (there is no node for it
# to talk to there). Keeping this in the same script means the warm build and the
# PR build can never drift to different refs or flags.
if [ "${NOTE_TRANSPORT_BUILD_ONLY:-}" = "1" ]; then
  echo "note-transport built (build-only mode); not starting"
  exit 0
fi
"$work/target/release/miden-note-transport-node-bin" &
echo $! > "${RUNNER_TEMP:-/tmp}/note-transport.pid"
# Wait for the port (defaults 127.0.0.1:57292, :memory: sqlite — no flags)
for _ in $(seq 1 60); do nc -z 127.0.0.1 57292 && exit 0; sleep 1; done
echo "note-transport did not open :57292" >&2; exit 1
