/* eslint-disable no-empty-pattern -- Playwright parses the fixture function's source and requires
   the object destructuring pattern in its first argument; `async ({}, use)` is the required idiom. */
import * as fs from 'fs';

import {
  AGENTIC_TIMEOUT_MS,
  buildChromeSnapshotCaps,
  captureFailureSnapshot,
  closeContextQuietly,
  expect,
  getExtensionPath,
  installScreenCapture,
  launchWalletInstance,
  test as base,
  type GuardianAwareWalletPage
} from './two-wallets';
import { assertExtensionWalletApiMatches } from '../harness/extension-network';
import { type NetworkFaultPolicy } from '../harness/network-faults';
import { assertWalletApiAllowsExtension, walletApiBaseUrl } from '../harness/wallet-api-dev-server';

/**
 * The multi-device fixture: everything `two-wallets.ts` gives (`walletA`,
 * `walletB`, `midenCli`, `steps`, `envConfig`, `timeline`, the fault controls
 * on each wallet), plus:
 *
 * - `walletC`: a third Chrome profile, launched only when a test asks for it,
 *   with the same type, teardown and failure snapshot as `walletB`.
 * - `walletApi`: the local wallet-api Worker of the encrypted backup. Its setup
 *   fails the run before a browser launches when the built extension does not
 *   carry the Worker's URL (`MIDEN_WALLET_API_URL`). It also gives the fault
 *   and request-count controls for wallet-api traffic of each wallet.
 *
 * The suite's global setup (`harness/multi-device-global-setup.ts`) starts the
 * Worker before any test.
 */

/** A fault on the wallet-api requests of one wallet. Every `NetworkFaultPolicy` field but `target`. */
export type WalletApiFault = Omit<NetworkFaultPolicy, 'target'>;

/** Common wallet-api faults, so a spec names the intent and not the mode string. */
export const WALLET_API_FAULTS = {
  /** Every request gets HTTP 500. */
  serverError: { mode: 'status500' },
  /** Every request gets HTTP 429 with `Retry-After: <seconds>`. */
  rateLimited: (retryAfterSec: number): WalletApiFault => ({ mode: 'status429RetryAfter', retryAfterSec }),
  /** Every request fails as a refused connection (no HTTP response). */
  networkDown: { mode: 'connectionRefused' },
  /** The first `count` requests get HTTP 500, the later ones pass. */
  serverErrorFirst: (count: number): WalletApiFault => ({ mode: 'failFirstN', count })
} satisfies Record<string, WalletApiFault | ((value: number) => WalletApiFault)>;

export interface WalletApiControls {
  /** The Worker's base URL: `E2E_WALLET_API_URL`, else `http://127.0.0.1:8787`. No trailing slash. */
  readonly baseUrl: string;
  /**
   * Arm a fault on `wallet`'s wallet-api requests. It goes through the wallet's
   * `armNetworkFault`, so it REPLACES every network fault armed on that wallet.
   * Narrow it with `path` (for example `'/v1/storage'` or `'/v1/auth/'`).
   */
  armFault(wallet: GuardianAwareWalletPage, fault: WalletApiFault): Promise<void>;
  /** Disarm every fault on `wallet`: wallet-api, network and Guardian. */
  clearFaults(wallet: GuardianAwareWalletPage): Promise<void>;
  /** How many requests the armed faults of `wallet` answered since they were armed. */
  faultHits(wallet: GuardianAwareWalletPage): Promise<number>;
  /** How many requests `wallet` sent to the Worker since launch, faulted or not. Compare two reads. */
  requestCount(wallet: GuardianAwareWalletPage): number;
}

type MultiDeviceTestFixtures = {
  walletC: GuardianAwareWalletPage;
};

type MultiDeviceWorkerFixtures = {
  walletApi: WalletApiControls;
};

/** The base URL of the local Worker, read the same way the global setup that starts it reads it. */
export { walletApiBaseUrl };

const walletApiControls = (baseUrl: string): WalletApiControls => ({
  baseUrl,
  armFault: (wallet, fault) => wallet.armNetworkFault({ ...fault, target: 'walletApi' }),
  clearFaults: wallet => wallet.clearFaults(),
  faultHits: wallet => wallet.networkFaultHits(),
  requestCount: wallet => wallet.networkRequestCount('walletApi')
});

