#!/usr/bin/env bash
set -euo pipefail

shard=$1
shards=$2
shift 2

# The extended dApp suite repeatedly preceded incomplete shared Jest runs.
if [[ "$shard" == "$shards" ]]; then
  selection=(--runTestsByPath src/lib/miden/back/dapp.extended.test.ts)
else
  selection=(
    "--shard=$shard/$((shards - 1))"
    '--testPathPatterns=^(?!(?:.*[/])?src[/]lib[/]miden[/]back[/]dapp[.]extended[.]test[.]ts$)'
  )
fi

yarn test --reporters=default --reporters="$PWD/scripts/ci/jest-suite-start.cjs" "${selection[@]}" "$@"
