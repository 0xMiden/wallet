#!/usr/bin/env bash
#
# Detached stress-test runner.
#
# Hardened so the archive/notify bookkeeping survives an OOM kill of the test.
# Previously `<archive>; <notify>` were chained inside the same tmux command,
# right after `yarn ... | tee`. When the systemd user scope running that tmux
# command was OOM-killed (SIGKILL to the whole cgroup — uncatchable, so an EXIT
# trap would not help either), the chain never ran and the daily summary /
# pending / notify-curl logs silently froze at the prior run.
#
# Now the test runs in its own tmux session and writes a `.done` sentinel with
# its real exit code. A *separate* watcher — a transient `systemd-run --user`
# service in its own cgroup, immune to the test scope's OOM kill — waits for the
# session to end, then archives + notifies exactly once, classifying the run as
# passed / failed / killed (sentinel absent => killed/incomplete).
#
# Usage:
#   scripts/stress-detached.sh [network]        # launch a detached run
#   scripts/stress-detached.sh __watch ...      # internal: watcher (do not call)

set -euo pipefail

SELF="$(readlink -f "$0")"

# ── Watcher mode (internal) ─────────────────────────────────────────────────
# Runs in its own cgroup, decoupled from the OOM-prone test scope. Fires once
# the test session ends, for ANY reason (clean exit, assertion failure, or kill).
if [[ "${1:-}" == "__watch" ]]; then
  SESSION="$2"
  STAMP="$3"
  LOGFILE="$4"
  DONE_SENTINEL="$5"
  NETWORK="$6"

  # 1. Wait for the session to APPEAR (guards the launcher race), bounded.
  waited=0
  until tmux has-session -t "$SESSION" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    [[ "$waited" -ge 30 ]] && break
  done

  # 2. Wait for the session to END (test exited or was killed).
  while tmux has-session -t "$SESSION" 2>/dev/null; do
    sleep 10
  done

  # 3. Classify the outcome. Sentinel present => the test command reached its
  #    final line (ran to completion); absent => it was killed mid-run (OOM).
  if [[ -f "$DONE_SENTINEL" ]]; then
    EXIT_CODE="$(tr -dc '0-9-' <"$DONE_SENTINEL" 2>/dev/null || true)"
    [[ -z "$EXIT_CODE" ]] && EXIT_CODE="unknown"
    if [[ "$EXIT_CODE" == "0" ]]; then
      OUTCOME="passed"
    else
      OUTCOME="failed"
    fi
  else
    EXIT_CODE="killed"
    OUTCOME="killed" # never reached the sentinel write — OOM / crash
  fi

  # ── do_archive ────────────────────────────────────────────────────────────
  # >>> KEEP YOUR EXISTING <archive> BODY HERE <<<
  # It now also runs on OUTCOME=killed, so a lost run still gets recorded.
  # The artifacts your setup writes (reconstructed from the failure report —
  # replace with your exact commands):
  #   - append a JSON line to ~/.claude/stress-summaries/$(date +%Y-%m).jsonl
  #   - update ~/.claude/stress-summaries/stress-pending.txt
  # Use the vars: $STAMP $NETWORK $LOGFILE $OUTCOME $EXIT_CODE
  archive_run() {
    local month
    month="$(date +%Y-%m)"
    local summaries="$HOME/.claude/stress-summaries"
    mkdir -p "$summaries"
    # >>> REPLACE the line below with your real summary-line construction <<<
    printf '{"stamp":"%s","network":"%s","outcome":"%s","exit":"%s","log":"%s"}\n' \
      "$STAMP" "$NETWORK" "$OUTCOME" "$EXIT_CODE" "$LOGFILE" \
      >>"$summaries/${month}.jsonl"
    # >>> REPLACE with your real pending-file update (e.g. drop this stamp) <<<
    if [[ -f "$summaries/stress-pending.txt" ]]; then
      grep -v -F "$STAMP" "$summaries/stress-pending.txt" >"$summaries/stress-pending.txt.tmp" 2>/dev/null || true
      mv -f "$summaries/stress-pending.txt.tmp" "$summaries/stress-pending.txt" 2>/dev/null || true
    fi
  }

  # ── do_notify ─────────────────────────────────────────────────────────────
  # >>> KEEP YOUR EXISTING <notify> BODY HERE <<<
  # Logs to ~/.claude/stress-summaries/stress-notify-curl.log (per your setup).
  notify_run() {
    local notify_log="$HOME/.claude/stress-summaries/stress-notify-curl.log"
    # >>> REPLACE with your real curl/webhook call; keep the >> log redirect <<<
    {
      echo "[$(date -Is)] stress ${STAMP} ${NETWORK} -> ${OUTCOME} (exit=${EXIT_CODE})"
      # curl -fsS -X POST "$YOUR_WEBHOOK" -d "..." 2>&1
    } >>"$notify_log" 2>&1 || true
  }

  # Best-effort, independent: a failure in one must not skip the other.
  archive_run || true
  notify_run || true
  exit 0
