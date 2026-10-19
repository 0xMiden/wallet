#!/usr/bin/env bash
set -euo pipefail
transport_dir=$(cd -- "$(dirname -- "$0")" && pwd)
test "${GITHUB_ACTIONS:-}" = true
exec python3 "$transport_dir/matrix.py" "$1" "$transport_dir"
