import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import {
  getEligibilityFixtureOrigin,
  resetEligibilityFixtureOrigin,
  setEligibilityFixtureState,
  type EligibilityFixtureState
} from '../e2e/helpers/feature-eligibility';
import { IMPORTED_WALLET_PASSWORD, importWallet } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  await setEligibilityFixtureState('allowed');
});

async function expectWallet(page: Page) {
  await expect(page.getByTestId('onboarding-welcome')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('wallet-access-gate')).toHaveCount(0);
  await expect(page.getByTestId('wallet-access-retry')).toHaveCount(0);
}

const accessAssertions: Record<EligibilityFixtureState, (page: Page) => Promise<void>> = {
  allowed: expectWallet,
  loading: expectWallet,
  restricted: async page => {
    await expect(page.getByTestId('wallet-access-gate')).toHaveAttribute('data-access-state', 'restricted');
    await expect(page.getByTestId('onboarding-welcome')).toHaveCount(0);
    await expect(page.getByTestId('import-seed-phrase')).toHaveCount(0);
    await expect(page.getByTestId('wallet-access-retry')).toBeVisible();
  },
  unavailable: expectWallet
};

async function attachScreenshot(page: Page, info: TestInfo, name: string) {
  const screenshot = info.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await writeFile(
    screenshot,
    await sharp(screenshot).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).toBuffer()
  );
  await info.attach(name, { path: screenshot, contentType: 'image/png' });
}

/** Opens the Earn pane of an imported wallet on a new page, unlocking it when the page asks. */
async function openEarn(extensionContext: BrowserContext, extensionId: string, page?: Page): Promise<Page> {
  const target = page ?? (await extensionContext.newPage());
  await target.setViewportSize({ width: 900, height: 700 });
  const url = `chrome-extension://${extensionId}/fullpage.html#/earn`;
  await target.goto(url, { waitUntil: 'domcontentloaded' });
  const earn = target.getByTestId('earn-page');
  const unlock = target.getByTestId('unlock-password');
  await earn.or(unlock).first().waitFor({ timeout: 30_000 });
  if (await unlock.isVisible().catch(() => false)) {
    await target.locator('#unlock-password').fill(IMPORTED_WALLET_PASSWORD);
    await target.locator('#unlock-password').press('Enter');
    await target.goto(url, { waitUntil: 'domcontentloaded' });
  }
  await earn.waitFor({ timeout: 30_000 });
  return target;
}

for (const state of ['loading', 'restricted', 'unavailable', 'allowed'] satisfies EligibilityFixtureState[]) {
  test(`root wallet access: ${state}`, async ({ extensionContext, extensionId }, info) => {
    await resetEligibilityFixtureOrigin();
    await setEligibilityFixtureState(state);
    const page = await extensionContext.newPage();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });
    await accessAssertions[state](page);
    await expect
      .poll(async () => (await getEligibilityFixtureOrigin()).observed, { timeout: 15_000 })
      .toBe(true);
    const eligibilityOrigin = await getEligibilityFixtureOrigin();
    expect(eligibilityOrigin).toEqual({ observed: true, origin: null });
    await info.attach('eligibility-origin', {
      body: JSON.stringify(eligibilityOrigin),
      contentType: 'application/json'
    });
    await attachScreenshot(page, info, `wallet-access-${state}`);
    await page.close();
  });
}

test('renders the wallet while the lookup is pending and enables features when it answers', async ({
  extensionContext,
  extensionId
}, info) => {
  // importWallet 215s + two 30s page waits + the pending checks.
  test.setTimeout(330_000);
  await setEligibilityFixtureState('allowed');
  await importWallet(extensionContext, extensionId);
  const page = await openEarn(extensionContext, extensionId);

  // The wallet gives up on a lookup after 10s, so the held request starts on a reload of an
  // already unlocked page and is answered well inside that window.
  await setEligibilityFixtureState('loading');
  await page.reload({ waitUntil: 'domcontentloaded' });
  const heldSince = Date.now();
  const earn = page.getByTestId('earn-page');
  const swap = page.getByTestId('swap-flow');
  await expect(page.getByTestId('wallet-access-gate')).toHaveCount(0);
  await expect(earn.getByTestId('earn-unavailable-notice')).toHaveAttribute('data-reason', 'pending', {
    timeout: 6_000
  });
  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/swap`, { waitUntil: 'domcontentloaded' });
  await expect(swap.getByTestId('swap-unavailable-notice')).toHaveAttribute('data-reason', 'pending', {
    timeout: 2_000
  });
  await attachScreenshot(page, info, 'wallet-access-pending-swap');
  expect(Date.now() - heldSince).toBeLessThan(9_000);

  await setEligibilityFixtureState('allowed');
  await expect(swap).toHaveCount(1);
  await expect(swap.locator('[data-reason="pending"]')).toHaveCount(0, { timeout: 15_000 });
  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/earn`, { waitUntil: 'domcontentloaded' });
  await expect(earn).toHaveCount(1);
  await expect(earn.locator('[data-testid="earn-unavailable-notice"][data-reason="pending"]')).toHaveCount(0);
  await expect(page.getByTestId('wallet-access-gate')).toHaveCount(0);
});

test('wallet opens with Earn and Swap unavailable when the lookup fails', async ({
  extensionContext,
  extensionId
}, info) => {
  test.setTimeout(330_000);
  await setEligibilityFixtureState('allowed');
  await importWallet(extensionContext, extensionId);

  await setEligibilityFixtureState('unavailable');
  const page = await extensionContext.newPage();
  const consoleMessages: string[] = [];
  page.on('console', message => consoleMessages.push(`[${message.type()}] ${message.text()}`));
  await openEarn(extensionContext, extensionId, page);

  await expect(page.getByTestId('wallet-access-gate')).toHaveCount(0);
  const earnNotice = page.getByTestId('earn-page').getByTestId('earn-unavailable-notice');
  await expect(earnNotice).toHaveAttribute('data-reason', 'service-down', { timeout: 30_000 });
  await expect(earnNotice).toContainText('Temporarily unavailable');
  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/swap`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('swap-flow').getByTestId('swap-unavailable-notice')).toHaveAttribute(
    'data-reason',
    'service-down',
    { timeout: 30_000 }
  );
  await expect(page.getByTestId('wallet-access-gate')).toHaveCount(0);
  await attachScreenshot(page, info, 'wallet-access-service-down-swap');
  await info.attach('console', { body: consoleMessages.join('\n'), contentType: 'text/plain' });
});
