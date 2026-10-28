#!/bin/bash
# rev-mutate.sh <session-dir> <test-command>
#   Reverts each changed hunk on its own, keeping every other change in the tree, and runs the
#   test command. A hunk whose revert leaves the command passing is unpinned: no test proves
#   that line. A hunk whose revert turns the command red is pinned, and the first failure line of
#   that run is printed beside it, because "a test noticed" is not what a cluster's Prediction
#   says - it names an assertion or a message, and only the caller holds it to compare.
#   Exits 0 every hunk pinned, 2 the session is not in a phase known to be panel-free,
#   3 an unpinned hunk, 4 the run measured nothing (a command that does not pass on the unmutated
#   tree or stops passing by the end of the run, a hunk that would not apply, a revert that
#   changed no byte, a changed file that is a symlink or has no text hunk, or no changed hunk).
#
#   4 outranks 3: a run that could not revert one hunk has not earned a verdict about the rest.
#   A measurement that did not happen is the failure this tool exists to prevent, because it
#   reads exactly like a real one. So: every revert is proved by hash, and the command is proved
#   to discriminate BOTH before the first revert and again on the restored tree afterwards.
#   Order: baseline run, hunk loop (each hunk restored and verified), closing run.
#
#   It refuses while a panel is live because seats read the live tree, and a script that reverts
#   hunks for seconds at a time shows them a tree that is neither base nor fix.
#
#   Scope: unstaged changes to tracked, non-symlink files under REV_ROOT. Staged and untracked
#   files are named on stderr and not measured. Each hunk is measured against the COMPLETE fix:
#   the file is restored from a backup this run took, never from the commit.
set -u
S=${1:?usage: rev-mutate.sh <session-dir> <test-command>}
CMD=${2:?usage: rev-mutate.sh <session-dir> <test-command>}

[ -f "$S/scope.env" ] || { echo "rev-mutate: no scope.env in $S" >&2; exit 1; }
# shellcheck disable=SC1090
. "$S/scope.env"
ROOT=${REV_ROOT:?rev-mutate: scope.env has no REV_ROOT}

phase=$(python3 - "$S/state.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as handle:
        phase = json.load(handle).get('phase') or 'unknown'
except Exception:
    phase = 'unknown'
print(phase)
PY
) || phase=unknown
# An ALLOWLIST: a spelling this script does not know (fan_out, FAN-OUT, panel, 5, a phase reader
# that died and left this empty) is not evidence that no seat is reading the tree.
case "$phase" in
  fix|triage|verify|commit|done|setup|stack-ready) ;;
  fan-out|collect|plan|repair)
    echo "rev-mutate: refusing while a panel is live (phase=$phase); seats read the live tree" >&2
    exit 2 ;;
  *)
    echo "rev-mutate: refusing: '$phase' is not a phase known to be panel-free, so a live panel cannot be ruled out" >&2
    echo "rev-mutate: record the phase first, e.g. rev-state.sh $S phase=fix" >&2
    exit 2 ;;
esac

