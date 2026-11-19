#!/usr/bin/env bash
set -euo pipefail

mark_stage() {
  if [[ ${PRESENTATION_GESTURE_PRIVATE_OUTPUT:-} == true && -n ${PRESENTATION_GESTURE_STAGE_FILE:-} ]]; then
    (umask 077; printf '%s\n' "$1" > "$PRESENTATION_GESTURE_STAGE_FILE") 2>/dev/null ||
      rm -f -- "$PRESENTATION_GESTURE_STAGE_FILE" 2>/dev/null || true
  fi
}

mark_stage device-setup
results_dir=test-results-presentation-gesture
mkdir -p "$results_dir"
capture=$results_dir/instrumentation.txt
capture_fd=
bridge_pid=
target_pid=
owned_forward=false

prepare_native_capture() {
  local -
  local mask
  mask=$(umask)
  umask 077
  set -C
  # Hold the inode created here; truncating the old capture would leave prior writers attached.
  { rm -f -- "$capture" && exec {capture_fd}>"$capture"; } 2>/dev/null || capture_fd=
  umask "$mask"
}

native_milestone() {
  node - "$capture" 3>&"$capture_fd" <<'NODE'
const fs = require('node:fs');
try {
  const path = process.argv[2];
  const prefix = fs.fstatSync(3, {bigint: true});
  const sameCapture = entry =>
    entry.isFile() && entry.dev === prefix.dev && entry.ino === prefix.ino && entry.size >= prefix.size;
  if (!prefix.isFile() || prefix.size === 0n || prefix.size > 1048576n) process.exit(0);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  if (!sameCapture(fs.fstatSync(fd, {bigint: true}))) process.exit(0);
  // Read only the prefix sized above, even if the instrumentation process is still writing.
  const bytes = Buffer.alloc(Number(prefix.size));
  if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || bytes.at(-1) !== 10 ||
      !sameCapture(fs.lstatSync(path, {bigint: true}))) process.exit(0);

  const tag = 'DAPP_SWIPE_MILESTONE';
  const steps = ['enter', 'swipe-succeeded', 'reply-built', 'write-returned'];
  const labels = ['native-enter-only', 'native-swipe-succeeded', 'native-reply-built', 'native-write-returned'];
  let count = 0;
  for (const line of bytes.toString('latin1').split('\n')) {
    if (!line || (!line.includes(tag) && !tag.startsWith(line))) continue;
    if (count === steps.length || line !== `${tag}_V1 ${steps[count]}`) process.exit(0);
    count++;
  }
  if (count) process.stdout.write(labels[count - 1]);
} catch {
  // An unavailable capture cannot refine the host verdict.
}
NODE
}

cleanup() {
  local status=$?
  trap - EXIT
  local inactivity='swipe-reply-started-no-injected: socket-inactivity' milestone
  if [[ -n "$capture_fd" ]]; then
    if [[ "$status" != 0 && -f "${PRESENTATION_GESTURE_STAGE_FILE:-}" ]] &&
      cmp -s -- "$PRESENTATION_GESTURE_STAGE_FILE" <(printf '%s\n' "$inactivity: first-swipe-eligible") 2>/dev/null &&
      milestone=$(native_milestone 2>/dev/null) && [[ -n "$milestone" ]]; then
      mark_stage "$inactivity: $milestone"
    fi
    { exec {capture_fd}>&-; } 2>/dev/null || true
  fi
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
  } > "$results_dir/evidence.txt" || true
  exit "$status"
}
trap cleanup EXIT

