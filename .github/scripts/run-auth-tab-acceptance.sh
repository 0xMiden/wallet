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
    cat "$results_dir/chrome-version.txt" 2>/dev/null || echo 'chrome_version=unread'
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
install_apk() {
  local apk=$1
  for _ in $(seq 1 30); do adb shell pm path android >/dev/null 2>&1 && break; sleep 2; done
  for attempt in 1 2 3 4 5 6; do
    if adb install -r -t --no-streaming "$apk"; then return 0; fi
    [[ $attempt -eq 6 ]] && return 1
    sleep 15
  done
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
device_pin=1234
adb shell locksettings set-pin "$device_pin" >/dev/null
# Play Protect verifies each adb install on Play images; skipping it removes one source of dropped install commits.
adb shell settings put global verifier_verify_adb_installs 0
adb shell settings put global package_verifier_enable 0
adb shell getprop ro.build.fingerprint > "$results_dir/emulator-fingerprint.txt"
# Auth Tab needs Chrome 137 or later; an older preinstalled Chrome would only exercise the Custom Tab fallback.
adb shell dumpsys package com.android.chrome > "$results_dir/chrome-package.txt"
chrome_version=$(grep -m1 -o 'versionName=[0-9.]*' "$results_dir/chrome-package.txt" | cut -d= -f2)
echo "chrome_version=${chrome_version:-missing}" > "$results_dir/chrome-version.txt"
if [[ -z "$chrome_version" || "${chrome_version%%.*}" -lt 137 ]]; then
  echo "Chrome ${chrome_version:-missing} on this image predates Auth Tab (137)" >&2
  exit 1
fi
install_apk "$RUNNER_TEMP/firefox.apk"
install_apk android/app/build/outputs/apk/debug/app-debug.apk
install_apk android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell dumpsys package org.mozilla.firefox > "$results_dir/firefox-package.txt"
grep -m1 'versionName=158.0.2' "$results_dir/firefox-package.txt"
# Shared storage mounts after boot completes; until then /sdcard fails "Transport endpoint is not connected".
for _ in $(seq 1 60); do adb shell ls /sdcard/ >/dev/null 2>&1 && break; sleep 2; done
adb shell mkdir -p /sdcard/Download
adb push "$RUNNER_TEMP/auth-tab-cert/auth-tab-root-ca.crt" /sdcard/Download/auth-tab-root-ca.crt

run_instrumentation_test com.miden.wallet.AuthTabCertificateSetupTest certificate-setup.log \
  caSubject "$AUTH_TAB_CA_SUBJECT" devicePin "$device_pin"
grep -F "fixtureCaInstalled=true subject=$AUTH_TAB_CA_SUBJECT" "$results_dir/certificate-setup.log"

adb shell cmd role clear-role-holders --user 0 android.app.role.BROWSER
adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER com.android.chrome
run_instrumentation_test com.miden.wallet.AuthTabProviderAcceptanceTest chrome-capability.log \
  expectedProvider com.android.chrome
grep -F 'selectedProvider=com.android.chrome' "$results_dir/chrome-capability.log"
grep -F 'provider=com.android.chrome ' "$results_dir/chrome-capability.log" | grep -F 'authTabSupported=true'
grep -F 'provider=org.mozilla.firefox ' "$results_dir/chrome-capability.log" | grep -F 'authTabSupported=false'

adb shell cmd role clear-role-holders --user 0 android.app.role.BROWSER
adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER org.mozilla.firefox
run_instrumentation_test com.miden.wallet.AuthTabProviderAcceptanceTest firefox-capability.log \
  expectedProvider org.mozilla.firefox
grep -F 'selectedProvider=org.mozilla.firefox' "$results_dir/firefox-capability.log"
grep -F 'provider=org.mozilla.firefox ' "$results_dir/firefox-capability.log" | grep -F 'authTabSupported=false'

yarn playwright test --config playwright.android.auth-tab.config.ts
node <<'NODE'
const r = require('./test-results-auth-tab/results.json');
if (!r.stats || r.stats.expected !== 1) {
  console.error('Expected one executed Auth Tab test, got', r.stats);
  process.exit(1);
}
NODE
