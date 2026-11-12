#!/usr/bin/env bash
set -euo pipefail

results_dir=test-results-presentation-gesture
mkdir -p "$results_dir"
bridge_pid=
target_pid=
owned_forward=false

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$owned_forward" == true ]]; then
    node <<'NODE' || true
const net = require('node:net');
const socket = net.createConnection({host:'127.0.0.1',port:9236});
socket.setTimeout(3000, () => socket.destroy());
socket.on('error', () => {});
socket.on('connect', () => socket.write(JSON.stringify({id:2147483647,op:'stop'})+'\n'));
socket.on('data', () => socket.end());
NODE
  fi
  if [[ -n "$bridge_pid" ]]; then
    for _ in $(seq 1 10); do kill -0 "$bridge_pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$bridge_pid" 2>/dev/null; then
      # Only retire the exact target process this invocation started, never a replacement instance.
      if [[ -n "$target_pid" && "$(adb shell pidof com.miden.wallet | tr -d '\r')" == "$target_pid" ]]; then
        timeout 15s adb shell am force-stop com.miden.wallet || true
      fi
      kill "$bridge_pid" 2>/dev/null || true
    fi
    wait "$bridge_pid" 2>/dev/null || true
  fi
  if [[ "$owned_forward" == true ]]; then adb forward --remove tcp:9236 || true; fi
  {
    echo "source_sha=${GITHUB_SHA:-missing}"
    echo "source_tree=$(git rev-parse HEAD^{tree})"
    echo "selector=presentation-gesture-api36"
    echo "acceptance_exit_code=$status"
    echo "target_pid=$target_pid"
  } > "$results_dir/evidence.txt"
  exit "$status"
}
trap cleanup EXIT

[[ "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" == 36 ]]
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]
adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural
adb shell cmd overlay list --user 0 > "$results_dir/navigation-overlays.txt"
grep -E '\[x\].*com.android.internal.systemui.navbar.gestural$' "$results_dir/navigation-overlays.txt"
[[ "$(adb shell settings get secure navigation_mode | tr -d '\r')" == 2 ]]
for key in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb shell settings put global "$key" 1
done
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 2147483647
adb shell wm dismiss-keyguard
adb shell getprop ro.build.fingerprint > "$results_dir/emulator-fingerprint.txt"
sha256sum android/app/build/outputs/apk/debug/app-debug.apk \
  android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk > "$results_dir/apk-sha256.txt"
timeout 240s adb install -r -t --no-streaming android/app/build/outputs/apk/debug/app-debug.apk
timeout 240s adb install -r -t --no-streaming android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
# Clear only before instrumentation takes ownership; the spec never resets the running target.
adb shell pm clear com.miden.wallet >/dev/null
adb shell pm grant com.miden.wallet android.permission.POST_NOTIFICATIONS
adb forward --no-rebind tcp:9236 tcp:8736
owned_forward=true
adb shell am instrument -w -e class com.miden.wallet.DappPresentationGestureInputTest \
  com.miden.wallet.test/androidx.test.runner.AndroidJUnitRunner > "$results_dir/instrumentation.txt" 2>&1 &
bridge_pid=$!
ready=false
for _ in $(seq 1 60); do
  if [[ -z "$target_pid" ]]; then target_pid=$(adb shell pidof com.miden.wallet 2>/dev/null | tr -d '\r' || true); fi
  if grep -qF 'DappGestureInput ready port=8736' "$results_dir/instrumentation.txt"; then ready=true; break; fi
  kill -0 "$bridge_pid" 2>/dev/null || break
  sleep 1
done
[[ "$ready" == true ]]
[[ "$(adb shell pidof com.miden.wallet | tr -d '\r')" == "$target_pid" ]]
[[ "$target_pid" =~ ^[0-9]+$ ]]
export GESTURE_TARGET_PID="$target_pid"
export DAPP_PRESENTATION_GESTURE_API36=1
yarn playwright test --config playwright.android.presentation-gesture.config.ts
node <<'NODE'
const r = require('./test-results-presentation-gesture/results.json');
if (!r.stats || r.stats.expected !== 4 || r.stats.unexpected !== 0 || r.stats.skipped !== 0 || r.stats.flaky !== 0)
  throw new Error('Exactly four executed gesture cases must pass without skips or retries: '+JSON.stringify(r.stats));
const net = require('node:net');
const socket = net.createConnection({host:'127.0.0.1',port:9236});
socket.setTimeout(5000, () => socket.destroy(new Error('Input bridge did not stop')));
socket.on('error', error => { console.error(error.message); process.exitCode=1; });
socket.on('connect', () => socket.write(JSON.stringify({id:2147483647,op:'stop'})+'\n'));
let result='';
socket.on('data', chunk => { result+=chunk; if(result.includes('\n')) socket.end(); });
socket.on('end', () => {
  const r=JSON.parse(result);
  if(r.phase!=='done'||r.executed!==4) { console.error('Native input count mismatch'); process.exitCode=1; }
});
NODE
wait "$bridge_pid"
bridge_pid=
grep -qxF 'OK (1 test)' <(tr -d '\r' < "$results_dir/instrumentation.txt")
