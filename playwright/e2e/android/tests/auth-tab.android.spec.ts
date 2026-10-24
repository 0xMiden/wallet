import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { expect, test, type TestInfo } from '@playwright/test';

import { AndroidWalletPage } from '../helpers/android-wallet-page';
import { CdpBridge } from '../helpers/cdp-bridge';
import { EmulatorControl } from '../helpers/emulator-control';
import { startAuthTabFixtureServer, type AuthTabFixtureServer } from '../../harness/auth-tab-fixture-server';

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = 'com.miden.wallet';
const SERIAL = process.env.ANDROID_SERIAL ?? 'emulator-5554';
const HOST_PORT = 9230;
const APK_PATH = 'android/app/build/outputs/apk/debug/app-debug.apk';
// The CI lane installs a pinned Chromium as the Auth Tab provider (see e2e-dapp-browser.yml).
const AUTH_TAB_PROVIDER = process.env.AUTH_TAB_PROVIDER ?? 'com.android.chrome';
const PROVIDERS = {
  authTab: { packageName: AUTH_TAB_PROVIDER, label: 'auth-tab' },
  firefox: { packageName: 'org.mozilla.firefox', label: 'firefox' }
} as const;

interface BrowserSession {
  origin: string;
  status: string;
  isLoading: boolean;
}

interface BrowserState {
  mode: string;
  sessions: BrowserSession[];
}

async function adb(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('adb', ['-s', SERIAL, ...args], { timeout: 30_000 });
  return stdout;
}

async function setDefaultBrowser(packageName: string): Promise<void> {
  await adb('shell', 'cmd', 'role', 'clear-role-holders', '--user', '0', 'android.app.role.BROWSER');
  await adb('shell', 'cmd', 'role', 'add-role-holder', '--user', '0', 'android.app.role.BROWSER', packageName);
}

async function waitForResumedPackage(packageName: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const dump = await adb('shell', 'dumpsys', 'activity', 'activities');
        const resumed = dump.match(/(?:mResumedActivity|topResumedActivity)[^\n]*/g) ?? [];
        return resumed.some(line => line.includes(`${packageName}/`));
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe(true);
}

async function currentBrowserState(wallet: AndroidWalletPage): Promise<BrowserState | null> {
  return wallet.evalJs<BrowserState | null>(
    `return window.__TEST_DAPP_BROWSER__ ? JSON.parse(JSON.stringify(window.__TEST_DAPP_BROWSER__)) : null;`
  );
}

async function waitForDappSession(wallet: AndroidWalletPage, origin: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await currentBrowserState(wallet);
        return Boolean(
          state?.mode === 'active' &&
          state.sessions.some(session => session.origin === origin && session.status === 'active' && !session.isLoading)
        );
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe(true);
}

async function runAttempt(
  wallet: AndroidWalletPage,
  fixture: AuthTabFixtureServer,
  provider: (typeof PROVIDERS)[keyof typeof PROVIDERS],
  mode: 'success' | 'hold',
  testInfo: TestInfo
): Promise<void> {
  const expectedOutcome = mode === 'success' ? 'resolved' : 'cancelled';
  const id = fixture.queue(mode);
  const result = fixture.waitForResult(id);
  await fixture.waitForStarted(id);
  if (mode === 'hold') {
    await waitForResumedPackage(provider.packageName);
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  }
  await expect(result).resolves.toBe(expectedOutcome);
  expect(fixture.resultCount(id)).toBe(1);
  await waitForResumedPackage(PACKAGE_NAME);
  const origin = new URL(fixture.dappUrl()).origin;
  await waitForDappSession(wallet, origin);
  await wallet.screenshot({ path: testInfo.outputPath(`${provider.label}-${mode}.png`) });
}

