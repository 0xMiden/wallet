import { expect, type Page } from '@playwright/test';
import { parseOneClickQuoteResponse } from '../../../src/lib/one-click/client';
import type { OneClickQuoteResponse } from '../../../src/lib/one-click/types';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { WcCounterparty } from '../ios/helpers/wc-counterparty';

export interface MainnetOneClickRoute {
  payNetwork: string;
  payAssetId: string;
  receiveNetwork: string;
  receiveAssetId: string;
  amount: string;
  externalAddress?: string;
}

async function choose(page: Page, side: 'pay' | 'receive', network: string, assetId: string): Promise<void> {
  await page.getByTestId(`one-click-${side}-network-picker`).click();
  await page.getByTestId(`one-click-${side}-network-${network}`).click();
  await page.getByTestId(`one-click-${side}-asset-picker`).click();
  await page.getByTestId(`one-click-asset-${side}-${assetId}`).click();
}

export async function prepareMainnetOneClickReview(page: Page, route: MainnetOneClickRoute): Promise<void> {
  await selectMainnetOneClickAssets(page, route);
  if (route.amount) await page.getByTestId('one-click-pay-amount').fill(route.amount);
  await expect(page.getByTestId('one-click-review-submit')).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId('one-click-review-submit').click();
  await expect(page.getByTestId('one-click-review-hero')).toBeVisible();
}

export async function selectMainnetOneClickAssets(page: Page, route: MainnetOneClickRoute): Promise<void> {
  await expect(page.getByTestId('one-click-pay-network-picker')).toBeVisible();
  await choose(page, 'pay', route.payNetwork, route.payAssetId);
  await choose(page, 'receive', route.receiveNetwork, route.receiveAssetId);
  if (route.externalAddress) {
    await page.getByTestId('one-click-recipient-address').fill(route.externalAddress);
  }
}

export async function connectMainnetOneClickWallet(wallet: GuardianAwareWalletPage, counterparty: WcCounterparty): Promise<void> {
  const state = async () => wallet.page.evaluate(() => {
    const read = window.__TEST_APPKIT_STATE__;
    if (!read) throw new Error('The mainnet E2E AppKit state hook is unavailable');
    return read();
  });
  await counterparty.start();
  const connection = counterparty.connectWithRetry(
    () => wallet.page.evaluate(() => {
      const read = window.__TEST_APPKIT_CONNECT_URI__;
      if (!read) throw new Error('The mainnet E2E AppKit URI hook is unavailable');
      return read();
    }),
    async () => (await state()).connected,
    { attempts: 3, backoffMs: 5_000, sessionTimeoutMs: 45_000 }
  );
  await wallet.page.getByTestId('one-click-connect-origin-wallet').click();
  await connection;
  const connected = await state();
  expect(connected.connected).toBe(true);
  expect(connected.address?.toLowerCase()).toBe(counterparty.address.toLowerCase());
}

export async function captureMainnetOneClickReviewQuote(
  wallet: GuardianAwareWalletPage, route: MainnetOneClickRoute,
  expected: { originAsset: string; destinationAsset: string; amount: bigint; refundTo: string; recipient: string }, selected = false
): Promise<OneClickQuoteResponse> {
  const response = wallet.page.waitForResponse(response => {
    if (!response.url().includes('/v0/quote') || response.request().method() !== 'POST') return false;
    const body: unknown = response.request().postDataJSON();
    return typeof body === 'object' && body !== null && !Array.isArray(body) &&
      Reflect.get(body, 'dry') === false && Reflect.get(body, 'amount') === expected.amount.toString() &&
      Reflect.get(body, 'originAsset') === expected.originAsset && Reflect.get(body, 'destinationAsset') === expected.destinationAsset &&
      Reflect.get(body, 'refundTo') === expected.refundTo && Reflect.get(body, 'recipient') === expected.recipient;
  }, { timeout: 120_000 });
  if (!selected) await selectMainnetOneClickAssets(wallet.page, route);
  await wallet.page.getByTestId('one-click-pay-amount').fill(route.amount);
  await expect(wallet.page.getByTestId('one-click-review-submit')).toBeEnabled({ timeout: 120_000 });
  await wallet.page.getByTestId('one-click-review-submit').click();
  await expect(wallet.page.getByTestId('one-click-review-hero')).toBeVisible();
  return parseOneClickQuoteResponse(await (await response).json());
}

export async function confirmMainnetOneClickReview(page: Page): Promise<void> {
  await page.getByTestId('one-click-confirm').click();
}
