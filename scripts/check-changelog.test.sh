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

# advance_base <dir> <line> <text>: origin/main gains a commit inserting <text> after <line>, and HEAD
# stays where it was on a new branch, as a pull request branched before the base moved on.
advance_base() {
  local base
  base=$(git -C "$1" rev-parse HEAD)
  insert_after "$1" "$2" "$3"
  git -C "$1" commit -q -am 'the base moves on'
  git -C "$1" update-ref refs/remotes/origin/main HEAD
  git -C "$1" checkout -q -b pr "$base"
}

# strip_final_newline <dir>: drop the CHANGELOG's final newline.
strip_final_newline() {
  printf '%s' "$(cat "$1/CHANGELOG.md")" > "$1/CHANGELOG.tmp"
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
expect 2 'a base ref that does not exist does not pass' "$r" BASE_REF=no-such-branch

r=$(new_repo)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
expect 2 'no release tag to compare against does not pass' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
shim=$(mktemp -d "$work/shim.XXXXXX")
printf '#!/bin/sh\nexit 2\n' > "$shim/awk"
chmod +x "$shim/awk"
expect 2 'a failing awk does not pass' "$r" PATH="$shim:$PATH"

# --- the diff is not parsed, so git config and the final newline change nothing ---
r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
insert_after "$r" '- [FIX][all] Released entry (#2).' '- [FIX][all] Misplaced (#11).'
expect 1 'a misplaced entry next to another edit fails under diff.interHunkContext' "$r" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.interHunkContext GIT_CONFIG_VALUE_0=10

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
strip_final_newline "$r"
expect 0 'dropping the final newline with a correct entry passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
strip_final_newline "$r"
expect 1 'a change to the final newline alone is no change' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
printf '\n' >> "$r/CHANGELOG.md"
git -C "$r" commit -q -am 'a trailing blank line'
git -C "$r" update-ref refs/remotes/origin/main HEAD
expect 1 'a file ending in a blank line, unchanged, fails as unchanged' "$r"

# --- headings and sections as the release notes read them ---
r=$(new_repo v1.15.12 v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$(printf '\n\t## 1.15.12 (2026-07-01)\n\n%s' "$ENTRY")"
expect 1 'an entry under a tab-led released heading fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$(printf '\n---\n\n%s' "$ENTRY")"
expect 1 'an entry after a --- line, in no section, fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$(printf '\n---\n\nSee the release page.')"
expect 0 'prose after a --- line passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '# Changelog' "$(printf '\n## 1.17 (TBD)\n\n%s' "$ENTRY")"
expect 1 'an entry under a heading with no X.Y.Z version fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '# Changelog' "$(printf '\n## 1.16.3 (2026-09-30)\n\n%s' "$ENTRY")"
expect 1 'two headings with one version and different suffixes fail as duplicates' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '# Changelog' "$(printf '\n## 1.16.3 (TBD)\n\n%s' "$ENTRY")"
expect 1 'the no changelog label does not waive a duplicate version' "$r" NO_CHANGELOG_LABEL=true

r=$(new_repo v1.15.13 v1.15.14 v1.16.2 v1.16.3)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
expect 1 'an entry under a top (TBD) heading whose version is already tagged fails' "$r"

# --- the merge base, not the base tip ---
r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
advance_base "$r" '- [FIX][all] Open entry (#1).' '- [FIX][all] Landed on the base (#12).'
expect 1 'a pull request with no CHANGELOG change fails after the base moved on' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
advance_base "$r" '- [FIX][all] Open entry (#1).' '- [FIX][all] Landed on the base (#12).'
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
expect 0 'a correct entry passes after the base moved on' "$r"

# --- a comparison that fails exits 2: the shim fails only the call carrying the latest release ---
r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Open entry (#1).' "$ENTRY"
real_awk=$(command -v awk)
shim=$(mktemp -d "$work/shim.XXXXXX")
printf '#!/bin/sh\ncase "$*" in *latest=*) exit 3 ;; esac\nexec %s "$@"\n' "$real_awk" > "$shim/awk"
chmod +x "$shim/awk"
expect 2 'a comparison that fails exits 2, not 0' "$r" PATH="$shim:$PATH"

# --- a released entry stays under its version, however it is moved ---
r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
replace_line "$r" '## 1.15.13 (TBD)' '## 1.16.4 (TBD)'
expect 1 'renaming a released stale (TBD) heading to a new version fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '## 1.16.2 (2026-09-24)' "$(printf '\n## 1.16.4 (TBD)')"
expect 1 'a new heading inserted inside a released section fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
delete_line "$r" '- [FIX][all] Released entry (#2).'
insert_after "$r" '- [FIX][all] Open entry (#1).' '- [FIX][all] Released entry (#2).'
expect 1 'a released entry cut and pasted under the open section fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
delete_line "$r" '## 1.15.14 (2026-07-29)'
expect 1 'deleting a released heading so its entries join the released section above fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
delete_line "$r" '## 1.16.2 (2026-09-24)'
expect 1 'deleting a released heading so its entries join the open section above fails' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '- [FIX][all] Released entry (#2).' '- [FIX][all] Second released entry (#5).'
git -C "$r" commit -q -am 'two released entries'
git -C "$r" update-ref refs/remotes/origin/main HEAD
delete_line "$r" '- [FIX][all] Released entry (#2).'
insert_after "$r" '- [FIX][all] Second released entry (#5).' '- [FIX][all] Released entry (#2).'
expect 0 'reordering released entries inside their section passes' "$r"

r=$(new_repo v1.15.13 v1.15.14 v1.16.2)
insert_after "$r" '# Changelog' "$(printf '\n## 1.16.4 (TBD)\n')"
delete_line "$r" '- [FIX][all] Open entry (#1).'
insert_after "$r" '## 1.16.4 (TBD)' "$(printf '\n- [FIX][all] Open entry (#1).')"
expect 0 'moving an entry between unreleased sections passes' "$r"

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