/**
 * Keep one blank tab open beside the wallet page.
 *
 * Headed Chromium (CI, under xvfb) ends the whole browser when its last tab closes. Then
 * `kill()` and `reopen()` do not close only the page, as their doc comments say and as headless
 * mode does: the service worker dies with the browser, `reopen()` relaunches from the profile, and
 * the faults that a spec armed, with their hit counters, stay on the dead context. With this tab
 * the two methods close only the wallet page in both modes. A spec that needs a dead browser
 * calls `killBrowser()`.
 */
async function keepBrowserAlive(wallet: GuardianAwareWalletPage): Promise<void> {
  await wallet.page.context().newPage();
  // The new tab took the foreground. The wallet pauses its display work in a hidden tab.
  await wallet.page.bringToFront();
}

export const test = base.extend<MultiDeviceTestFixtures, MultiDeviceWorkerFixtures>({
  walletApi: [
    async ({}, use) => {
      const baseUrl = walletApiBaseUrl();
      // Before any wallet launches: a build without the define never reaches the local Worker.
      assertExtensionWalletApiMatches(getExtensionPath(), baseUrl);
      await use(walletApiControls(baseUrl));
    },
    { scope: 'worker', auto: true }
  ],

  // The two-wallets launches, then one check per wallet: the Worker is up and allows this
  // extension's origin (`chrome-extension://<id>`). Without it every backup request of the
  // wallet fails on CORS, and a spec would read that as a product failure.
  walletA: async ({ walletA }, use) => {
    await assertWalletApiAllowsExtension(walletA.extensionId);
    await keepBrowserAlive(walletA);
    await use(walletA);
  },
  walletB: async ({ walletB }, use) => {
    await assertWalletApiAllowsExtension(walletB.extensionId);
    await keepBrowserAlive(walletB);
    await use(walletB);
  },

  walletC: async ({ timeline, steps, midenCli, failureSnapshots, injectFeeFaucet }, use, testInfo) => {
    const extensionPath = getExtensionPath();
    const feeFaucetId = injectFeeFaucet ? await midenCli.ensureNativeFaucetId() : undefined;
    const instance = await launchWalletInstance('C', extensionPath, timeline, steps.outputDir, feeFaucetId);
    // Before teardown is armed, as for A and B: a refused origin fails the test at launch.
    try {
      await assertWalletApiAllowsExtension(instance.extensionId);
    } catch (error) {
      await closeContextQuietly(instance.context, instance.walletPage.page);
      throw error;
    }
    steps.registerSnapshotCaps('C', buildChromeSnapshotCaps(instance.page, instance.context, instance.extensionId));
    await installScreenCapture(instance.page, 'C', steps.outputDir);
    await keepBrowserAlive(instance.walletPage);

    await use(instance.walletPage);

    const isAgentic = process.env.E2E_AGENTIC === 'true';
    const failed = testInfo.status !== 'passed';

    // The same teardown as walletB: snapshot while the page is alive, then close.
    if (failed) {
      failureSnapshots.walletC = await captureFailureSnapshot(steps, timeline, 'C');
    }

    if (isAgentic && failed) {
      // The browser stays open for agent inspection. The debug session file names A and B only.
      const cleanupTimer = setTimeout(async () => {
        await closeContextQuietly(instance.context, instance.walletPage.page);
      }, AGENTIC_TIMEOUT_MS);
      cleanupTimer.unref();
    } else if (failed) {
      await closeContextQuietly(instance.context, instance.walletPage.page);
      timeline.emit({
        category: 'test_lifecycle',
        severity: 'warn',
        wallet: 'C',
        message: `Retained wallet C profile for offline recovery: ${instance.userDataDir}`,
        data: { userDataDir: instance.userDataDir }
      });
    } else {
      await closeContextQuietly(instance.context, instance.walletPage.page);
      if (instance.ownsProfile && process.env.E2E_RETAIN_PROFILE !== 'true') {
        fs.rmSync(instance.userDataDir, { recursive: true, force: true });
      }
    }
  }
});

export { expect };
export type { GuardianAwareWalletPage };
