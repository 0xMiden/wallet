import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { capturePlan, type CapturePlanEntry, type StorePlatform } from './store-listing.capture';

const repositoryRoot = path.resolve(__dirname, '../..');
const mobileBaseUrl = 'http://127.0.0.1:4173/';
const extensionPath = path.join(repositoryRoot, 'dist/chrome_unpacked');
const fixtureSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const fixturePassword = 'StoreListing123!';
const fixtureRecipient = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';
const fixtureFaucet = 'mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec_qr7qqq9wr6w';
const noMotionCss = `
  *, *::before, *::after {
    animation-delay: 0s !important;
    animation-duration: 0s !important;
    caret-color: transparent !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
  }
`;

function planEntry(platform: StorePlatform, sceneId: string): CapturePlanEntry {
  const item = capturePlan.find(entry => entry.platform === platform && entry.sceneId === sceneId);
  if (!item) throw new Error(`Missing capture plan entry for ${platform}/${sceneId}`);
  return item;
}

async function settle(page: Page, item: CapturePlanEntry): Promise<void> {
  const ready = page
    .getByTestId(item.ready.testId)
    .or(page.locator(`[id="${item.ready.testId}"]`))
    .first();
  try {
    await ready.waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      hash: location.hash,
      href: location.href,
      testIds: Array.from(document.querySelectorAll('[data-testid]'), node => node.getAttribute('data-testid'))
    }));
    throw new Error(`${item.id} did not reach ${item.ready.testId}: ${JSON.stringify(state)}`, { cause: error });
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  for (const testId of item.ready.hiddenTestIds) {
    const candidates = page.getByTestId(testId);
    for (let index = 0; index < (await candidates.count()); index += 1) {
      await expect(candidates.nth(index)).toBeHidden();
    }
  }
  await expect(page.locator('[role="alert"]:visible')).toHaveCount(0);
}

async function capture(page: Page, item: CapturePlanEntry): Promise<void> {
  await settle(page, item);
  const destination = path.join(repositoryRoot, item.outputPath);
  mkdirSync(path.dirname(destination), { recursive: true });
  await page.screenshot({ path: destination, animations: 'disabled', caret: 'hide' });
}

async function preparePage(page: Page): Promise<void> {
  await page.addStyleTag({ content: noMotionCss }).catch(error => {
    if (!String(error).includes('Content Security Policy')) throw error;
  });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function newMobileContext(platform: 'ios' | 'android', item: CapturePlanEntry): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: item.viewport,
    deviceScaleFactor: item.deviceScaleFactor,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce'
  });
  await context.addInitScript(platformName => {
    const browserFetch = globalThis.fetch.bind(globalThis);
    let installedFetch = browserFetch;
    let fetchDepth = 0;
    const dispatchFetch: typeof globalThis.fetch = async (...args) => {
      if (fetchDepth > 0) return browserFetch(...args);
      fetchDepth += 1;
      try {
        return await installedFetch(...args);
      } finally {
        fetchDepth -= 1;
      }
    };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get: () => dispatchFetch,
      set: next => {
        installedFetch = next;
      }
    });
    Object.defineProperty(globalThis, 'CapacitorCustomPlatform', {
      configurable: true,
      value: { name: platformName }
    });
    try {
      localStorage.setItem('theme_setting_key', JSON.stringify('light'));
    } catch {}
  }, platform);
  await context.route('**/pubkey', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ commitment: 'deterministic-store-listing-guardian' })
    })
  );
  return context;
}

async function createMobileWallet(platform: 'ios' | 'android', item: CapturePlanEntry): Promise<BrowserContext> {
  const context = await newMobileContext(platform, item);
  const page = await context.newPage();
  const params = new URLSearchParams({
    __test_skip_onboarding: '1',
    password: fixturePassword,
    seed: fixtureSeed
  });
  await page.goto(`${mobileBaseUrl}?${params}`, { waitUntil: 'domcontentloaded' });
  await preparePage(page);
  await page.getByTestId('onboarding-confirmation').waitFor({ state: 'visible' });
  await page.getByTestId('onboarding-confirmation-submit').click();
  await page.getByTestId('explore-page').waitFor({ state: 'visible', timeout: 120_000 });
  await page.evaluate(() => history.replaceState(null, '', '/'));
  return context;
}

