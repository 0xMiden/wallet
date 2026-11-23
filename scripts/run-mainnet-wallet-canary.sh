#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "${GITHUB_REPOSITORY:-}" != 0xMiden/wallet ] ||
  [ "${GITHUB_REPOSITORY_ID:-}" != 853430876 ] ||
  [ "${GITHUB_REF:-}" != refs/heads/main ] ||
  [ "${GITHUB_JOB:-}" != wallet-canary ] ||
  [ "${GITHUB_WORKFLOW_REF:-}" != 0xMiden/wallet/.github/workflows/e2e-mainnet-wallet-canary.yml@refs/heads/main ] ||
  [ "${GITHUB_RUN_ATTEMPT:-}" != 1 ] ||
  ! [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]{0,19}$ ]] ||
  ! [[ "${MAINNET_CANARY_WORKFLOW_ID:-}" =~ ^[1-9][0-9]{0,19}$ ]] ||
  ! [[ "${MAINNET_SWAP_MODE:-}" =~ ^canary(-recover)?$ ]]; then
  echo 'Invalid protected wallet canary launch context.' >&2
  exit 1
fi

state_dir="${MAINNET_CANARY_STATE_DIR:?Missing persistent canary directory}"
ledger="${MAINNET_CANARY_LEDGER:?Missing provisioned canary ledger}"
run_dir="${MAINNET_CANARY_RUN_DIR:?Missing canary run directory}"
if ! [[ "$state_dir" = /* && "$ledger" = "$state_dir/one-way-slots.sqlite" ]] ||
  [ "$(realpath -e "$state_dir")" != "$state_dir" ] ||
  ! [[ -d "$state_dir" && -O "$state_dir" && -f "$ledger" && -O "$ledger" && ! -L "$ledger" ]] ||
  [ "$(stat -c '%a' "$state_dir")" != 700 ] ||
  [ "$(stat -c '%a' "$ledger")" != 600 ] ||
  [[ "$state_dir/" = "${RUNNER_TEMP:?}/"* || "$state_dir/" = "${GITHUB_WORKSPACE:?}/"* ]]; then
  echo 'The wallet canary requires a provisioned private ledger outside the job workspace.' >&2
  exit 1
fi
if [ "$run_dir" != "$RUNNER_TEMP/wallet-canary-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" ] ||
  [ "$(realpath -e "$run_dir")" != "$run_dir" ] ||
  ! [[ -d "$run_dir" && -O "$run_dir" ]] ||
  [ "$(stat -c '%a' "$run_dir")" != 700 ] ||
  [ "${MAINNET_CANARY_CHECKPOINT_PATH:-}" != "$run_dir/checkpoint.json" ] ||
  [ "${MAINNET_SWAP_SDK_GATE:-}" != "$run_dir/swap-authorization" ] ||
  [ "${MAINNET_CANARY_REPORT_DIR:-}" != "$run_dir/report" ]; then
  echo 'Invalid wallet canary run paths.' >&2
  exit 1
fi

profile="$state_dir/profile"
if ! [[ -d "$profile" && -O "$profile" ]] ||
  [ "$(realpath -e "$profile")" != "$profile" ] ||
  [ "$(stat -c '%a' "$profile")" != 700 ]; then
  echo 'The wallet canary requires a provisioned private Chromium profile.' >&2
  exit 1
fi

lock="$state_dir/wallet.lock"
if [ -L "$lock" ] || { [ -e "$lock" ] && ! [ -f "$lock" ]; }; then
  echo 'Invalid wallet canary lock file.' >&2
  exit 1
fi
exec 9>> "$lock"
if ! flock --exclusive --nonblock 9; then
  echo 'Another wallet canary process holds the wallet lock.' >&2
  if [ "$MAINNET_SWAP_MODE" = canary ]; then
    yarn -s esbuild scripts/mainnet-wallet-canary-busy.ts --bundle --platform=node --format=cjs --outfile="$run_dir/report-busy.cjs"
    node "$run_dir/report-busy.cjs"
  fi
  exit 75
fi
# Browser descendants inherit the lock, so a dead launcher cannot permit another claim.
export MAINNET_CANARY_LOCK_HELD=true
export E2E_WALLET_B_PROFILE="$profile"
exec xvfb-run -a yarn playwright test mainnet-swap-loop.spec.ts --config playwright.mainnet.config.ts --workers=1 --retries=0
