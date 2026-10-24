#!/usr/bin/env bash
set -euo pipefail

results_dir=test-results-auth-tab
mkdir -p "$results_dir"

write_acceptance_evidence() {
  local acceptance_status=$?
  trap - EXIT
  {
    echo "source_sha=${GITHUB_SHA:-local}"
    echo "ca_subject=${AUTH_TAB_CA_SUBJECT:-missing}"
    echo "acceptance_exit_code=$acceptance_status"
    cat "$results_dir/provider-version.txt" 2>/dev/null || echo 'provider_version=unread'
    echo "emulator_fingerprint=$(cat "$results_dir/emulator-fingerprint.txt" 2>/dev/null || echo unread)"
    if [[ -f "$results_dir/results.json" ]]; then
      node -e "const r=require('./$results_dir/results.json'); \
        console.log('playwright_expected='+r.stats.expected+' playwright_unexpected='+r.stats.unexpected)" \
        || echo 'playwright_results=unreadable'
    else
      echo 'playwright_results=missing'
    fi
  } > "$results_dir/evidence.txt"
  if ! timeout 15s adb devices -l > "$results_dir/adb-devices.txt"; then
    echo 'adb_devices=unavailable' > "$results_dir/adb-devices-status.txt"
  fi
  if ! timeout 15s adb logcat -d -s AuthTabAcceptance:I '*:S' > "$results_dir/final-acceptance.log"; then
    echo 'adb_logcat=unavailable' > "$results_dir/final-acceptance-status.txt"
  fi
  exit "$acceptance_status"
}
trap write_acceptance_evidence EXIT

# Gradle's connected test task installs through a session commit the Android 37 image intermittently drops
# ("Broken pipe" from the package service) and never retries, so the APKs are installed here and run with am instrument.
# "Failure calling service package: Broken pipe" means system_server went away under the install, so wait until
# it has kept one pid for 30 s, and record which pid each attempt saw.
wait_for_stable_system() {
  local last='' same=0
  for _ in $(seq 1 60); do
    local pid
    pid=$(timeout 10s adb shell pidof system_server 2>/dev/null | tr -d '\r')
    starts=$(timeout 10s adb shell getprop sys.system_server.start_count 2>/dev/null | tr -d '\r')
    if [[ -n "$pid" && "$pid" == "$last" ]]; then same=$((same + 1)); else same=0; fi
    if [[ -n "$last" && "$pid" != "$last" && ! -f "$results_dir/restart-reason.txt" ]]; then
      {
        echo '--- crash buffer ---'
        timeout 15s adb logcat -d -b crash | tail -120
        echo '--- system_server deaths ---'
        timeout 15s adb logcat -d -b system,main,events | grep -iE 'FATAL EXCEPTION IN SYSTEM PROCESS|Watchdog|\*\*\* FATAL|system_server.*(died|crash)|am_crash|sysui_|Zygote.*died|AndroidRuntime' | tail -80
      } > "$results_dir/restart-reason.txt" 2>&1 || true
      cat "$results_dir/restart-reason.txt"
    fi
    echo "$(date +%T) system_server=${pid:-none} start_count=${starts:-none}" | tee -a "$results_dir/system-server-pids.txt"
    last=$pid
    [[ $same -ge 6 ]] && return 0
    sleep 5
  done
  return 1
}

install_apk() {
  local apk=$1
  for attempt in 1 2 3; do
    wait_for_stable_system || true
    adb shell pm path android >/dev/null 2>&1 || sleep 5
    if timeout 240s adb install -r -t --no-streaming "$apk"; then return 0; fi
    echo "$(date +%T) install failed: $apk attempt=$attempt" >> "$results_dir/system-server-pids.txt"
  done
  timeout 15s adb logcat -d -b crash > "$results_dir/logcat-crash.txt" 2>&1 || true
  echo '--- crash buffer (last 80 lines) ---'
  tail -80 "$results_dir/logcat-crash.txt" || true
  timeout 15s adb logcat -d -b system,main -t 3000 > "$results_dir/logcat-system.txt" 2>&1 || true
  return 1
}