async function openMobileTransaction(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __TEST_INTERCOM__?: { request(payload: unknown): Promise<unknown> };
      __listingConnectResponse?: unknown;
      __listingConnectError?: string;
    };
    const intercom = scope.__TEST_INTERCOM__;
    if (!intercom) throw new Error('Test intercom is unavailable');
    void intercom
      .request({
        type: 'MIDEN_PAGE_REQUEST',
        origin: 'https://miden.xyz',
        payload: {
          type: 'PERMISSION_REQUEST',
          appMeta: { name: 'Miden Network', url: 'https://miden.xyz' },
          network: 'testnet',
          force: true,
          privateDataPermission: 'UPON_REQUEST',
          allowedPrivateData: 0
        }
      })
      .then(response => {
        scope.__listingConnectResponse = response;
      })
      .catch(error => {
        scope.__listingConnectError = String(error);
      });
  });
  const connectDialog = page.getByRole('dialog');
  await connectDialog.waitFor({ state: 'visible' });
  await expect(connectDialog.getByText('https://miden.xyz')).toBeVisible();
  await connectDialog.getByRole('button', { name: 'Approve' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __listingConnectResponse?: unknown;
          __listingConnectError?: string;
        };
        if (scope.__listingConnectError) throw new Error(scope.__listingConnectError);
        return Boolean(scope.__listingConnectResponse);
      })
    )
    .toBe(true);

  await page.evaluate(({ faucet, recipient }) => {
    const scope = globalThis as typeof globalThis & {
      __TEST_INTERCOM__?: { request(payload: unknown): Promise<unknown> };
      __TEST_STORE__?: {
        getState(): {
          currentAccount: { publicKey: string } | null;
        };
      };
      __listingConnectResponse?: { payload?: { accountId?: string } };
      __listingSendResponse?: unknown;
      __listingSendError?: string;
    };
    const intercom = scope.__TEST_INTERCOM__;
    const state = scope.__TEST_STORE__?.getState();
    const sender = scope.__listingConnectResponse?.payload?.accountId ?? state?.currentAccount?.publicKey;
    if (!intercom || !sender) throw new Error('Deterministic transaction fixture is incomplete');
    void intercom
      .request({
        type: 'MIDEN_PAGE_REQUEST',
        origin: 'https://miden.xyz',
        payload: {
          type: 'SEND_TRANSACTION_REQUEST',
          sourcePublicKey: sender,
          transaction: {
            senderAddress: sender,
            recipientAddress: recipient,
            faucetId: faucet,
            noteType: 'private',
            amount: '1000000',
            recallBlocks: 0
          }
        }
      })
      .then(response => {
        scope.__listingSendResponse = response;
      })
      .catch(error => {
        scope.__listingSendError = String(error);
      });
  }, { faucet: fixtureFaucet, recipient: fixtureRecipient });
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await expect(page.getByRole('dialog')).toContainText('Note Type, Private');
}

