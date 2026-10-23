/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JOURNEY_TIMEOUT_MS } from '../helpers/dapp-matrix';

const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-dapp.yml'), 'utf8');

const partFiles = (part: string): string[] =>
  workflow.match(new RegExp(`^\\s+${part}\\) files="([a-z -]+)" ;;$`, 'm'))?.[1]?.split(' ') ?? [];

/** One job's block, from its id line to the next job's. */
const jobBlock = (id: string, source = workflow, file = 'e2e-dapp.yml'): string => {
  const start = source.indexOf(`\n  ${id}:\n`);
  if (start === -1) throw new Error(`${file} has no job ${id}`);
  const next = source.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
};

describe('dApp E2E workflow', () => {
  it('runs only by dispatch (Release E2E starts it), never on a push, a pull request or a timer of its own', () => {
    expect(workflow).toMatch(/\non:\n {2}workflow_dispatch:/);
    expect(workflow).not.toMatch(/pull_request|schedule:|\n {2}push:/);
  });

  it('pairs main with testnet and next with devnet, as e2e-blockchain.yml does, and never runs the local stack', () => {
    expect(workflow).toContain("github.ref == 'refs/heads/next' && 'devnet' || 'testnet'");
    expect(workflow).toMatch(/E2E_NETWORK: \$\{\{ matrix\.network \}\}/);
    expect(workflow).not.toMatch(/localhost|local-stack|run-local-node|docker/);
  });

  it('runs every leg to the end on first attempts only and cancels superseded runs', () => {
    expect(workflow).toMatch(/fail-fast: false/);
    expect(workflow).toMatch(/--retries=0/);
    expect(workflow).not.toMatch(/--retries=[1-9]/);
    expect(workflow).toMatch(
      /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true/
    );
  });

  it('bounds the run step and still renders, uploads and judges after it', () => {
    expect(workflow).toMatch(/id: run\n\s+continue-on-error: true\n\s+timeout-minutes: 170/);
    expect(workflow).toMatch(/timeout-minutes: \$\{\{ github\.event_name == 'workflow_dispatch' && 250 \|\| 220 \}\}/);
    for (const step of ['Render matrix', 'Upload records', 'Judge']) {
      expect(workflow).toMatch(new RegExp(`- name: ${step}\\n\\s+if: always\\(\\)`));
    }
    // The report carries each journey's duration against its timeout (spec section 6, flake controls).
    expect(workflow).toContain(
      'node scripts/render-dapp-matrix.mjs test-results/dapp-cells test-results/results.json >> "$GITHUB_STEP_SUMMARY"'
    );
    expect(workflow).toMatch(/render-dapp-matrix\.mjs --gate test-results\/dapp-cells test-results\/results\.json/);
  });

  it('splits the journeys into the two parts of spec section 6 and selects every dApp spec file in one of them', () => {
    expect(partFiles('core')).toEqual(['session', 'signing-and-refusals', 'accounts-and-dapps', 'react-adapter']);
    expect(partFiles('writes')).toEqual(['wallet-writes-and-notes', 'custom-requests']);
    // A spec file no part names would never run, and the judge sees only the tests a run selected.
    const selected = [...partFiles('core'), ...partFiles('writes')];
    const specs = readdirSync(resolve(__dirname, '../tests/dapp'))
      .filter(name => name.endsWith('.spec.ts'))
      .map(name => name.replace(/\.spec\.ts$/, ''));
    expect(specs).toContain('session');
    expect(selected).toEqual(expect.arrayContaining(specs));
  });
});

