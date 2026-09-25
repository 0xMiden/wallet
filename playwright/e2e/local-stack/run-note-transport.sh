#!/usr/bin/env bash
# Run the note-transport service on 127.0.0.1:57292 against the local test node.
#
# Since rust-sdk v0.17.0-rc.3 the transport is the node repo's own `miden-note-transport`
# (gRPC `note_transport.Api`), installed by start-test-node.sh with the other node binaries,
# so it is always the build the node and the SDK agree on. The standalone
# note-transport-service repo this used to clone never moved to Miden 0.17: it rejects a 0.17
# note header and does not serve the path the 0.17 SDK calls.
#
# Starts it through the rust-sdk clone's own start-note-transport-bg.sh, which bootstraps an
# empty database, waits for the port, and logs next to the node logs (dumped on failure by
# .github/actions/dump-local-node-logs). Stop it with that clone's stop-note-transport.sh.
set -euo pipefail
clone="${MIDEN_CLIENT_DIR:-${RUNNER_TEMP:-/tmp}/miden-client}"
script="$clone/scripts/start-note-transport-bg.sh"
if [ ! -x "$script" ]; then
  echo "note-transport: $script not found." >&2
  echo "  Start the local node first (it clones rust-sdk at NODE_SRC_REF), or set MIDEN_CLIENT_DIR." >&2
  exit 1
fi
exec "$script"