async function captureMobile(platform: 'appStore' | 'playStore', flag: 'ios' | 'android'): Promise<void> {
  const guardian = planEntry(platform, 'guardian');
  const protectionScene = flag === 'ios' ? 'ios-protection' : 'android-protection';
  const protection = planEntry(platform, protectionScene);
  const onboardingContext = await newMobileContext(flag, protection);
  const onboarding = await onboardingContext.newPage();
  await onboarding.goto(mobileBaseUrl, { waitUntil: 'domcontentloaded' });
  await preparePage(onboarding);
  await onboarding.getByTestId('onboarding-welcome').waitFor({ state: 'visible' });
  await onboarding.getByRole('button', { name: 'Get started' }).click();
  await onboarding.getByTestId('onboarding-network-notice-acknowledge').click();
  await capture(onboarding, protection);
  await onboarding.evaluate(() => history.pushState(null, '', '/#/#choose-guardian'));
  await capture(onboarding, guardian);
  await onboardingContext.browser()?.close();

  const home = planEntry(platform, 'wallet-keys');
  const walletContext = await createMobileWallet(flag, home);
  const wallet = walletContext.pages()[0]!;
  await capture(wallet, home);

  await openMobileTransaction(wallet);
  const send = planEntry(platform, 'send-privacy');
  await capture(wallet, send);
  await wallet.getByRole('dialog').getByRole('button', { name: 'Deny' }).click();

  await wallet.goto(`${mobileBaseUrl}#/receive`, { waitUntil: 'domcontentloaded' });
  await preparePage(wallet);
  await capture(wallet, planEntry(platform, 'receive'));

  await wallet.goto(`${mobileBaseUrl}#/browser`, { waitUntil: 'domcontentloaded' });
  await preparePage(wallet);
  await capture(wallet, planEntry(platform, flag === 'ios' ? 'ios-dapp-browser' : 'android-dapp-browser'));

  if (flag === 'android') {
    await wallet.evaluate(() => localStorage.setItem('delegate_proof_setting_key', JSON.stringify(false)));
    await wallet.goto(`${mobileBaseUrl}#/settings/general-settings`, { waitUntil: 'domcontentloaded' });
    await preparePage(wallet);
    await capture(wallet, planEntry(platform, 'android-local-proving'));
  }
  await walletContext.browser()?.close();
}

async function waitForExtensionWorker(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 60_000 }));
  return new URL(worker.url()).host;
}

