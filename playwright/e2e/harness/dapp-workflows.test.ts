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
const jobBlock = (id: string): string => {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  if (start === -1) throw new Error(`e2e-dapp.yml has no job ${id}`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
};

describe('dApp E2E workflow', () => {
  it('runs on merges to main and next and by hand, never on a pull request or a timer', () => {
    expect(workflow).toMatch(/\non:\n {2}push:\n {4}branches: \[main, next\]\n {2}workflow_dispatch:/);
    expect(workflow).not.toMatch(/pull_request|schedule:/);
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

  it('lets a dispatch pick the surfaces, and runs every surface on a push', () => {
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
    const images = (text: string): string[] => [
      ...new Set(text.match(/system-images;android-\d+(?:\.\d+)?;[a-z_]+;x86_64/g) ?? [])
    ];
    expect(images(android)).toEqual(['system-images;android-37.0;google_apis;x86_64']);
    expect(images(browser)).toEqual(['system-images;android-34;default;x86_64']);
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
