#!/usr/bin/env bash
set -euo pipefail

results=$(mktemp)
trap 'rm -f "$results"' EXIT

# Fresh Jest processes bound memory and avoid the worker pool's incomplete runs.
for shard in 1 2 3 4 5 6; do
  : > "$results"
  yarn test --runInBand --shard="$shard/6" --json --outputFile="$results"
  node scripts/ci/assert-jest-complete.mjs "$results"
done