async function captureChrome(): Promise<void> {
  if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error('Chrome extension build is missing. Run yarn store-listing:capture:build first.');
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'bread-store-listing-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 400, height: 600 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    ignoreDefaultArgs: ['--disable-extensions']
  });
  try {
    const extensionId = await waitForExtensionWorker(context);
    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    await context.route('**/pubkey', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ commitment: 'deterministic-store-listing-guardian' })
      })
    );

    const guardianPage = await context.newPage();
    await guardianPage.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });
    await preparePage(guardianPage);
    await guardianPage.getByTestId('onboarding-welcome').waitFor({ state: 'visible' });
    await guardianPage.getByRole('button', { name: 'Get started' }).click();
    await guardianPage.getByTestId('onboarding-network-notice-acknowledge').click();
    await guardianPage.getByTestId('create-password-input').fill(fixturePassword);
    await guardianPage.getByTestId('create-password-verify-input').fill(fixturePassword);
    await guardianPage.getByTestId('create-password-submit').click();
    await capture(guardianPage, planEntry('chromeWebStore', 'guardian'));
    await guardianPage.close();

    const wallet = await context.newPage();
    const params = new URLSearchParams({
      __test_skip_onboarding: '1',
      password: fixturePassword,
      seed: fixtureSeed
    });
    await wallet.goto(`${fullpageUrl}?${params}`, { waitUntil: 'domcontentloaded' });
    await preparePage(wallet);
    await wallet.getByTestId('onboarding-confirmation').waitFor({ state: 'visible' });
    await wallet.getByTestId('onboarding-confirmation-submit').click();
    await wallet.getByTestId('explore-page').waitFor({ state: 'visible', timeout: 120_000 });

    await wallet.goto(sidepanelUrl, { waitUntil: 'domcontentloaded' });
    await preparePage(wallet);
    await capture(wallet, planEntry('chromeWebStore', 'wallet-keys'));
    await capture(wallet, planEntry('chromeWebStore', 'chrome-side-panel'));

    await wallet.goto(`${sidepanelUrl}#/receive`, { waitUntil: 'domcontentloaded' });
    await preparePage(wallet);
    await capture(wallet, planEntry('chromeWebStore', 'receive'));

    await context.route('https://miden.xyz/**', route =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>Miden Network</title></head><body><h1>Miden Network</h1></body></html>'
      })
    );
    const dapp = await context.newPage();
    await dapp.goto('https://miden.xyz/store-listing', { waitUntil: 'domcontentloaded' });
    await dapp.waitForFunction(() => typeof (globalThis as { midenWallet?: unknown }).midenWallet === 'object');

    const connectPopupPromise = context.waitForEvent('page', {
      predicate: async page => {
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        return page.url().includes('confirm.html');
      }
    });
    await dapp.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        midenWallet: { connect(permission: string, network: string): Promise<void> };
        __listingConnectOutcome?: 'connected' | 'rejected';
      };
      void scope.midenWallet.connect('UPON_REQUEST', 'testnet').then(
        () => {
          scope.__listingConnectOutcome = 'connected';
        },
        () => {
          scope.__listingConnectOutcome = 'rejected';
        }
      );
    });
    const connectPopup = await connectPopupPromise;
    await connectPopup.setViewportSize({ width: 400, height: 600 });
    await preparePage(connectPopup);
    await connectPopup.getByTestId('ConfirmPage/ConnectAction/ConnectButton').waitFor({ state: 'visible' });
    await capture(connectPopup, planEntry('chromeWebStore', 'chrome-connect'));
    await connectPopup.getByTestId('ConfirmPage/ConnectAction/ConnectButton').click();
    await expect
      .poll(() => dapp.evaluate(() => (globalThis as { __listingConnectOutcome?: string }).__listingConnectOutcome))
      .toBe('connected');

    const fixture = await wallet.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          __TEST_STORE__: {
            getState(): {
              currentAccount: { publicKey: string } | null;
            };
          };
        }
      ).__TEST_STORE__.getState();
      const sender = state.currentAccount?.publicKey;
      if (!sender) throw new Error('Chrome transaction fixture is incomplete');
      return { sender };
    });
    const sendPopupPromise = context.waitForEvent('page', {
      predicate: async page => {
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        return page.url().includes('confirm.html');
      }
    });
    await dapp.evaluate(
      ({ faucet, sender, recipient }) => {
        const scope = globalThis as typeof globalThis & {
          midenWallet: {
            requestSend(transaction: {
              senderAddress: string;
              recipientAddress: string;
              faucetId: string;
              noteType: string;
              amount: number;
            }): Promise<unknown>;
          };
          __listingSendOutcome?: 'approved' | 'rejected';
        };
        void scope.midenWallet
          .requestSend({
            senderAddress: sender,
            recipientAddress: recipient,
            faucetId: faucet,
            noteType: 'private',
            amount: 1_000_000
          })
          .then(
            () => {
              scope.__listingSendOutcome = 'approved';
            },
            () => {
              scope.__listingSendOutcome = 'rejected';
            }
          );
      },
      { ...fixture, faucet: fixtureFaucet, recipient: fixtureRecipient }
    );
    const sendPopup = await sendPopupPromise;
    await sendPopup.setViewportSize({ width: 400, height: 600 });
    await preparePage(sendPopup);
    await sendPopup.getByTestId('ConfirmPage/TransactionAction/RejectButton').waitFor({ state: 'visible' });
    await expect(sendPopup.getByTestId('confirm-tx-value-note-type')).toHaveText('Private');
    await capture(sendPopup, planEntry('chromeWebStore', 'send-privacy'));
    await capture(sendPopup, planEntry('chromeWebStore', 'chrome-confirm'));
    await sendPopup.getByTestId('ConfirmPage/TransactionAction/RejectButton').click();
    await expect
      .poll(() => dapp.evaluate(() => (globalThis as { __listingSendOutcome?: string }).__listingSendOutcome))
      .toBe('rejected');
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

test.describe('deterministic store listing captures', () => {
  test('captures iOS, Android, and Chrome product states with retries disabled', async () => {
    await captureMobile('appStore', 'ios');
    await captureMobile('playStore', 'android');
    await captureChrome();
  });
});
