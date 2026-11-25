#!/usr/bin/env bash
set -euo pipefail

results=$(mktemp)
trap 'rm -f "$results"' EXIT

# Fresh Jest processes bound memory. Shard 3 repeatedly stalls in-band.
for shard in 1 2 3 4 5 6; do
  : > "$results"
  workers=--runInBand
  if [[ "$shard" == 3 ]]; then workers=--maxWorkers=2; fi
  yarn test "$workers" --shard="$shard/6" --json --outputFile="$results"
  node scripts/ci/assert-jest-complete.mjs "$results"
done
