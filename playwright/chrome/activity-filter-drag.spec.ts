import { chromium, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { WalletAccount } from '../../src/lib/shared/types';
import type { useWalletStore } from '../../src/lib/store';
import { WalletType } from '../../src/screens/onboarding/types';
import { expect, test as base } from '../fixtures/extension';

declare global {
  interface Window {
    __TEST_STORE__?: typeof useWalletStore;
  }
}

// This Chrome-specific acceptance suite loads installed Google Chrome through CDP. Every run
// uses a fresh empty profile, display-only state and no vault, signing or transaction requests.
const test = base.extend({
  extensionContext: async ({ extensionPath }, use) => {
    const profile = mkdtempSync(path.join(tmpdir(), 'activity-filters-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: process.env.E2E_HEADLESS === '1',
      hasTouch: true,
      viewport: { width: 400, height: 600 },
      args: ['--enable-unsafe-extension-debugging'],
      ignoreDefaultArgs: ['--disable-extensions']
    });
    try {
      {
        const browser = context.browser();
        if (!browser) throw new Error('Chrome browser is unavailable');
        const session = await browser.newBrowserCDPSession();
        // Persistent launch uses Chrome's regular default profile, not an off-the-record context.
        const contexts = await session.send('Target.getBrowserContexts');
        expect(contexts.browserContextIds).toEqual([]);
        const version = await session.send('Browser.getVersion');
        console.log(`Regular Google Chrome: ${version.product}; off-the-record contexts: 0`);
        await session.send('Extensions.loadUnpacked', { path: extensionPath });
        await session.detach();
      }
      await context.route(/^https?:/, route => {
        const { hostname } = new URL(route.request().url());
        return hostname === '127.0.0.1' || hostname === 'localhost' ? route.continue() : route.abort();
      });
      await use(context);
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  }
});

// Cold extension startup includes loading the wallet bundle and its local policy fixture.
test.setTimeout(60_000);

async function activity(context: BrowserContext, id: string, entry = 'sidepanel.html') {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/${entry}`);
  expect(await page.evaluate(() => chrome.extension.inIncognitoContext)).toBe(false);
  await page
    .getByTestId('onboarding-welcome')
    .waitFor({ timeout: 45_000 })
    .catch(async error => {
      throw new Error(
        `Activity fixture startup failed: ${await page.locator('body').innerText()} | ${errors.join('; ')}`,
        { cause: error }
      );
    });
  await page.evaluate(walletType => {
    const account: WalletAccount = {
      publicKey: '0x0123456789abcdef0123456789abcd00',
      name: 'Activity fixture',
      isPublic: false,
      type: walletType,
      hdIndex: 0,
      authScheme: 'ecdsa'
    };
    const store = window.__TEST_STORE__;
    if (!store) throw new Error('Build with MIDEN_E2E_TEST=true');
    // Fixture is frontend state only: the empty backend remains locked/idle.
    store.setState({ status: 2, isInitialized: true, accounts: [account], currentAccount: account });
    window.history.replaceState(null, '', `${window.location.pathname}#/history`);
  }, WalletType.OffChain);
  const row = page.getByRole('radiogroup', { name: 'Activity filters' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('radio')).toHaveText(['All', 'Pending', 'Transfer', 'Swap', 'Earn', 'Others']);
  // Wait for the entering page to settle and the row to receive input before using raw coordinates.
  await row.hover();
  return { page, row };
}

async function drag(page: Page, row: Locator, from = 270, to = 50) {
  const box = await row.boundingBox();
  if (!box) throw new Error('Activity filters have no bounds');
  await page.mouse.move(box.x + from, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + to, box.y + box.height / 2, { steps: 16 });
  await page.mouse.up();
}

test('Activity filters drag in both directions without selecting, then accept ordinary clicks', async ({
  extensionContext,
  extensionId
}, info) => {
  const { page, row } = await activity(extensionContext, extensionId);
  await expect.poll(() => row.evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('before-drag.png') });
  await drag(page, row);
  await expect.poll(() => row.evaluate(e => e.scrollLeft)).toBeGreaterThan(90);
  await expect(row.getByRole('radio', { checked: true })).toHaveText('All');
  await page.screenshot({ path: info.outputPath('after-drag.png') });
  await row.getByRole('radio', { name: 'Others', exact: true }).click();
  await expect(row.getByRole('radio', { checked: true })).toHaveText('Others');
  await drag(page, row, 50, 270);
  await expect.poll(() => row.evaluate(e => e.scrollLeft)).toBe(0);
  await expect(row.getByRole('radio', { checked: true })).toHaveText('Others');
  await row.getByRole('radio', { name: 'Pending', exact: true }).click();
  await expect(row.getByRole('radio', { checked: true })).toHaveText('Pending');
  await page.close();
});

