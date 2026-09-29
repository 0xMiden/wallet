#!/usr/bin/env bash

set -euo pipefail

# Behavioural cover for scripts/check-changelog.sh, run end to end: each case builds a throwaway
# repository with a base CHANGELOG, release tags and an `origin/main` ref, edits the working tree
# the way a pull request would, and asserts the gate's exit code. The gate can block every pull
# request in the repository, so the cases include the ways it could wrongly pass: a git or awk
# failure, a missing base ref, no release tags, and a release list sorted as text.

repo_root=$(cd "$(dirname "$0")/.." && pwd)
checker="$repo_root/scripts/check-changelog.sh"

# Counters live in a file: each check runs in a subshell, where a variable increment is lost.
tally=$(mktemp)
work=$(mktemp -d)
trap 'rm -rf "$tally" "$work"' EXIT
printf '0\n' > "$tally"

base_changelog() {
  cat <<'EOF'
# Changelog

## 1.16.3 (TBD)

### Fixes

- [FIX][all] Open entry (#1).

## 1.16.2 (2026-09-24)

### Fixes

- [FIX][all] Released entry (#2).

## 1.15.14 (2026-07-29)

- [FIX][all] Older entry (#3).

## 1.15.13 (TBD)

- [FIX][all] A section that shipped and was never dated (#4).
EOF
}

# new_repo <tag>...: a repository whose origin/main holds the base CHANGELOG, tagged as given.
new_repo() {
  local dir
  dir=$(mktemp -d "$work/repo.XXXXXX")
  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config tag.gpgsign false
  base_changelog > "$dir/CHANGELOG.md"
  git -C "$dir" add CHANGELOG.md
  git -C "$dir" commit -q -m base
  local tag
  for tag in "$@"; do git -C "$dir" tag "$tag"; done
  git -C "$dir" update-ref refs/remotes/origin/main HEAD
  printf '%s\n' "$dir"
}

# insert_after <dir> <line> <text>: put <text> after the first line equal to <line>.
insert_after() {
  AFTER="$2" TEXT="$3" awk '!done && $0 == ENVIRON["AFTER"] { print; print ENVIRON["TEXT"]; done = 1; next } { print }' \
    "$1/CHANGELOG.md" > "$1/CHANGELOG.tmp"
  mv "$1/CHANGELOG.tmp" "$1/CHANGELOG.md"
}

# replace_line <dir> <line> <text>: replace the first line equal to <line> with <text>.
replace_line() {
  FROM="$2" TEXT="$3" awk '!done && $0 == ENVIRON["FROM"] { print ENVIRON["TEXT"]; done = 1; next } { print }' \
    "$1/CHANGELOG.md" > "$1/CHANGELOG.tmp"
  mv "$1/CHANGELOG.tmp" "$1/CHANGELOG.md"
}

# delete_line <dir> <line>: remove the first line equal to <line>.
delete_line() {
  FROM="$2" awk '!done && $0 == ENVIRON["FROM"] { done = 1; next } { print }' "$1/CHANGELOG.md" > "$1/CHANGELOG.tmp"
  mv "$1/CHANGELOG.tmp" "$1/CHANGELOG.md"
}

# expect <want> <case> <dir> [VAR=value]...: run the gate in <dir> and compare its exit status.
# <want> is an exact status, or `nonzero` for "must not pass".
expect() {
  local want=$1 name=$2 dir=$3 got=0
  shift 3
  (cd "$dir" && env BASE_REF=main NO_CHANGELOG_LABEL=false "$@" bash "$checker") > "$work/out" 2>&1 || got=$?
  if [ "$want" = nonzero ] && [ "$got" -ne 0 ] || [ "$want" = "$got" ]; then
    printf 'ok   exit=%s  %s\n' "$got" "$name"
  else
    printf 'FAIL exit=%s want=%s  %s\n' "$got" "$want" "$name"
    sed 's/^/     | /' "$work/out"
    printf '%s\n' "$(( $(cat "$tally") + 1 ))" > "$tally"
  fi
}

ENTRY='- [FIX][all] New entry (#10).'

# --- placement: judged by the heading that governs each added line ---
r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
expect 0 'an entry under the open (TBD) heading passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Released entry (#2).' "$ENTRY"
expect 1 'an entry under a released, dated heading fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] A section that shipped and was never dated (#4).' "$ENTRY"
expect 1 'an entry under a stale (TBD) heading below a dated release fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '# Changelog' "$(printf '\n## 1.16.4 (TBD)\n\n### Fixes\n\n%s' "$ENTRY")"
expect 0 'a pull request opening a new top (TBD) section passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
replace_line "$r" '## 1.16.3 (TBD)' '## 1.16.3 (2026-09-30)'
expect 0 'a release pull request dating its heading passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
replace_line "$r" '## 1.16.3 (TBD)' '## 1.16.3 (2026-09-30)'
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
expect 0 'a release pull request dating its heading and adding an entry under it passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
delete_line "$r" '- [FIX][all] Released entry (#2).'
expect 0 'a pure deletion from a released section passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Released entry (#2).' '   '
expect 0 'a whitespace-only line added in a released section passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '# Changelog' "$(printf '\n%s' "$ENTRY")"
expect 1 'an entry added above every version heading fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '# Changelog' "$(printf '\nEvery user-facing change, newest first.')"
expect 0 'an edit to the preamble passes' "$r"

# --- what counts as released ---
r=$(new_repo v1.15.13 v1.15.14 v1.16.2 v1.16.3-rc.0)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
expect 0 'a release candidate tag does not close its version' "$r"

# A text sort puts v1.9.9 after v1.16.2; the newest release is the highest VERSION.
r=$(new_repo v1.9.9 v1.16.2)
insert_after "$r" '- [FIX][all] Released entry (#2).' "$ENTRY"
expect 1 'the newest release is the highest version, not the last in text order' "$r"

# --- the escape hatch, and the checks the script already made ---
r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Released entry (#2).' "$ENTRY"
expect 0 'the no changelog label waives a misplaced entry' "$r" NO_CHANGELOG_LABEL=true

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
expect 1 'an unchanged CHANGELOG fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '# Changelog' "$(printf '\n## 1.16.3 (TBD)\n\n%s' "$ENTRY")"
expect 1 'a duplicated version heading fails' "$r"

# --- failures must not pass ---
r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
expect nonzero 'a base ref that does not exist does not pass' "$r" BASE_REF=no-such-branch

r=$(new_repo)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
expect nonzero 'no release tag to compare against does not pass' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
shim=$(mktemp -d "$work/shim.XXXXXX")
printf '#!/bin/sh\nexit 2\n' > "$shim/awk"
chmod +x "$shim/awk"
expect nonzero 'a failing awk does not pass' "$r" PATH="$shim:$PATH"

# --- the release notes read sections through the same parser ---
notes="$repo_root/scripts/changelog-notes.sh"

# notes_is <case> <file> <version> <want-status> <want-text>: run the notes script and compare both.
notes_is() {
  local name=$1 file=$2 version=$3 want_status=$4 want=$5 got_status=0 got
  got=$(bash "$notes" "$version" "$file" 2> "$work/notes-err") || got_status=$?
  if [ "$got_status" = "$want_status" ] && [ "$got" = "$want" ]; then
    printf 'ok   exit=%s  %s\n' "$got_status" "$name"
  else
    printf 'FAIL exit=%s want=%s  %s\n' "$got_status" "$want_status" "$name"
    printf '%s\n' "$got" | sed 's/^/     got  | /'
    printf '%s\n' "$want" | sed 's/^/     want | /'
    sed 's/^/     err  | /' "$work/notes-err"
    printf '%s\n' "$(( $(cat "$tally") + 1 ))" > "$tally"
  fi
}

f="$work/notes.md"
printf '%s\n' '# Changelog' '' '## 1.2.6 (TBD)' '' '- open' '' '---' '' '- after the line' '' \
  $'\t## 1.2.5 (2026-01-02)' '' '- tab heading' '' '  ## 1.2.4 (2026-01-01)' '' '### Fixes' '' \
  $'- has\ta tab' '' '## 1.2.4 (again)' '' '- second copy' '' > "$f"
notes_is 'the notes stop at a --- line' "$f" 1.2.6 0 '- open'
notes_is 'the notes read a tab-led heading' "$f" 1.2.5 0 '- tab heading'
notes_is 'the notes take the first section with a version, trimmed' "$f" 1.2.4 0 "$(printf '### Fixes\n\n- has\ta tab')"
notes_is 'keeps a tab inside a line' "$f" 1.2.4 0 "$(printf '### Fixes\n\n- has\ta tab')"
notes_is 'the notes are empty for a version with no section' "$f" 9.9.9 0 ''
notes_is 'the notes cannot read a missing file' "$work/no-such.md" 1.2.4 2 ''
if out=$(bash "$notes" 1.16.2 "$repo_root/CHANGELOG.md") && [ -n "$out" ]; then
  printf 'ok   exit=0  %s\n' "the real CHANGELOG's 1.16.2 notes are non-empty"
else
  printf 'FAIL  %s\n' "the real CHANGELOG's 1.16.2 notes are non-empty"
  printf '%s\n' "$(( $(cat "$tally") + 1 ))" > "$tally"
fi

failures=$(cat "$tally")
if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf '\nall checks passed\n'
