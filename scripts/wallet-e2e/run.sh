#!/usr/bin/env bash
# Run the exact command supplied by the workflow and preserve its exit code.
# Observation is optional and never a condition for running the command.
invocation=$1
shift
if [ -z "${E2E_WALLET_REPORT_ROOT:-}" ] && [ -n "${RUNNER_TEMP:-}" ] &&
   [ -n "${E2E_WALLET_REPORT_JOB_KEY:-}" ]; then
  export E2E_WALLET_REPORT_ROOT="$RUNNER_TEMP/wallet-e2e/$E2E_WALLET_REPORT_JOB_KEY"
fi
if [ -n "${E2E_WALLET_REPORT_ROOT:-}" ] && [ -f "$E2E_WALLET_REPORT_ROOT/job.json" ]; then
  export E2E_WALLET_REPORT_INVOCATION="$invocation"
  node scripts/wallet-e2e/marker.cjs invocation-start "$invocation" || true
fi
code=0
"$@" || code=$?
if [ -n "${E2E_WALLET_REPORT_ROOT:-}" ] && [ -f "$E2E_WALLET_REPORT_ROOT/job.json" ]; then
  node scripts/wallet-e2e/marker.cjs invocation-end "$invocation" "$code" || true
fi
exit "$code"