cd "$ROOT" || { echo "rev-mutate: cannot enter $ROOT" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "rev-mutate: $ROOT is not a git work tree" >&2; exit 1; }
[ -z "$(git rev-parse --show-prefix)" ] \
  || { echo "rev-mutate: $ROOT is not the repository root" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rev-mutate.XXXXXX") || exit 1
BK="$WORK/backup"; CUR=""; KEEP_WORK=0
cleanup() {
  # A mutated file must never outlive this run, however it ends, and a backup this run could not
  # put back is the only copy of that work left: never delete it on the way out.
  [ -z "$CUR" ] || [ ! -f "$BK" ] || cp -p -- "$BK" "$CUR" 2>/dev/null
  [ "$KEEP_WORK" -eq 1 ] || rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

status=0; unmeasured=0; files_seen=0; hunks_seen=0; unpinned_seen=0
unmeasurable() { echo "rev-mutate: UNMEASURED $*" >&2; unmeasured=1; }

# A cluster's Prediction names a test, an arm and an assertion or message; an exit status cannot
# be compared against any of that. Surface one line of what the mutated tree printed so the
# comparison is possible at all. This script never makes it: it has no prediction to read.
failure_line() {
  local line
  line=$(tr -d '\r' < "$1" | grep -m1 -E -i 'fail|error|assert|expect|panic|not ok')
  [ -n "$line" ] || line=$(tr -d '\r' < "$1" | grep -v '^[[:space:]]*$' | tail -1)
  [ -n "$line" ] || line='the command failed and printed nothing'
  printf '%.200s' "$line"
}

git diff --name-only -z > "$WORK/files"
git ls-files --others --exclude-standard > "$WORK/untracked"
[ ! -s "$WORK/untracked" ] \
  || echo "rev-mutate: NOTE $(grep -c . < "$WORK/untracked") untracked file(s) are outside this measurement" >&2
git diff --cached --name-only > "$WORK/staged"
[ ! -s "$WORK/staged" ] \
  || echo "rev-mutate: NOTE $(grep -c . < "$WORK/staged") staged file(s) are outside this measurement" >&2

# Prove the command DISCRIMINATES before believing any verdict it gives. A command that fails on
# the unmutated tree - a typo, a missing binary, an already-red suite, the wrong cwd - reports
# every hunk as pinned, for a reason that has nothing to do with the mutation.
if ! ( eval "$CMD" ) </dev/null >/dev/null 2>&1; then
  echo "rev-mutate: measured nothing: the command does not pass on the unmutated tree" >&2
  echo "rev-mutate: every hunk would have read as pinned for a reason that is not the mutation" >&2
  exit 4
fi

while IFS= read -r -d '' f <&3; do
  [ -n "$f" ] || continue
  if [ -L "$f" ]; then
    # cp and git hash-object both follow the link, so measuring it would corrupt the file it
    # points at and then verify the restore against that same corrupted file.
    unmeasurable "$f is a symlink"
    continue
  fi
  if [ ! -f "$f" ]; then
    unmeasurable "$f is not a regular file in the working tree"
    continue
  fi
  git diff --unified=0 -- "$f" > "$WORK/file.diff"
  count=$(grep -c '^@@' < "$WORK/file.diff")
  if [ "$count" -eq 0 ]; then
    unmeasurable "$f changed with no text hunk (binary or mode change)"
    continue
  fi
  files_seen=$((files_seen + 1))
  cp -p -- "$f" "$BK" || { echo "rev-mutate: cannot back up $f" >&2; exit 1; }
  CUR=$f
  fixhash=$(git hash-object -- "$f")
  i=1
  while [ "$i" -le "$count" ]; do
    hunks_seen=$((hunks_seen + 1))
    awk -v want="$i" '
      /^@@/ { n++; keep = (n == want); if (keep) print; next }
      n == 0 { print; next }
      keep { print }
    ' < "$WORK/file.diff" > "$WORK/hunk.diff"
    if git apply --reverse --unidiff-zero --whitespace=nowarn "$WORK/hunk.diff" 2>/dev/null; then
      if [ "$(git hash-object -- "$f")" = "$fixhash" ]; then
        unmeasurable "hunk $i of $f applied without changing a byte; the mutation was inert"
      elif ( eval "$CMD" ) </dev/null > "$WORK/hunk.out" 2>&1; then
        echo "rev-mutate: UNPINNED $f hunk $i - the command passes without it"
        unpinned_seen=$((unpinned_seen + 1))
        status=3
      else
        echo "rev-mutate: PINNED $f hunk $i - $(failure_line "$WORK/hunk.out")"
      fi
    else
      unmeasurable "hunk $i of $f would not apply"
    fi
    if ! cp -p -- "$BK" "$f"; then
      KEEP_WORK=1
      echo "rev-mutate: FATAL cannot restore $f; its fix is preserved at $BK" >&2
      exit 1
    fi
    if [ "$(git hash-object -- "$f")" != "$fixhash" ]; then
      KEEP_WORK=1
      echo "rev-mutate: FATAL $f differs from the fix after its restore; the fix is preserved at $BK" >&2
      exit 1
    fi
    i=$((i + 1))
  done
  CUR=""
done 3< "$WORK/files"

# The check above was one sample, at t0. A command that passed once and then stopped passing for
# its own reasons - a poisoned cache, a leftover lock, a flake, a timeout, a port still bound -
# turned every later revert into a false "pinned", so it has to pass again now that the loop has
# put the complete fix back.
if ! ( eval "$CMD" ) </dev/null >/dev/null 2>&1; then
  echo "rev-mutate: measured nothing: the command stopped passing on the restored tree" >&2
  echo "rev-mutate: it passed before the first revert, so every verdict above rests on a command that no longer works" >&2
  exit 4
fi

if [ "$hunks_seen" -eq 0 ]; then
  echo "rev-mutate: measured nothing: no changed hunk under $ROOT" >&2
  unmeasured=1
fi
echo "rev-mutate: reverted $hunks_seen hunk(s) across $files_seen file(s); unpinned=$unpinned_seen"
[ "$unmeasured" -eq 0 ] || exit 4
exit "$status"
