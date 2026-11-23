import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const coarse = 'swipe-reply-started-no-injected: socket-inactivity\n';
const eligible = `${coarse.trimEnd()}: first-swipe-eligible\n`;
const milestone = step => `\nDAPP_SWIPE_MILESTONE_V1 ${step}\n`;
const enter = milestone('enter');
const succeeded = milestone('swipe-succeeded');
const built = milestone('reply-built');
const returned = milestone('write-returned');
const ready = 'DappGestureInput ready port=8736\n';
const cap = 1024 * 1024;
const atCap = '\n'.repeat(cap - Buffer.byteLength(ready + enter)) + enter;

// Install the stand-ins before sourcing the unmodified runner in the same shell.
const stubs = String.raw`
fixture_error() { : > "$FIXTURE/stub-error"; return 98; }
git() {
  case "$*" in
    'rev-parse HEAD') echo fixture-head ;;
    'rev-parse HEAD^{tree}') echo fixture-tree ;;
    *) fixture_error ;;
  esac
}
sha256sum() {
  case "$*" in
    '--check') IFS= read -r sum && [[ "$sum" == 'fixture-sha  fixture-webview.apk' ]] || fixture_error ;;
    'android/app/build/outputs/apk/debug/app-debug.apk android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk') : ;;
    *) fixture_error ;;
  esac
}
timeout() {
  [[ "$2" == adb ]] || { fixture_error; return; }
  shift
  "$@"
}
adb() {
  case "$*" in
    'shell getprop ro.build.version.sdk') echo 36 ;;
    'shell getprop ro.build.type') echo userdebug ;;
    'shell id -u') echo 0 ;;
    'shell dumpsys webviewupdate') echo 'Current WebView package (name, version): (com.android.webview, 158.0.8121.0)' ;;
    'shell cmd overlay list --user 0') echo '[x] com.android.internal.systemui.navbar.gestural' ;;
    'shell settings get secure navigation_mode') echo 2 ;;
    'shell settings get secure immersive_mode_confirmations') echo confirmed ;;
    'shell getprop ro.build.fingerprint') echo fixture-fingerprint ;;
    'root'|'wait-for-device'|'shell cmd webviewupdate set-webview-implementation com.android.webview'|\
    'shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural'|\
    'shell settings put global window_animation_scale 1'|'shell settings put global transition_animation_scale 1'|\
    'shell settings put global animator_duration_scale 1'|'shell svc power stayon true'|\
    'shell settings put system screen_off_timeout 2147483647'|'shell wm dismiss-keyguard'|\
    'shell settings put secure immersive_mode_confirmations confirmed'|\
    'install -r -t --no-streaming fixture-webview.apk'|\
    'install -r -t --no-streaming android/app/build/outputs/apk/debug/app-debug.apk'|\
    'install -r -t --no-streaming android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'|\
    'shell pm clear com.miden.wallet'|'shell pm grant com.miden.wallet android.permission.POST_NOTIFICATIONS') : ;;
    'forward --no-rebind tcp:9236 tcp:8736') echo forward >> "$FIXTURE/events" ;;
    'forward --remove tcp:9236') echo remove >> "$FIXTURE/events" ;;
    'shell am instrument -w -e class com.miden.wallet.DappPresentationGestureInputTest com.miden.wallet.test/androidx.test.runner.AndroidJUnitRunner')
      echo instrument >> "$FIXTURE/events"
      cat "$FIXTURE/ready"
      : > "$FIXTURE/bridge-ready" ;;
    'shell pidof com.miden.wallet')
      # The fake instrumentation command is backgrounded by the runner.
      local i
      for ((i=0; i<100; i++)); do
        if [[ -f "$FIXTURE/bridge-ready" ]]; then echo 123; return; fi
        sleep 0.02
      done
      fixture_error ;;
    *) fixture_error ;;
  esac
}
yarn() {
  [[ "$*" == 'playwright test --config playwright.android.presentation-gesture.config.ts' &&
     "$GESTURE_TARGET_PID" == 123 && "$DAPP_PRESENTATION_GESTURE_API36" == 1 &&
     -f "$FIXTURE_CAPTURE" ]] || { fixture_error; return; }
  echo playwright >> "$FIXTURE/events"
  cat "$FIXTURE/prefix" >> "$FIXTURE_CAPTURE" || { fixture_error; return; }
  if [[ -s "$FIXTURE/late" ]]; then
    ln "$FIXTURE_CAPTURE" "$FIXTURE/late-target" || { fixture_error; return; }
  fi
  if [[ -s "$FIXTURE/prior-write" ]]; then
    cat "$FIXTURE/prior-write" >> "$FIXTURE/prior-target" || { fixture_error; return; }
    : > "$FIXTURE/prior-written" || { fixture_error; return; }
  fi
  case "$FIXTURE_CHANGE" in
    replace) mv "$FIXTURE_CAPTURE" "$FIXTURE/original-capture"; cp "$FIXTURE/original-capture" "$FIXTURE_CAPTURE" ;;
    remove) rm -f "$FIXTURE_CAPTURE" ;;
  esac
  cat "$FIXTURE/marker" > "$PRESENTATION_GESTURE_STAGE_FILE" || { fixture_error; return; }
  if [[ "$FIXTURE_READ_ONLY_STAGE" == true ]]; then
    chmod 400 "$PRESENTATION_GESTURE_STAGE_FILE" &&
      [[ -r "$PRESENTATION_GESTURE_STAGE_FILE" && ! -w "$PRESENTATION_GESTURE_STAGE_FILE" && -w "$FIXTURE" ]] ||
      { fixture_error; return; }
  fi
  return 23
}
node() {
  if [[ "$#" == 0 ]]; then
    local js
    js=$(cat)
    if [[ "$js" == *"JSON.stringify({id:2147483647,op:'stop'})"* ]]; then
      # Model later bridge output at the first teardown action, not with a timer.
      echo stop >> "$FIXTURE/events"
      if [[ -s "$FIXTURE/late" ]]; then
        [[ -f "$FIXTURE/late-target" ]] && cat "$FIXTURE/late" >> "$FIXTURE/late-target" || { fixture_error; return; }
      fi
      return 0
    fi
    printf '%s\n' "$js" | "$FIXTURE_NODE" --require "$FIXTURE/no-socket.cjs"
  else
    "$FIXTURE_NODE" --require "$FIXTURE/no-socket.cjs" "$@"
  fi
}
`;

