#!/usr/bin/env bash

set -euo pipefail

# Behavioural cover for scripts/select-e2e-changes.sh.
#
# Every case below asserts what the SELECTOR decides, not what git does: an earlier version of
# this file asserted that `git diff --no-renames` lists both sides of a rename, which no change
# to this repository can falsify. The cases are chosen so that each of these mutants turns the
# suite red - all of them passed the earlier version:
#   (a) initialising `selected=true`
#   (b) deleting the earn arm            (d) swapping the earn and guardian arms
#   (c) deleting the guardian arm        (e) deleting `src/*` from the shared block
#                                        (f) deleting `playwright/e2e/helpers/*`
# (e) and (f) matter most: dropping a shared entry is the largest fail-open in the script,
# because every source-only pull request would then skip both suites.

repo_root=$(cd "$(dirname "$0")/.." && pwd)
selector="$repo_root/scripts/select-e2e-changes.sh"
failures=0

# Counters live in a file: each check runs in a subshell, where a variable increment is lost.
tally=$(mktemp)
trap 'rm -f "$tally"' EXIT
printf '0\n' > "$tally"

# expect <suite> <expected-exit> <path>...
expect() {
  local suite=$1 want=$2 got=0
  shift 2
  printf '%s\n' "$@" | bash "$selector" "$suite" || got=$?
  if [ "$got" -eq "$want" ]; then
    printf 'ok   %-9s exit=%s  %s\n' "$suite" "$got" "$*"
  else
    printf 'FAIL %-9s exit=%s want=%s  %s\n' "$suite" "$got" "$want" "$*"
    printf '%s\n' "$(( $(cat "$tally") + 1 ))" > "$tally"
  fi
}

# --- the skip path: the whole point of the change, and previously unasserted anywhere ---
expect earn     1 docs/x.md CHANGELOG.md
expect guardian 1 docs/x.md CHANGELOG.md

# --- differential selection: a suite-only path must select ONLY its own suite (mutants b, c, d) ---
expect guardian 0 playwright/e2e/tests/guardian-switch.spec.ts
expect earn     1 playwright/e2e/tests/guardian-switch.spec.ts
expect earn     0 playwright/e2e/tests/earn/earn-deposit.spec.ts
expect guardian 1 playwright/e2e/tests/earn/earn-deposit.spec.ts

# --- the guardian suite collects `**/guardian-*.spec.ts` recursively, so the selector must too.
# Each of these four is run today by guardian-lifecycle-e2e and by no other pre-merge gate. ---
for spec in guardian-conflict-retry guardian-consume-transient-5xx \
            guardian-offline-direct-switch guardian-switch-transient-5xx; do
  expect guardian 0 "playwright/e2e/tests/resilience/$spec.spec.ts"
  expect earn     1 "playwright/e2e/tests/resilience/$spec.spec.ts"
done

# --- the shared block: these must select for BOTH suites (mutants a, e, f).
# The four src/ and helpers/ paths are the ones whose per-suite arms were deleted as dead;
# they keep passing here, which is what makes that deletion provably a no-op. ---
expect earn     0 src/lib/epoch/x.ts
expect guardian 0 src/lib/epoch/x.ts
expect earn     0 src/screens/earn-flow/x.tsx
expect guardian 0 src/screens/onboarding/x.tsx
expect earn     0 playwright/e2e/helpers/epoch-x.ts
expect guardian 0 playwright/e2e/helpers/epoch-x.ts
expect guardian 0 .github/actions/run-local-node/action.yml
# scripts/report-flaky-e2e.mjs is executed with no `|| true` by the gated jobs themselves.
expect earn     0 scripts/report-flaky-e2e.mjs
expect guardian 0 scripts/report-flaky-e2e.mjs

# --- a bad suite name must be distinguishable from "skip", because the workflow's
# `[ "$status" -eq 1 ] || exit "$status"` guard depends on it ---
expect bogus 2 src/lib/x.ts

# --- a moved file must count as both a deletion and an addition, which is what
# `git diff --no-renames` in the workflow provides ---
expect guardian 0 src/lib/shared.ts docs/shared.ts

failures=$(cat "$tally")
if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf '\nall checks passed\n'
