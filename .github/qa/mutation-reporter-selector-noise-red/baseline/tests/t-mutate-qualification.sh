# Source-only addition, sourced by the preserved tests/run-tests.sh. Parent execution only.
# Uses the existing t-mutate.sh helpers and assertion protocol; no new production interface.
MQ_FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../fixtures" && pwd)"

mq_prepare() {
  mkdir -p "$T/mq-$1-session"
  mut_repo "$T/mq-$1" || return 1
  printf 'REV_ROOT=%s\n' "$T/mq-$1" > "$T/mq-$1-session/scope.env"
  mut_phase "$T/mq-$1-session" fix
}

mq_run() {
  local name=$1 mode=$2 rc
  "$MUTATE_SRC" "$T/mq-$name-session" \
    "bash '$MQ_FIXTURES/check-mutant.sh' '$mode'" > "$T/mq-$name.out" 2>&1
  rc=$?
  assert_eq "$name leaves complete fix bytes" "$(cat f.txt)" "$(printf 'a\nB\nc\n')"
  return "$rc"
}

test_mutate_qualification_reporter_prediction_red() {
  ( mq_prepare reporter || exit 1
    mq_run reporter predicted; local rc=$?
    assert_eq "behavioral failure preserves raw pinned exit" "$rc" 0
    assert_grep "Prediction assertion, not passing stack or console noise" "$T/mq-reporter.out" \
      'PINNED f\.txt hunk 1 - AssertionError: expected uppercase B, received lowercase b'
    assert_nogrep "no console noise as witness" "$T/mq-reporter.out" 'PINNED .*console\.error'
    assert_nogrep "no passing stack as witness" "$T/mq-reporter.out" 'PINNED .*toBeInTheDocument' )
}

test_mutate_qualification_full_output_red() {
  ( mq_prepare full-output || exit 1
    mq_run full-output predicted; local rc=$?
    assert_eq "retaining diagnostic output must not change exit" "$rc" 0
    assert_grep "retain exact test identity" "$T/mq-full-output.out" '^FAIL f\.txt keeps the uppercase B$'
    assert_grep "retain expected arm" "$T/mq-full-output.out" '^Expected: uppercase B$'
    assert_grep "retain received arm" "$T/mq-full-output.out" '^Received: lowercase b$' )
}

test_mutate_qualification_nonbehavior_controls() {
  ( local mode rc
    for mode in syntax reference empty environment; do
      mq_prepare "$mode" || exit 1
      mq_run "$mode" "$mode"; rc=$?
      # These are RAW baseline decisions, NOT a behavioral Prediction match.
      assert_eq "$mode raw CLI still calls the failure pinned" "$rc" 0
      assert_grep "$mode retains legacy PINNED" "$T/mq-$mode.out" 'PINNED f\.txt hunk 1'
      case "$mode" in
        syntax) assert_grep "syntax diagnostic" "$T/mq-$mode.out" 'SyntaxError' ;;
        reference) assert_grep "reference diagnostic" "$T/mq-$mode.out" 'ReferenceError: tokenPendingItems is not defined' ;;
        empty) assert_grep "no-output diagnostic" "$T/mq-$mode.out" 'printed nothing' ;;
        environment) assert_grep "environment refusal diagnostic" "$T/mq-$mode.out" 'ci-local: refused-load' ;;
      esac
    done )
}

test_mutate_qualification_passing_control() {
  ( mq_prepare passing || exit 1
    mq_run passing passing; local rc=$?
    assert_eq "passing mutant remains unpinned" "$rc" 3
    assert_grep "passing diagnostic" "$T/mq-passing.out" 'UNPINNED f\.txt hunk 1' )
}

test_mutate_qualification_opening_and_closing_controls() {
  ( mq_prepare opening || exit 1
    "$MUTATE_SRC" "$T/mq-opening-session" 'false' > "$T/mq-opening.out" 2>&1
    assert_eq "opening failure measures nothing" "$?" 4
    assert_grep "opening reason" "$T/mq-opening.out" 'does not pass on the unmutated tree'
    assert_nogrep "opening failure makes no pin" "$T/mq-opening.out" 'rev-mutate: PINNED'
    assert_eq "opening preserves fix" "$(cat f.txt)" "$(printf 'a\nB\nc\n')"
    mq_prepare closing || exit 1
    "$MUTATE_SRC" "$T/mq-closing-session" \
      "n=\$(cat '$T/mq-counter' 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > '$T/mq-counter'; [ \$n -lt 3 ] && grep -q B f.txt" \
      > "$T/mq-closing.out" 2>&1
    assert_eq "closing failure outranks pins" "$?" 4
    assert_grep "closing reason" "$T/mq-closing.out" 'stopped passing on the restored tree'
    assert_eq "closing preserves fix" "$(cat f.txt)" "$(printf 'a\nB\nc\n')" )
}

test_mutate_qualification_inert_control() {
  ( mq_prepare inert || exit 1
    mkdir -p "$T/mq-inert-bin"
    export MQ_REAL_GIT="$(command -v git)"
    cp "$MQ_FIXTURES/git-inert.sh" "$T/mq-inert-bin/git" || exit 1
    chmod 755 "$T/mq-inert-bin/git"
    PATH="$T/mq-inert-bin:$PATH" mq_run inert predicted; local rc=$?
    assert_eq "successful apply without byte change measures nothing" "$rc" 4
    assert_grep "inert reason" "$T/mq-inert.out" 'mutation was inert'
    assert_nogrep "inert revert makes no pin" "$T/mq-inert.out" 'rev-mutate: PINNED' )
}

test_mutate_qualification_restore_failure_control() {
  ( mq_prepare restore || exit 1
    mkdir -p "$T/mq-restore-bin"
    export MQ_REAL_CP="$(command -v cp)"
    cp "$MQ_FIXTURES/cp-restore-failure.sh" "$T/mq-restore-bin/cp" || exit 1
    chmod 755 "$T/mq-restore-bin/cp"
    PATH="$T/mq-restore-bin:$PATH" "$MUTATE_SRC" "$T/mq-restore-session" \
      "bash '$MQ_FIXTURES/check-mutant.sh' passing" > "$T/mq-restore.out" 2>&1
    local rc=$?
    assert_eq "restore failure stops" "$rc" 1
    assert_grep "restore identifies retained backup" "$T/mq-restore.out" 'FATAL cannot restore f.txt; its fix is preserved at '
    local kept
    kept=$(sed -n 's/.*preserved at //p' "$T/mq-restore.out" | head -1)
    assert_eq "backup retains complete fix" "$(cat "$kept" 2>/dev/null)" "$(printf 'a\nB\nc\n')" )
}


test_mutate_qualification_selector_noise_regression_red() {
  ( mq_prepare selector-noise || exit 1
    mq_run selector-noise selector-noise; local rc=$?
    assert_eq "selector noise preserves raw pinned exit" "$rc" 0
    assert_grep "summary names genuine FAIL title or actual assertion" "$T/mq-selector-noise.out" \
      '^rev-mutate: PINNED f\.txt hunk 1 - (FAIL f\.txt keeps the uppercase B|AssertionError: expected uppercase B, received lowercase b)$'
    assert_nogrep "console noise is not the summary" "$T/mq-selector-noise.out" \
      '^rev-mutate: PINNED .*console\.error' )
}
