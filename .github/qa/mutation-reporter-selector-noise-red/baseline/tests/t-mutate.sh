# tests for Task 3 - sourced by run-tests.sh
# NAMESPACED: run-tests.sh sources every t-*.sh into ONE shell. Prefix every helper.
MUTATE_SRC="$SCRIPTS/rev-mutate.sh"

mut_repo() {  # mut_repo <dir> [base] [fix] - a git repo with one committed file and one uncommitted change
  local base=${2:-$'a\nb\nc\n'} fix=${3:-$'a\nB\nc\n'}
  mkdir -p "$1" && cd "$1" || return 1
  export GIT_CONFIG_GLOBAL="$T/mut-gitconfig" GIT_CONFIG_NOSYSTEM=1
  git init -q . && git config user.email t@e && git config user.name t && git config commit.gpgsign false
  printf '%s' "$base" > f.txt
  git add f.txt && git commit -qm base
  printf '%s' "$fix" > f.txt
}

mut_phase() {  # mut_phase <session-dir> <phase>
  python3 -c 'import json,sys; json.dump({"phase":sys.argv[2],"round":1}, open(sys.argv[1],"w"))' "$1/state.json" "$2"
}

mut_refuses_phase() {  # mut_refuses_phase <session-dir> <phase> <reason-pattern>
  local S=$1 phase=$2 pattern=$3 out rc
  mut_phase "$S" "$phase"
  out="$T/mut-phase-${phase:-empty}.out"
  "$MUTATE_SRC" "$S" "true" > "$out" 2>&1; rc=$?
  assert_eq "phase='$phase' refuses" "$rc" 2
  assert_grep "phase='$phase' says why" "$out" "$pattern"
}

test_mutate_refuses_while_a_panel_is_live() {
  ( local D="$T/mut-live" S="$T/mut-live-session" p; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" collect
    assert_exit "refuses to revert hunks while seats are reading the tree" 2 \
      "$MUTATE_SRC" "$S" "true"
    for p in fan-out collect plan repair; do
      mut_refuses_phase "$S" "$p" "panel is live"
    done
    assert_eq "a refusal leaves the working tree alone" "$(cat "$D/f.txt")" "$(printf 'a\nB\nc\n')" )
}

# A phase vocabulary this script does not know cannot be assumed panel-free, and neither can a
# phase reader that failed: an empty reading must not read as "no panel".
test_mutate_refuses_an_unknown_phase_spelling() {
  ( local D="$T/mut-spelling" S="$T/mut-spelling-session" p; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    for p in fan_out FAN-OUT panel 5 ""; do
      mut_refuses_phase "$S" "$p" "cannot be ruled out"
    done
    mkdir -p "$T/mut-nopython"
    printf '#!/bin/sh\nexit 127\n' > "$T/mut-nopython/python3"
    chmod 755 "$T/mut-nopython/python3"
    mut_phase "$S" collect
    assert_exit "a phase reader that fails cannot rule a panel out" 2 \
      env PATH="$T/mut-nopython:$PATH" "$MUTATE_SRC" "$S" "true" )
}

# A command that fails for its own reasons reports every hunk as pinned. Prove it discriminates
# on the unmutated tree before any of its later verdicts are believed.
test_mutate_refuses_a_command_that_cannot_pass() {
  ( local D="$T/mut-baseline" S="$T/mut-baseline-session"; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    "$MUTATE_SRC" "$S" "false" > "$T/mut-baseline.out" 2>&1
    assert_eq "a command that cannot pass measures nothing" "$?" 4
    assert_grep "says the command failed unmutated" "$T/mut-baseline.out" "does not pass on the unmutated tree"
    "$MUTATE_SRC" "$S" "rev-mutate-no-such-command" > "$T/mut-missing.out" 2>&1
    assert_eq "a command that does not exist measures nothing" "$?" 4
    assert_grep "says the missing command failed unmutated" "$T/mut-missing.out" "does not pass on the unmutated tree"
    assert_eq "the refusal leaves the fix in the tree" "$(cat "$D/f.txt")" "$(printf 'a\nB\nc\n')" )
}

test_mutate_reports_an_unpinned_hunk() {
  ( local D="$T/mut-unpinned" S="$T/mut-unpinned-session"; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    # `true` always passes, so reverting the hunk leaves it green: the hunk is unpinned.
    "$MUTATE_SRC" "$S" "true" > "$T/mut-unpinned.out" 2>&1
    assert_eq "an unpinned hunk exits 3" "$?" 3
    assert_grep "names the unpinned file" "$T/mut-unpinned.out" "f\.txt" )
}

