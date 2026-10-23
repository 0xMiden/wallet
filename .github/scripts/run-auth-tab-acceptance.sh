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

run_instrumentation_test() {
  local test_class=$1
  local log_name=$2
  shift 2
  # The report is named after the device (TEST-<device> - <api>-_app-.xml), not the test class.
  local report_dir="android/app/build/outputs/androidTest-results/connected/debug"
  local gradle_status=0

  adb logcat -c
  if (cd android && ./gradlew :app:connectedDebugAndroidTest \
    "-Pandroid.testInstrumentationRunnerArguments.class=$test_class" "$@"); then
    :
  else
    gradle_status=$?
  fi
  if ! timeout 15s adb logcat -d -s AuthTabAcceptance:I '*:S' > "$results_dir/$log_name"; then
    echo 'adb_logcat=unavailable' > "$results_dir/${log_name%.log}-status.txt"
  fi
  if [[ $gradle_status -ne 0 ]]; then
    return "$gradle_status"
  fi
  grep -h 'tests="[1-9]' "$report_dir"/TEST-*.xml
}

adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
device_pin=1234
adb shell locksettings set-pin "$device_pin" >/dev/null
# sys.boot_completed can precede a package manager that accepts installs ("Broken pipe" from the package service).
for _ in $(seq 1 30); do adb shell pm path android >/dev/null 2>&1 && break; sleep 2; done
for attempt in 1 2 3; do
  if adb install -r "$RUNNER_TEMP/firefox.apk"; then break; fi
  [[ $attempt -eq 3 ]] && exit 1
  sleep 10
done
adb shell dumpsys package org.mozilla.firefox > "$results_dir/firefox-package.txt"
grep -m1 'versionName=158.0.2' "$results_dir/firefox-package.txt"
adb shell mkdir -p /sdcard/Download
adb push "$RUNNER_TEMP/auth-tab-cert/auth-tab-root-ca.crt" /sdcard/Download/auth-tab-root-ca.crt

run_instrumentation_test com.miden.wallet.AuthTabCertificateSetupTest certificate-setup.log \
  "-Pandroid.testInstrumentationRunnerArguments.caSubject=$AUTH_TAB_CA_SUBJECT" \
  "-Pandroid.testInstrumentationRunnerArguments.devicePin=$device_pin"
grep -F "fixtureCaInstalled=true subject=$AUTH_TAB_CA_SUBJECT" "$results_dir/certificate-setup.log"

adb shell cmd role clear-role-holders --user 0 android.app.role.BROWSER
adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER com.android.chrome
run_instrumentation_test com.miden.wallet.AuthTabProviderAcceptanceTest chrome-capability.log \
  -Pandroid.testInstrumentationRunnerArguments.expectedProvider=com.android.chrome
grep -F 'selectedProvider=com.android.chrome' "$results_dir/chrome-capability.log"
grep -F 'provider=com.android.chrome ' "$results_dir/chrome-capability.log" | grep -F 'authTabSupported=true'
grep -F 'provider=org.mozilla.firefox ' "$results_dir/chrome-capability.log" | grep -F 'authTabSupported=false'

adb shell cmd role clear-role-holders --user 0 android.app.role.BROWSER
adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER org.mozilla.firefox
run_instrumentation_test com.miden.wallet.AuthTabProviderAcceptanceTest firefox-capability.log \
  -Pandroid.testInstrumentationRunnerArguments.expectedProvider=org.mozilla.firefox
grep -F 'selectedProvider=org.mozilla.firefox' "$results_dir/firefox-capability.log"
grep -F 'provider=org.mozilla.firefox ' "$results_dir/firefox-capability.log" | grep -F 'authTabSupported=false'

(cd android && ./gradlew --stop)
yarn playwright test --config playwright.android.auth-tab.config.ts
node <<'NODE'
const r = require('./test-results-auth-tab/results.json');
if (!r.stats || r.stats.expected !== 1) {
  console.error('Expected one executed Auth Tab test, got', r.stats);
  process.exit(1);
}
NODE