run_instrumentation_test() {
  local test_class=$1
  local log_name=$2
  shift 2
  local instrument_args=(-e class "$test_class")
  while [[ $# -gt 0 ]]; do
    instrument_args+=(-e "$1" "$2")
    shift 2
  done

  adb logcat -c
  # am instrument exits 0 on a failing test, so its own summary line is the verdict.
  adb shell am instrument -w "${instrument_args[@]}" \
    com.miden.wallet.test/androidx.test.runner.AndroidJUnitRunner | tee "$results_dir/${log_name%.log}-instrument.txt"
  if ! timeout 15s adb logcat -d -s AuthTabAcceptance:I '*:S' > "$results_dir/$log_name"; then
    echo 'adb_logcat=unavailable' > "$results_dir/${log_name%.log}-status.txt"
  fi
  grep -qxF 'OK (1 test)' <(tr -d '\r' < "$results_dir/${log_name%.log}-instrument.txt")
}

adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
# Once the PIN below is set, a sleeping screen comes back on the PIN keyguard, which hides every app the run opens;
# the APK installs alone can outlast the default screen timeout.
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 2147483647
adb shell wm dismiss-keyguard
device_pin=1234
adb shell locksettings set-pin "$device_pin" >/dev/null
# Play Protect verifies each adb install on Play images; skipping it removes one source of dropped install commits.
adb shell settings put global verifier_verify_adb_installs 0
adb shell settings put global package_verifier_enable 0
adb shell getprop ro.build.fingerprint > "$results_dir/emulator-fingerprint.txt"
install_apk "$RUNNER_TEMP/firefox.apk"
install_apk "$RUNNER_TEMP/ChromePublic.apk"
# Each browser's first-run screens cover its Auth Tab or Custom Tab until they are completed once, and these
# builds ignore the switches that would skip them, so walk them through the UI now.
complete_first_run() {
  local package=$1 activity idle=0
  activity=$(adb shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$package" | tr -d '\r' | tail -1)
  adb shell am start -W -n "$activity" >/dev/null
  for _ in $(seq 1 30); do
    sleep 2
    adb shell uiautomator dump /sdcard/first-run.xml >/dev/null 2>&1 || continue
    local bounds
    bounds=$(adb exec-out cat /sdcard/first-run.xml | tr '>' '\n' \
      | grep -E 'text="(Continue|Not now|Skip|Maybe later|Stay signed out|No thanks|Got it|Use without an account|Don.t allow|Cancel)"' \
      | head -1 | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | grep -o '[0-9]*' | tr '\n' ' ' || true)
    if [[ -z "$bounds" ]]; then
      # A browser's first launch is slow; an empty screen counts only once its own window has focus. The
      # default-browser prompt belongs to the system, so a button is tapped whichever window shows it.
      adb shell dumpsys window displays | grep -q "mCurrentFocus=.*$package" || continue
      idle=$((idle + 1))
      [[ $idle -ge 3 ]] && { echo "$package first run complete"; adb shell am force-stop "$package"; return 0; }
      continue
    fi
    idle=0
    read -r x1 y1 x2 y2 <<< "$bounds"
    echo "$package first run: tapping at $(((x1 + x2) / 2)),$(((y1 + y2) / 2))"
    adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
  done
  echo "$package first run did not complete" >&2
  adb exec-out screencap -p > "$results_dir/$package-first-run.png" || true
  return 1
}
complete_first_run "$AUTH_TAB_PROVIDER"
complete_first_run org.mozilla.firefox
# Auth Tab needs Chromium 137 or later; an older provider would only exercise the Custom Tab fallback.
adb shell dumpsys package "$AUTH_TAB_PROVIDER" > "$results_dir/provider-package.txt"
provider_version=$(grep -m1 -o 'versionName=[0-9.]*' "$results_dir/provider-package.txt" | cut -d= -f2)
echo "provider_version=$AUTH_TAB_PROVIDER ${provider_version:-missing}" > "$results_dir/provider-version.txt"
if [[ -z "$provider_version" || "${provider_version%%.*}" -lt 137 ]]; then
  echo "$AUTH_TAB_PROVIDER ${provider_version:-missing} predates Auth Tab (137)" >&2
  exit 1
fi
install_apk android/app/build/outputs/apk/debug/app-debug.apk
install_apk android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell dumpsys package org.mozilla.firefox > "$results_dir/firefox-package.txt"
grep -m1 'versionName=158.0.2' "$results_dir/firefox-package.txt"
# Shared storage mounts after boot completes; until then /sdcard fails "Transport endpoint is not connected".
for _ in $(seq 1 60); do adb shell ls /sdcard/ >/dev/null 2>&1 && break; sleep 2; done
adb shell mkdir -p /sdcard/Download
adb push "$RUNNER_TEMP/auth-tab-cert/auth-tab-root-ca.crt" /sdcard/Download/auth-tab-root-ca.crt
# An adb push is invisible to the file picker until MediaStore indexes it.
adb shell content call --uri content://media --method scan_volume --arg external_primary >/dev/null || true

run_instrumentation_test com.miden.wallet.AuthTabCertificateSetupTest certificate-setup.log \
  caSubject "$AUTH_TAB_CA_SUBJECT" devicePin "$device_pin"
grep -F "fixtureCaInstalled=true subject=$AUTH_TAB_CA_SUBJECT" "$results_dir/certificate-setup.log"
# Firefox ignores the user CA store and asks before opening the wallet's callback until two of its settings change.
run_instrumentation_test com.miden.wallet.FirefoxCustomTabSetupTest firefox-setup.log devicePin "$device_pin"
grep -F 'firefoxThirdPartyCaEnabled=true firefoxOpenLinksInApps=always' "$results_dir/firefox-setup.log"

adb shell cmd role clear-role-holders --user 0 android.app.role.BROWSER
adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER "$AUTH_TAB_PROVIDER"
run_instrumentation_test com.miden.wallet.AuthTabProviderAcceptanceTest chromium-capability.log \
  expectedProvider "$AUTH_TAB_PROVIDER" authTabProvider "$AUTH_TAB_PROVIDER"
grep -F "selectedProvider=$AUTH_TAB_PROVIDER" "$results_dir/chromium-capability.log"
grep -F "provider=$AUTH_TAB_PROVIDER " "$results_dir/chromium-capability.log" | grep -F 'authTabSupported=true'
grep -F 'provider=org.mozilla.firefox ' "$results_dir/chromium-capability.log" | grep -F 'authTabSupported=false'

adb shell cmd role clear-role-holders --user 0 android.app.role.BROWSER
adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER org.mozilla.firefox
run_instrumentation_test com.miden.wallet.AuthTabProviderAcceptanceTest firefox-capability.log \
  expectedProvider org.mozilla.firefox authTabProvider "$AUTH_TAB_PROVIDER"
grep -F 'selectedProvider=org.mozilla.firefox' "$results_dir/firefox-capability.log"
grep -F 'provider=org.mozilla.firefox ' "$results_dir/firefox-capability.log" | grep -F 'authTabSupported=false'

adb shell ps -A -o PID,NAME | grep -i 'com.google.android.gms' > "$results_dir/gms-processes.txt" || echo 'no gms processes' > "$results_dir/gms-processes.txt"
yarn playwright test --config playwright.android.auth-tab.config.ts
node <<'NODE'
const r = require('./test-results-auth-tab/results.json');
if (!r.stats || r.stats.expected !== 1) {
  console.error('Expected one executed Auth Tab test, got', r.stats);
  process.exit(1);
}
NODE
