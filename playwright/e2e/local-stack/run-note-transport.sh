#!/usr/bin/env bash
# Build (cached) + run the note-transport service on 127.0.0.1:57292.
# Reads NOTE_TRANSPORT_REPO / NOTE_TRANSPORT_REF from versions.env.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$here/versions.env"
work="${RUNNER_TEMP:-/tmp}/note-transport"

# The binary's NAME depends on the pinned ref, so resolve it rather than hardcode:
# up to v0.5.0-alpha.1 `bin/node` had no explicit `[[bin]]`, so the binary took the
# package name `miden-note-transport-node-bin`; v0.5.0-rc.1 added
# `[[bin]] name = "miden-note-transport-node"`. Hardcoding either one turns a pin bump
# into `error: no bin target named ... in default-run packages` at E2E time.
bin_name_for() {
  if grep -qE '^\s*name\s*=\s*"miden-note-transport-node"' "$1/bin/node/Cargo.toml" 2>/dev/null; then
    echo miden-note-transport-node
  else
    echo miden-note-transport-node-bin
  fi
}

# Cached build: accept whichever name the cache holds. Safe to accept either,
# because the cargo cache key hashes versions.env (see the e2e workflows), so a
# restored target/ is always the one built from the currently pinned ref.
cached=""
for candidate in miden-note-transport-node miden-note-transport-node-bin; do
  [ -x "$work/target/release/$candidate" ] && cached="$work/target/release/$candidate" && break
done

if [ -z "$cached" ]; then
  rm -rf "$work"
  # Authenticate when a token is available: an anonymous clone from a CI runner started failing
  # with `could not read Username for 'https://github.com'`, which git reports when the server
  # declines the request, not only when a repo is private. Falls back to anonymous locally.
  clone_cfg=()
  if [ -n "${GH_TOKEN:-}" ]; then
    clone_cfg=(-c "http.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")
  fi
  git clone "${clone_cfg[@]}" --depth 1 --branch "$NOTE_TRANSPORT_REF" "$NOTE_TRANSPORT_REPO" "$work"
  bin_name="$(bin_name_for "$work")"
  ( cd "$work" && cargo build --release --locked --bin "$bin_name" )
  cached="$work/target/release/$bin_name"
  if [ ! -x "$cached" ]; then
    echo "note-transport: cargo reported success but produced no $bin_name" >&2
    echo "  (ref $NOTE_TRANSPORT_REF; bin targets in bin/node/Cargo.toml:)" >&2
    grep -A2 '\[\[bin\]\]' "$work/bin/node/Cargo.toml" >&2 || true
    exit 1
  fi
fi
# Build-only mode, used by the cache-warming workflow on main: it needs the
# compiled artifact in the cache, not a running service (there is no node for it
# to talk to there). Keeping this in the same script means the warm build and the
# PR build can never drift to different refs or flags.
if [ "${NOTE_TRANSPORT_BUILD_ONLY:-}" = "1" ]; then
  echo "note-transport built (build-only mode); not starting"
  exit 0
fi
"$cached" &
echo $! > "${RUNNER_TEMP:-/tmp}/note-transport.pid"
# Wait for the port (defaults 127.0.0.1:57292, :memory: sqlite — no flags)
for _ in $(seq 1 60); do nc -z 127.0.0.1 57292 && exit 0; sleep 1; done
echo "note-transport did not open :57292" >&2; exit 1