mark_stage device-identity
[[ "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" == 36 ]]
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]
build_type=$(adb shell getprop ro.build.type | tr -d '\r')
[[ "$build_type" == userdebug || "$build_type" == eng ]]
printf 'build_type=%s\n' "$build_type" > "$results_dir/webview-device.txt"
mark_stage device-root
timeout 30s adb root >> "$results_dir/webview-device.txt" 2>&1
timeout 60s adb wait-for-device
[[ "$(adb shell id -u | tr -d '\r')" == 0 ]]
mark_stage device-webview-install
echo "$PRESENTATION_WEBVIEW_SHA256  $PRESENTATION_WEBVIEW_APK" | sha256sum --check
timeout 240s adb install -r -t --no-streaming "$PRESENTATION_WEBVIEW_APK"
mark_stage device-webview-select
timeout 30s adb shell cmd webviewupdate set-webview-implementation com.android.webview > "$results_dir/webview-selection.txt"
adb shell dumpsys webviewupdate > "$results_dir/webview-selected-provider.txt"
grep -qF 'Current WebView package (name, version): (com.android.webview, 158.0.8121.0)' "$results_dir/webview-selected-provider.txt"
mark_stage device-navigation
adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural
adb shell cmd overlay list --user 0 > "$results_dir/navigation-overlays.txt"
grep -E '\[x\].*com.android.internal.systemui.navbar.gestural$' "$results_dir/navigation-overlays.txt"
[[ "$(adb shell settings get secure navigation_mode | tr -d '\r')" == 2 ]]
mark_stage device-display
for key in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb shell settings put global "$key" 1
done
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 2147483647
adb shell wm dismiss-keyguard
# Acknowledge the first-use system overlay before the live fixture owns the screen.
timeout 15s adb shell settings put secure immersive_mode_confirmations confirmed
timeout 15s adb shell settings get secure immersive_mode_confirmations > "$results_dir/immersive-confirmation.txt"
grep -qxF confirmed <(tr -d '\r' < "$results_dir/immersive-confirmation.txt")
mark_stage device-apks
adb shell getprop ro.build.fingerprint > "$results_dir/emulator-fingerprint.txt"
sha256sum android/app/build/outputs/apk/debug/app-debug.apk \
  android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk > "$results_dir/apk-sha256.txt"
timeout 240s adb install -r -t --no-streaming android/app/build/outputs/apk/debug/app-debug.apk
timeout 240s adb install -r -t --no-streaming android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
mark_stage device-app-state
# Clear only before instrumentation takes ownership; the spec never resets the running target.
adb shell pm clear com.miden.wallet >/dev/null
adb shell pm grant com.miden.wallet android.permission.POST_NOTIFICATIONS
mark_stage input-bridge
adb forward --no-rebind tcp:9236 tcp:8736
owned_forward=true
capture_output=$capture
if [[ ${PRESENTATION_GESTURE_PRIVATE_OUTPUT:-} == true && -n ${PRESENTATION_GESTURE_STAGE_FILE:-} ]]; then
  prepare_native_capture
  if [[ -n "$capture_fd" ]]; then capture_output=/dev/fd/$capture_fd; fi
fi
adb shell am instrument -w -e class com.miden.wallet.DappPresentationGestureInputTest \
  com.miden.wallet.test/androidx.test.runner.AndroidJUnitRunner > "$capture_output" 2>&1 &
bridge_pid=$!
ready=false
for _ in $(seq 1 60); do
  if [[ -z "$target_pid" ]]; then target_pid=$(adb shell pidof com.miden.wallet 2>/dev/null | tr -d '\r' || true); fi
  if grep -qF 'DappGestureInput ready port=8736' "$capture"; then ready=true; break; fi
  kill -0 "$bridge_pid" 2>/dev/null || break
  sleep 1
done
[[ "$ready" == true ]]
# Readiness may have arrived after the loop's last empty PID sample.
if [[ -z "$target_pid" ]]; then target_pid=$(adb shell pidof com.miden.wallet 2>/dev/null | tr -d '\r' || true); fi
[[ "$(adb shell pidof com.miden.wallet | tr -d '\r')" == "$target_pid" ]]
[[ "$target_pid" =~ ^[0-9]+$ ]]
export GESTURE_TARGET_PID="$target_pid"
export DAPP_PRESENTATION_GESTURE_API36=1
mark_stage playwright
yarn playwright test --config playwright.android.presentation-gesture.config.ts
mark_stage result-checks
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
grep -qxF 'OK (1 test)' <(tr -d '\r' < "$capture")