# "A test noticed" cannot be compared against a Prediction, which names an assertion or a message.
# Without the failing line in the output, the Verify-phase comparison has nothing to read.
test_mutate_surfaces_what_failed_on_a_pinned_hunk() {
  ( local D="$T/mut-detail" S="$T/mut-detail-session"; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    # Green while the B is in the tree; the revert turns it red with a named assertion.
    "$MUTATE_SRC" "$S" \
      'grep -q B f.txt || { echo "FAIL f.txt keeps the uppercase B"; exit 1; }' \
      > "$T/mut-detail.out" 2>&1
    assert_eq "a pinned hunk still exits 0" "$?" 0
    assert_grep "names the pinned hunk" "$T/mut-detail.out" "rev-mutate: PINNED f\.txt hunk 1"
    assert_grep "prints the line that failed" "$T/mut-detail.out" "FAIL f\.txt keeps the uppercase B" )
}

test_mutate_passes_when_every_hunk_is_pinned() {
  ( local D="$T/mut-pinned" S="$T/mut-pinned-session" LOG="$T/mut-pinned.log"; mkdir -p "$S"; : > "$LOG"
    mut_repo "$D" || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    # This command passes only while the working tree holds the B, so every revert turns it red.
    # The log pins that it RAN: exit 0 alone cannot tell a real pin from a command never invoked.
    assert_exit "a pinned hunk exits 0" 0 \
      "$MUTATE_SRC" "$S" "printf 'ran\n' >> '$LOG'; grep -q B f.txt"
    assert_eq "the command ran unmutated, once per hunk, and again on the restored tree" \
      "$(grep -c . "$LOG")" 3 )
}

# Each hunk must be measured against the COMPLETE fix, not against the commit: restoring with
# `git checkout` would drop the sibling hunks, so hunk 2 would be measured on a tree at base.
test_mutate_measures_each_hunk_against_the_whole_fix() {
  ( local D="$T/mut-whole" S="$T/mut-whole-session"; mkdir -p "$S"
    mut_repo "$D" $'a\nb\nc\nd\ne\n' $'a\nB\nc\nd\nE\n' || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    # Only the B is pinned. Reverting the E alone leaves the command green, so hunk 2 is unpinned
    # and hunk 1 is not - a verdict that is only reachable while the other hunk is still present.
    "$MUTATE_SRC" "$S" "grep -q B f.txt" > "$T/mut-whole.out" 2>&1
    assert_eq "an unpinned second hunk exits 3" "$?" 3
    assert_grep "names the unpinned second hunk" "$T/mut-whole.out" "UNPINNED f\.txt hunk 2"
    assert_nogrep "does not blame the pinned first hunk" "$T/mut-whole.out" "UNPINNED f\.txt hunk 1"
    assert_nogrep "measures every hunk" "$T/mut-whole.out" "did not apply|would not apply"
    assert_eq "the run leaves the complete fix in the tree" \
      "$(cat "$D/f.txt")" "$(printf 'a\nB\nc\nd\nE\n')" )
}

# The t0 baseline is ONE sample. A command that passes once and then fails for its own reasons -
# a poisoned cache, a leftover lock, a flake, a bound port - makes every hunk read as pinned.
test_mutate_refuses_a_command_that_stops_passing() {
  ( local D="$T/mut-drift" S="$T/mut-drift-session"; mkdir -p "$S"
    mut_repo "$D" $'a\nb\nc\nd\ne\n' $'a\nB\nc\nd\nE\n' || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    "$MUTATE_SRC" "$S" \
      'n=$(cat counter 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > counter; [ "$n" -le 1 ]' \
      > "$T/mut-drift.out" 2>&1
    assert_eq "a command that stops passing measures nothing" "$?" 4
    assert_grep "distinguishes stopping from never passing" "$T/mut-drift.out" \
      "stopped passing on the restored tree"
    assert_nogrep "does not report the hunks it could not judge" "$T/mut-drift.out" "unpinned=0"
    assert_eq "the fix is still in the tree" "$(cat "$D/f.txt")" "$(printf 'a\nB\nc\nd\nE\n')" )
}

