#!/usr/bin/env bash
set -euo pipefail

results=$(mktemp)
trap 'rm -f "$results"' EXIT

# Fresh Jest processes bound memory.
for shard in 1 2 3 4 5 6 7; do
  : > "$results"
  bash scripts/ci/run-jest-shard.sh "$shard" 7 --runInBand --json --outputFile="$results"
  node scripts/ci/assert-jest-complete.mjs "$results"
done