fi

# ── Launcher mode ───────────────────────────────────────────────────────────

NETWORK="${1:-devnet}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SESSION="stress-${STAMP}"
WALLET_DIR="$HOME/wallet"
LOGDIR="${WALLET_DIR}/test-results"
LOGFILE="${LOGDIR}/stress-${STAMP}.log"
DONE_SENTINEL="${LOGDIR}/stress-${STAMP}.done"
RUNNER="${LOGDIR}/stress-${STAMP}.run.sh"

mkdir -p "$LOGDIR"

# >>> KEEP YOUR EXISTING pull + log-header logic HERE <<<
# (pull origin/main unless SKIP_PULL=1; write commit SHA + STRESS_* env header)

# Generate the per-run test command as its own bash script. Running it through
# `bash` (not sh) guarantees `source`/`nvm`/`${PIPESTATUS[0]}` work, and the
# trailing sentinel write captures the REAL test exit code regardless of `tee`.
cat >"$RUNNER" <<EOF
#!/usr/bin/env bash
# No 'set -euo' here: -e would skip the sentinel write when the test fails, and
# -u breaks nvm's sourcing. PIPESTATUS captures yarn's real exit code regardless.
source ~/.nvm/nvm.sh
nvm use 22
cd "${WALLET_DIR}"

# >>> KEEP YOUR EXISTING STRESS_* ENV + miden-client bin HERE <<<
export MIDEN_CLIENT_BIN="\$HOME/.cargo/bin/miden-client"
export E2E_NETWORK="${NETWORK}"
# export STRESS_NUM_NOTES=... STRESS_LOCK_EVERY=... STRESS_RELOAD_EVERY=... etc.

yarn test:e2e:stress:run 2>&1 | tee -a "${LOGFILE}"
# Record the test's real exit status; the watcher reads this. Its ABSENCE means
# the run was killed (OOM) before reaching this line.
echo "\${PIPESTATUS[0]}" > "${DONE_SENTINEL}"
EOF
chmod +x "$RUNNER"

# Launch the test in its own tmux session (NO archive/notify chained here).
setsid tmux new-session -d -s "$SESSION" "bash '$RUNNER'"

# Launch the decoupled archive/notify watcher in its OWN cgroup so the test
# scope being OOM-killed cannot take it down. Prefer a transient systemd --user
# service; fall back to setsid if systemd-run is absent OR fails (e.g. no user
# D-Bus session under cron). The fallback is guarded so a systemd-run failure
# never aborts the launcher and leaves the running test without a watcher.
started_watcher=0
if command -v systemd-run >/dev/null 2>&1; then
  if systemd-run --user --quiet --collect \
    --unit="stress-watch-${STAMP}" \
    --description="stress archive/notify watcher ${STAMP}" \
    bash "$SELF" __watch "$SESSION" "$STAMP" "$LOGFILE" "$DONE_SENTINEL" "$NETWORK"; then
    started_watcher=1
  fi
fi
if [[ "$started_watcher" -eq 0 ]]; then
  setsid bash "$SELF" __watch "$SESSION" "$STAMP" "$LOGFILE" "$DONE_SENTINEL" "$NETWORK" \
    </dev/null >>"${LOGDIR}/stress-watch-${STAMP}.log" 2>&1 &
  disown || true
fi

echo "Launched stress run '${SESSION}' (network=${NETWORK})."
echo "  log:      ${LOGFILE}"
echo "  watcher:  stress-watch-${STAMP} (archive/notify will fire even if the run is OOM-killed)"
echo "  attach:   tmux attach -t ${SESSION}"