const scripts = dirname(fileURLToPath(import.meta.url));
const runner = '.github/scripts/run-dapp-presentation-gesture-api36.sh';

for (const row of [
  { name: 'enter only', prefix: enter, label: 'native-enter-only' },
  { name: 'failed refinement preserves a readable eligibility marker', prefix: enter, readOnlyStage: true },
  { name: 'swipe succeeded', prefix: enter + succeeded, label: 'native-swipe-succeeded' },
  { name: 'reply built', prefix: enter + succeeded + built, label: 'native-reply-built' },
  { name: 'write returned', prefix: enter + succeeded + built + returned, label: 'native-write-returned' },
  { name: 'the exact 1 MiB prefix is eligible', prefix: atCap, label: 'native-enter-only' },
  {
    name: 'later bytes on the same file do not advance the snapshot',
    prefix: enter,
    late: succeeded + built + returned,
    label: 'native-enter-only'
  },
  {
    name: 'a conflict after the snapshot does not invalidate it',
    prefix: enter,
    late: enter,
    label: 'native-enter-only'
  },
  { name: 'no native milestone' },
  { name: 'missing capture', prefix: enter, change: 'remove' },
  { name: 'preexisting bytes are not evidence', stale: enter + succeeded },
  {
    name: 'bytes from a prior writer do not contaminate a fresh capture',
    stale: enter + succeeded,
    priorWrite: succeeded + built,
    prefix: enter,
    label: 'native-enter-only'
  },
  { name: 'a different inode with identical bytes is not evidence', prefix: enter, change: 'replace' },
  { name: 'a prefix one byte over 1 MiB is unavailable', prefix: atCap + '\n' },
  { name: 'out of order', prefix: enter + built },
  { name: 'duplicate diagnostic', prefix: enter + succeeded + succeeded },
  { name: 'partial diagnostic tail', prefix: enter + '\nDAPP_SWIPE_MILE' },
  { name: 'otherwise exact diagnostic with no final LF', prefix: enter + succeeded.slice(0, -1) },
  { name: 'trailing data inside a diagnostic', prefix: enter + milestone('swipe-succeeded junk') },
  { name: 'coarse inactivity alone is not first-swipe eligibility', prefix: enter + succeeded, marker: coarse },
  { name: 'an internal marker plus junk is not eligible', prefix: enter, marker: `${eligible}synthetic junk\n` }
]) {
  test(`private API36 runner: ${row.name}`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'api36-runner-test-'));
    const fixture = join(cwd, 'fixture');
    const capture = join(cwd, 'test-results-presentation-gesture', 'instrumentation.txt');
    const stage = join(fixture, 'stage');
    try {
      mkdirSync(fixture);
      mkdirSync(join(cwd, '.github'));
      symlinkSync(scripts, join(cwd, '.github/scripts'), 'dir');
      mkdirSync(dirname(capture));
      if (row.stale) writeFileSync(capture, row.stale);
      if (row.priorWrite) linkSync(capture, join(fixture, 'prior-target'));
      writeFileSync(join(fixture, 'prior-write'), row.priorWrite ?? '');
      writeFileSync(join(fixture, 'stubs.bash'), stubs);
      writeFileSync(join(fixture, 'ready'), ready);
      writeFileSync(join(fixture, 'marker'), row.marker ?? eligible);
      writeFileSync(join(fixture, 'prefix'), row.prefix ?? '');
      writeFileSync(join(fixture, 'late'), row.late ?? '');
      writeFileSync(
        join(fixture, 'no-socket.cjs'),
        `require('node:net').Socket.prototype.connect = () => {
          require('node:fs').writeFileSync(process.env.FIXTURE + '/stub-error', '');
          throw new Error('Socket forbidden in the runner fixture');
        };\n`
      );
      const child = spawnSync('/bin/bash', ['-c', 'source "$FIXTURE/stubs.bash" || exit 98; source "$0"', runner], {
        cwd,
        stdio: 'ignore',
        timeout: 10_000,
        env: {
          PATH: '/usr/bin:/bin',
          FIXTURE: fixture,
          FIXTURE_CAPTURE: capture,
          FIXTURE_CHANGE: row.change ?? '',
          FIXTURE_READ_ONLY_STAGE: String(row.readOnlyStage ?? false),
          FIXTURE_NODE: process.execPath,
          GITHUB_SHA: 'fixture-head',
          PRESENTATION_WEBVIEW_SHA256: 'fixture-sha',
          PRESENTATION_WEBVIEW_APK: 'fixture-webview.apk',
          PRESENTATION_GESTURE_PRIVATE_OUTPUT: 'true',
          PRESENTATION_GESTURE_STAGE_FILE: stage
        }
      });
      assert.ifError(child.error);
      assert.equal(existsSync(join(fixture, 'stub-error')), false, 'unexpected setup/device call');
      assert.equal(child.status, 23, 'the fake Playwright exit must survive runner teardown');
      assert.equal(readFileSync(join(fixture, 'events'), 'utf8'), 'forward\ninstrument\nplaywright\nstop\nremove\n');
      assert.equal(existsSync(`${stage}.native-swipe`), false, 'only the existing stage file carries the verdict');
      if (row.late) {
        assert.equal(readFileSync(join(fixture, 'late-target'), 'utf8'), ready + row.prefix + row.late,
          'the late append reached the original capture inode');
      }
      if (row.priorWrite) {
        assert.equal(existsSync(join(fixture, 'prior-written')), true, 'the prior writer appended after capture began');
        assert.ok(readFileSync(join(fixture, 'prior-target'), 'utf8').endsWith(row.priorWrite));
      }
      assert.ok(existsSync(stage), 'the runner must retain its private verdict marker');
      const actual = readFileSync(stage, 'utf8');
      if (row.readOnlyStage) {
        assert.equal(actual, eligible, 'an open failure must retain the exact eligibility marker');
      } else if (row.label) {
        assert.equal(actual, `${coarse.trimEnd()}: ${row.label}\n`);
      } else if (row.marker) {
        assert.equal(actual, row.marker);
      } else {
        // Either the runner or the wrapper can implement the exact coarse fallback.
        assert.ok(actual === eligible || actual === coarse, 'unavailable native evidence must not refine the stage');
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