test.describe('Android Auth Tab acceptance', () => {
  test.describe.configure({ mode: 'serial' });

  let fixture: AuthTabFixtureServer | undefined;
  let cdp: Awaited<ReturnType<typeof CdpBridge.connect>> | undefined;
  let wallet: AndroidWalletPage | undefined;

  test.beforeAll(async () => {
    const keyPath = process.env.AUTH_TAB_KEY_PATH;
    const certPath = process.env.AUTH_TAB_CERT_PATH;
    if (!keyPath || !certPath) throw new Error('AUTH_TAB_KEY_PATH and AUTH_TAB_CERT_PATH are required');
    fixture = await startAuthTabFixtureServer({
      deviceHost: '10.0.2.2',
      key: readFileSync(keyPath),
      cert: readFileSync(certPath)
    });
    const emulator = new EmulatorControl();
    // run-auth-tab-acceptance.sh has already installed every APK and run the instrumentation on this device, so
    // the cold-boot readiness wait (which also waits for Play services' persistent process) adds nothing here.
    await emulator.terminate(SERIAL, PACKAGE_NAME);
    await emulator.install(SERIAL, APK_PATH, PACKAGE_NAME);
    await emulator.wipeAppState(SERIAL, PACKAGE_NAME);
    await emulator.grantNotifications(SERIAL, PACKAGE_NAME);
    await emulator.launch(SERIAL, PACKAGE_NAME);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    cdp = await CdpBridge.connect({ serial: SERIAL, packageName: PACKAGE_NAME, hostPort: HOST_PORT });
    wallet = new AndroidWalletPage({ cdp, emulator, serial: SERIAL, packageName: PACKAGE_NAME });
    await wallet.createGuardianWallet();
    await wallet.navigateTo('/browser');
    await wallet.waitFor('[data-testid="explore-launcher"]', { timeoutMs: 30_000 });
    await wallet.evalJs(`
      if (!document.querySelector('[data-testid="dapp-hero-search"]'))
        document.querySelector('[data-testid="explore-search-toggle"]').click();
      return null;
    `);
    await wallet.waitFor('[data-testid="dapp-hero-search"]', { timeoutMs: 30_000 });
    await wallet.evalJs(`
      var input = document.querySelector('[data-testid="dapp-hero-search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(fixture.dappUrl())});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return null;
    `);
    await fixture.waitForDappLoad();
    await waitForDappSession(wallet, new URL(fixture.dappUrl()).origin);
  });

  // The failing screen is usually another app's (a browser prompt, a wallet approval), so capture the device itself.
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    const capture = async (name: string, ...args: string[]): Promise<void> => {
      try {
        const { stdout } = await execFileAsync('adb', ['-s', SERIAL, ...args], {
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
          encoding: 'buffer'
        });
        await testInfo.attach(name, { body: stdout });
      } catch (error) {
        await testInfo.attach(name, { body: String(error) });
      }
    };
    await capture('device-screen.png', 'exec-out', 'screencap', '-p');
    await capture('device-focus.txt', 'shell', 'dumpsys', 'window', 'displays');
    await capture('device-logcat.txt', 'logcat', '-d', '-t', '1500');
  });

  test.afterAll(async () => {
    await cdp?.close();
    await fixture?.stop();
  });

  test('Chrome Auth Tab and Firefox Custom Tab resolve and cancel while retaining the dApp session', async ({}, testInfo) => {
    if (!fixture || !wallet) throw new Error('Auth Tab acceptance setup did not complete');
    await setDefaultBrowser(PROVIDERS.authTab.packageName);
    await runAttempt(wallet, fixture, PROVIDERS.authTab, 'success', testInfo);
    await runAttempt(wallet, fixture, PROVIDERS.authTab, 'hold', testInfo);

    await setDefaultBrowser(PROVIDERS.firefox.packageName);
    await runAttempt(wallet, fixture, PROVIDERS.firefox, 'success', testInfo);
    await runAttempt(wallet, fixture, PROVIDERS.firefox, 'hold', testInfo);
  });
});