describe('the mobile legs of the dApp E2E workflow', () => {
  const ios = jobBlock('dapp-e2e-ios');
  const android = jobBlock('dapp-e2e-android');

  it('runs the in-app browser journey on two iOS simulators and two Android emulators, one account kind per leg', () => {
    expect(ios).toContain('runs-on: macos-26-xlarge');
    expect(android).toContain('runs-on: ubuntu-latest');
    expect(ios).toContain('--config playwright.ios.dapp-e2e.config.ts');
    expect(android).toContain('--config playwright.android.dapp-e2e.config.ts');
    for (const job of [ios, android]) {
      expect(job).toMatch(/fail-fast: false/);
      expect(job).toMatch(/axis: \[offchain, guardian\]/);
      expect(job).toContain("github.ref == 'refs/heads/next' && 'devnet' || 'testnet'");
      expect(job).toMatch(/E2E_NETWORK: \$\{\{ matrix\.network \}\}/);
      expect(job).toMatch(/--grep " - \$\{\{ matrix\.axis \}\} account" --retries=0/);
    }
    // One run step per job, each on first attempts only.
    expect(workflow.match(/--retries=0/g)).toHaveLength(3);
  });

  it('lets a dispatch pick the surfaces, and runs every surface by default', () => {
    expect(workflow).toMatch(
      /surface:\n\s+description: Which surfaces run\n\s+type: choice\n\s+options: \[all, extension, mobile\]\n\s+default: all/
    );
    expect(jobBlock('dapp-e2e')).toMatch(/if: \$\{\{ inputs\.surface != 'mobile' \}\}/);
    expect([ios, android].filter(job => !/if: \$\{\{ inputs\.surface != 'extension' \}\}/.test(job))).toEqual([]);
  });

  it('bounds each mobile run step around the journey timeout and still renders, uploads and judges after it', () => {
    for (const job of [ios, android]) {
      expect(job).toMatch(/id: run\n\s+continue-on-error: true\n\s+timeout-minutes: 95/);
      for (const step of ['Render matrix', 'Upload records', 'Judge']) {
        expect(job).toMatch(new RegExp(`- name: ${step}\\n\\s+if: always\\(\\)`));
      }
      expect(job).toMatch(/render-dapp-matrix\.mjs --gate test-results\/dapp-cells test-results\/results\.json/);
    }
    // The global setup's probes and the report write fit in the step after a journey that used its whole timeout.
    expect(JOURNEY_TIMEOUT_MS.PL).toBeLessThanOrEqual((95 - 5) * 60_000);
    expect(ios).toMatch(/timeout-minutes: \$\{\{ github\.event_name == 'workflow_dispatch' && 245 \|\| 160 \}\}/);
    expect(android).toMatch(/timeout-minutes: \$\{\{ github\.event_name == 'workflow_dispatch' && 190 \|\| 145 \}\}/);
  });

  it('pins PL1 to a gated-presentation image while the dApp browser suite stays on Android 34 (C-P32)', () => {
    const browser = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-dapp-browser.yml'), 'utf8');
    const browserAndroid = jobBlock('android-dapp-browser', browser, 'e2e-dapp-browser.yml');
    const authTab = jobBlock('android-auth-tab-acceptance', browser, 'e2e-dapp-browser.yml');
    const images = (text: string): string[] => [
      ...new Set(text.match(/system-images;android-\d+(?:\.\d+)?;[a-z_]+;x86_64/g) ?? [])
    ];
    expect(images(android)).toEqual(['system-images;android-37.0;google_apis;x86_64']);
    expect(images(browserAndroid)).toEqual(['system-images;android-34;default;x86_64']);
    expect(images(authTab)).toEqual(['system-images;android-36;google_apis_playstore;x86_64']);
    expect(authTab).toContain("if: github.event_name == 'workflow_dispatch' && inputs.suite == 'auth-tab'");
    expect(authTab).toMatch(/timeout-minutes: \$\{\{ github\.event_name == 'workflow_dispatch' && 90 \|\| 60 \}\}/);
    expect(android).toContain('E2E_ANDROID_BASE_AVD: Pixel_API_37');
    expect(android).toContain('--name "$E2E_ANDROID_BASE_AVD"');
    expect(android).toContain('grep -qx "$E2E_ANDROID_BASE_AVD"');
    // Older SDK tools write android-0 for dotted API levels, even when the image download succeeds.
    expect(android).toContain("cmdline-tools-version: '15859902'");
    expect(android).toContain('packages: platform-tools');
    expect(android).toContain('ls -l /dev/kvm');
    for (const command of ['"$ANDROID_HOME/emulator/emulator" -accel-check', 'nproc', 'free -m', 'vmstat 1 3']) {
      expect(android).toContain(`${command} || echo "`);
    }
    for (const name of ['Install SDK packages', 'Collect emulator logs']) {
      const step = android.match(new RegExp(`      - name: ${name}\\n(?:(?!      - ).*\\n)*`))?.[0];
      expect(step).toBeDefined();
      expect(step).not.toContain('continue-on-error:');
    }
    const emulator = readFileSync(resolve(__dirname, '../android/helpers/emulator-control.ts'), 'utf8');
    expect(emulator).toContain("const BASE_AVD = process.env.E2E_ANDROID_BASE_AVD ?? 'Pixel_API_34';");
  });

  it('stops the Auth Tab Gradle daemon after the Firefox probe and before Playwright', () => {
    const browser = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-dapp-browser.yml'), 'utf8');
    const authTab = jobBlock('android-auth-tab-acceptance', browser, 'e2e-dapp-browser.yml');
    const acceptance = readFileSync(resolve(__dirname, '../../../.github/scripts/run-auth-tab-acceptance.sh'), 'utf8');
    const firefox = acceptance.indexOf('expectedProvider=org.mozilla.firefox');
    const stop = acceptance.indexOf('./gradlew --stop');
    const playwright = acceptance.indexOf('yarn playwright test --config playwright.android.auth-tab.config.ts');

    expect(authTab).toContain('bash .github/scripts/run-auth-tab-acceptance.sh');
    expect(firefox).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(firefox);
    expect(stop).toBeLessThan(playwright);
  });

  it('runs the full Auth Tab acceptance inside the bounded shared Google Play emulator runner', () => {
    const browser = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-dapp-browser.yml'), 'utf8');
    const authTab = jobBlock('android-auth-tab-acceptance', browser, 'e2e-dapp-browser.yml');
    const runner = authTab
      .split('- name: Run Auth Tab acceptance on Google Play emulator')[1]
      ?.split('\n      - name:')[0] ?? '';
    const acceptance = readFileSync(resolve(__dirname, '../../../.github/scripts/run-auth-tab-acceptance.sh'), 'utf8');
    const prepare = [
      authTab.indexOf('name: Download pinned Firefox provider'),
      authTab.indexOf('name: Build debug APK'),
      authTab.indexOf('name: Generate run-scoped fixture CA and TLS certificate')
    ];
    const runnerPosition = authTab.indexOf('name: Run Auth Tab acceptance on Google Play emulator');

    expect(prepare.every(position => position >= 0 && position < runnerPosition)).toBe(true);
    expect(runner).toContain('timeout-minutes: 80');
    expect(runner).toContain('uses: reactivecircus/android-emulator-runner@v2');
    expect(runner).toContain('target: google_apis_playstore');
    expect(runner).toContain('emulator-boot-timeout: 600');
    expect(runner).toContain('bash .github/scripts/run-auth-tab-acceptance.sh');
    const pinBinding = acceptance.indexOf('device_pin=1234');
    const pinSet = acceptance.indexOf('adb shell locksettings set-pin "$device_pin"');
    const certificateSetup = acceptance.indexOf('AuthTabCertificateSetupTest');
    const pinArgument = acceptance.indexOf('-Pandroid.testInstrumentationRunnerArguments.devicePin=$device_pin');
    expect(pinBinding).toBeGreaterThan(-1);
    expect(pinSet).toBeGreaterThan(pinBinding);
    expect(acceptance.split('devicePin=$device_pin')).toHaveLength(2);
    expect(pinArgument).toBeGreaterThan(certificateSetup);
    expect(pinArgument).toBeLessThan(acceptance.indexOf('expectedProvider=com.android.chrome'));
    const certificateTest = readFileSync(
      resolve(__dirname, '../../../android/app/src/androidTest/java/com/miden/wallet/AuthTabCertificateSetupTest.java'),
      'utf8'
    );
    expect(certificateTest).toContain('By.res("com.android.settings", "password_entry")');
    expect(certificateTest).toContain('setText(devicePin)');
    expect(certificateTest).toContain('By.res("com.android.settings", "next_button")');
    expect(acceptance).toContain('yarn playwright test --config playwright.android.auth-tab.config.ts');
    expect(authTab).not.toContain('adb wait-for-device');
  });

  it('keeps Auth Tab evidence collection bounded when emulator boot or acceptance fails', () => {
    const browser = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-dapp-browser.yml'), 'utf8');
    const authTab = jobBlock('android-auth-tab-acceptance', browser, 'e2e-dapp-browser.yml');
    const acceptance = readFileSync(resolve(__dirname, '../../../.github/scripts/run-auth-tab-acceptance.sh'), 'utf8');
    const evidence = authTab.match(/- name: Write acceptance evidence\n(?:(?!      - name: ).*\n)*/)?.[0];
    expect(evidence).toMatch(/if: always\(\)\n\s+timeout-minutes: 2/);
    expect(evidence).not.toContain('adb logcat');
    expect(acceptance).toContain('trap write_acceptance_evidence EXIT');
    expect(acceptance).toContain('timeout 15s adb logcat');
  });

  it('assigns every in-app browser spec to the mobile leg of its platform', () => {
    const inapp = (dir: string): string[] =>
      readdirSync(resolve(__dirname, dir)).filter(name => /^dapp-inapp\..+\.spec\.ts$/.test(name));
    expect(inapp('../ios/tests')).toEqual(['dapp-inapp.ios.spec.ts']);
    expect(inapp('../android/tests')).toEqual(['dapp-inapp.android.spec.ts']);
    const configs = ['playwright.ios.dapp-e2e.config.ts', 'playwright.android.dapp-e2e.config.ts'];
    expect(
      configs.filter(
        config =>
          !readFileSync(resolve(__dirname, '../../..', config), 'utf8').includes("testMatch: '**/dapp-inapp.*.spec.ts'")
      )
    ).toEqual([]);
  });

  it('never reuses an app build across a run that injected a linked PR', () => {
    const notInjected =
      "if: steps.inject-web-sdk.outputs.patched != 'true' && steps.inject-guardian.outputs.patched != 'true'";
    expect(ios).toContain(`id: app-key\n        ${notInjected}`);
    expect(android).toContain(`id: apk-key\n        ${notInjected}`);
    expect(ios).toContain(
      "- name: Restore the app build\n        id: app-cache\n        if: steps.app-key.outputs.key != ''"
    );
    expect(android).toContain(
      "- name: Restore the APK build\n        id: apk-cache\n        if: steps.apk-key.outputs.key != ''"
    );
  });

  it('rebuilds the iOS app for a new Xcode, and stops Gradle only after a build started it', () => {
    expect(ios).toMatch(/xcode=\$\(xcodebuild -version \| git hash-object --stdin\)/);
    expect(ios).toMatch(/-\$\{tree:0:16\}-\$\{xcode:0:12\}" >> "\$GITHUB_OUTPUT"/);
    expect(android).toContain(
      "- name: Stop the Gradle daemon\n        if: steps.apk-cache.outputs.cache-hit != 'true'"
    );
  });

  // Without the fixture the wallet's access gate blocks onboarding, so no cell runs.
  it.each([
    ['dapp-e2e', 'yarn test:e2e:blockchain:build'],
    ['dapp-e2e-ios', 'yarn test:e2e:mobile:build'],
    ['dapp-e2e-android', 'yarn test:e2e:android:build']
  ])('starts the eligibility fixture before %s builds the wallet', (job, build) => {
    const block = jobBlock(job);
    const fixture = block.indexOf('uses: ./.github/actions/start-eligibility-fixture');
    expect(fixture).not.toBe(-1);
    expect(block.indexOf(build)).toBeGreaterThan(fixture);
  });

  // The failure-only log step runs before the records are uploaded and judged, so a wedged adb must not hold it.
  it.each<[string, number]>([
    ['e2e-dapp.yml', 8],
    ['e2e-android.yml', 5],
    ['e2e-dapp-browser.yml', 3]
  ])(
    'bounds every adb call and the emulator log step in %s',
    (file, calls) => {
      const text = readFileSync(resolve(__dirname, `../../../.github/workflows/${file}`), 'utf8');
      const step = text.match(/ {6}- name: Collect emulator logs.*\n(?:(?! {6}- ).*\n)*/)?.[0];
      expect(step).toBeDefined();
      expect(step).toMatch(/\n {8}timeout-minutes: \d+\n/);
      const adb = (step ?? '').split('\n').filter(line => /(^|\s)adb\s/.test(line));
      expect(adb).toHaveLength(calls);
      expect(adb.filter(line => !/timeout 15s adb\s/.test(line))).toEqual([]);
    }
  );
});