# The one path where the script admits it destroyed uncommitted work must not also delete the
# only surviving copy of it.
test_mutate_preserves_the_backup_when_it_cannot_restore() {
  ( local D="$T/mut-fatal" S="$T/mut-fatal-session" kept; mkdir -p "$S"
    mut_repo "$D" $'a\nb\nc\nd\ne\n' $'a\nB\nc\nd\nE\n' || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    # This command turns f.txt read-only once it has been mutated, so the restore cannot write.
    "$MUTATE_SRC" "$S" \
      'n=$(cat n.txt 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > n.txt; [ "$n" -ge 2 ] && chmod 444 f.txt; true' \
      > "$T/mut-fatal.out" 2>&1
    assert_eq "a failed restore stops the run" "$?" 1
    assert_grep "says where the fix is preserved" "$T/mut-fatal.out" "preserved at"
    kept=$(sed -n 's/.*preserved at //p' "$T/mut-fatal.out" | head -1)
    assert_eq "the preserved copy holds the complete fix" \
      "$(cat "$kept" 2>/dev/null)" "$(printf 'a\nB\nc\nd\nE\n')" )
}

# cp and git hash-object both follow a symlink, so measuring one corrupts the file it points at
# and the hash check then "proves" the restore against that same corrupted file.
test_mutate_refuses_a_changed_symlink() {
  ( local D="$T/mut-symlink" S="$T/mut-symlink-session"; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'ONE\n' > one.txt && printf 'TWO\n' > two.txt && ln -s one.txt link
    git add one.txt two.txt link && git commit -qm links
    ln -sfn two.txt link
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    "$MUTATE_SRC" "$S" "grep -q B f.txt" > "$T/mut-symlink.out" 2>&1
    assert_eq "a changed symlink is not measurable" "$?" 4
    assert_grep "names the symlink" "$T/mut-symlink.out" "link is a symlink"
    assert_eq "the symlink still points at the fix" "$(readlink link)" "two.txt"
    assert_eq "the file behind the old target is untouched" "$(cat one.txt)" "ONE"
    assert_eq "the file behind the new target is untouched" "$(cat two.txt)" "TWO" )
}

# review-council stages per cluster, so a half-staged fix is the case that reads green.
test_mutate_names_staged_changes_it_cannot_measure() {
  ( local D="$T/mut-staged" S="$T/mut-staged-session"; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'g\n' > g.txt && git add g.txt && git commit -qm g
    printf 'G\n' > g.txt && git add g.txt
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    "$MUTATE_SRC" "$S" "grep -q B f.txt" > "$T/mut-staged.out" 2>&1
    assert_eq "the unstaged hunk is still measured" "$?" 0
    assert_grep "names the staged file it cannot measure" "$T/mut-staged.out" "NOTE 1 staged file" )
}

test_mutate_refuses_when_the_phase_cannot_be_read() {
  ( local D="$T/mut-phase" S="$T/mut-phase-session"; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    assert_exit "a missing state.json cannot rule a panel out" 2 "$MUTATE_SRC" "$S" "true"
    printf 'not json\n' > "$S/state.json"
    assert_exit "a malformed state.json cannot rule a panel out" 2 "$MUTATE_SRC" "$S" "true"
    printf '{"round": 1}\n' > "$S/state.json"
    assert_exit "a state.json with no phase cannot rule a panel out" 2 "$MUTATE_SRC" "$S" "true"
    assert_eq "a refusal leaves the working tree alone" "$(cat "$D/f.txt")" "$(printf 'a\nB\nc\n')" )
}

# A revert that changes no byte is the failure this tool exists to prevent: it reads exactly like
# a real measurement and every later verdict rests on it.
test_mutate_fails_a_run_that_measured_nothing() {
  ( local D="$T/mut-nothing" S="$T/mut-nothing-session"; mkdir -p "$S"
    mut_repo "$D" || exit 1
    printf 'REV_ROOT=%s\n' "$D" > "$S/scope.env"
    mut_phase "$S" fix
    git checkout -- f.txt
    "$MUTATE_SRC" "$S" "true" > "$T/mut-nothing.out" 2>&1
    assert_eq "a run with nothing to revert is not a pass" "$?" 4
    assert_grep "says it measured nothing" "$T/mut-nothing.out" "measured nothing"
    python3 -c 'open("bin.dat","wb").write(b"\x00\x01\x02")'
    git add bin.dat && git commit -qm bin
    python3 -c 'open("bin.dat","wb").write(b"\x00\x09\x02")'
    printf 'a\nB\nc\n' > f.txt
    "$MUTATE_SRC" "$S" "true" > "$T/mut-binary.out" 2>&1
    assert_eq "an unmeasurable file outranks an unpinned hunk" "$?" 4
    assert_grep "names the unmeasured file" "$T/mut-binary.out" "bin\.dat"
    assert_grep "still reports the unpinned hunk" "$T/mut-binary.out" "UNPINNED f\.txt hunk 1" )
}