test('keyboard selection stays visible after dragging, including reduced motion', async ({
  extensionContext,
  extensionId
}) => {
  const { page, row } = await activity(extensionContext, extensionId);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await drag(page, row);
  await row.getByRole('radio', { checked: true }).focus();
  await page.keyboard.press('End');
  await expect(row.getByRole('radio', { checked: true })).toHaveText('Others');
  await expect
    .poll(() =>
      row.evaluate(e => {
        const selected = e.querySelector('[aria-checked="true"]');
        if (!selected) return false;
        const a = selected.getBoundingClientRect();
        const b = e.getBoundingClientRect();
        return a.left >= b.left - 1 && a.right <= b.right + 1;
      })
    )
    .toBe(true);
  await page.keyboard.press('Home');
  await expect(row.getByRole('radio', { checked: true })).toHaveText('All');
  await expect.poll(() => row.evaluate(e => e.scrollLeft)).toBe(0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(row.getByRole('radio', { checked: true })).toHaveText('Pending');
  await page.close();
});

test('native wheel and touch still scroll the filters without changing selection', async ({
  extensionContext,
  extensionId
}) => {
  const { page, row } = await activity(extensionContext, extensionId);
  await row.hover();
  await page.mouse.wheel(200, 0);
  await expect.poll(() => row.evaluate(e => e.scrollLeft)).toBeGreaterThan(90);
  await expect(row.getByRole('radio', { checked: true })).toHaveText('All');
  await row.evaluate(e => {
    e.scrollLeft = 0;
  });
  const bounds = await row.boundingBox();
  if (!bounds) throw new Error('Activity filters have no bounds');
  const session = await extensionContext.newCDPSession(page);
  const y = bounds.y + bounds.height / 2;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 280, y }] });
  for (let x = 270; x >= 50; x -= 10) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => row.evaluate(e => e.scrollLeft)).toBeGreaterThan(90);
  await expect(row.getByRole('radio', { checked: true })).toHaveText('All');
  await page.close();
});

test('vertical wheel scrolling passes through the row to its page', async ({ extensionContext, extensionId }) => {
  const { page, row } = await activity(extensionContext, extensionId);
  // Give the synthetic empty feed vertical overflow; use the real Activity row inside it.
  await row.evaluate(e => {
    const feed = e.parentElement;
    if (!feed) throw new Error('Activity feed is missing');
    Object.assign(feed.style, { height: '300px', flex: 'none', overflowY: 'auto' });
    const spacer = document.createElement('div');
    spacer.style.minHeight = '1200px';
    feed.append(spacer);
  });
  await row.hover();
  await page.mouse.wheel(0, 160);
  await expect.poll(() => row.evaluate(e => e.parentElement?.scrollTop ?? 0)).toBeGreaterThan(0);
  await expect.poll(() => row.evaluate(e => e.scrollLeft)).toBe(0);
  await expect(row.getByRole('radio', { checked: true })).toHaveText('All');
  await page.close();
});

test('a captured drag can leave the row, release outside and still allow keyboard activation', async ({
  extensionContext,
  extensionId
}) => {
  const { page, row } = await activity(extensionContext, extensionId);
  const box = await row.boundingBox();
  if (!box) throw new Error('Activity filters have no bounds');
  await page.mouse.move(270, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(180, box.y + 20, { steps: 8 });
  await page.mouse.move(50, box.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => row.evaluate(e => e.scrollLeft)).toBeGreaterThan(90);
  await expect(row.getByRole('radio', { checked: true })).toHaveText('All');
  await row.getByRole('radio', { name: 'Others', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(row.getByRole('radio', { checked: true })).toHaveText('Others');
  await page.close();
});
