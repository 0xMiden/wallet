import { expect, type Page } from '@playwright/test';
import { parseOneClickQuoteResponse } from '../../../src/lib/one-click/client';
import type { OneClickQuoteResponse } from '../../../src/lib/one-click/types';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

export interface MainnetNearIntentsRoute {
  /** The 1Click blockchain name of the origin chain, as the network filter lists it. */
  chainId: string;
  originAssetId: string;
  /** Only when the origin token delivers more than one Miden token. */
  outputAssetId?: string;
  /** The origin amount as a decimal string. */
  amount: string;
  refundAddress: string;
}

export interface MainnetNearIntentsDeposit {
  rowId: string;
  address: string;
  amountText: string;
  phase: string;
  hasMemo: boolean;
}

/** Fill the Receive form for a deposit address. It requests no wet quote. */
export async function selectMainnetNearIntentsDeposit(page: Page, route: MainnetNearIntentsRoute): Promise<void> {
  await page.getByTestId('receive-tab-near-intents').click({ timeout: 90_000 });
  await page.getByTestId('near-intents-send-token-pill').click({ timeout: 120_000 });
  await page.getByTestId('near-intents-network-filter').click();
  await page.getByTestId(`near-intents-network-${route.chainId}`).click();
  await page.getByTestId(`near-intents-token-${route.originAssetId}`).click();
  if (route.outputAssetId) {
    await page.getByTestId('near-intents-receive-token-pill').click();
    await page.getByTestId(`near-intents-output-${route.outputAssetId}`).click();
  }
  await page.getByTestId('near-intents-amount').fill(route.amount);
  await page.getByTestId('near-intents-refund-address').fill(route.refundAddress);
}

/**
 * Click `Get deposit address` and return the wet quote that the wallet requested. The response listener is
 * registered before anything is selected, so the quote cannot be missed, and it matches only a wet request that
 * names the exact amount, assets, refund account and recipient.
 */
export async function captureMainnetNearIntentsQuote(
  wallet: GuardianAwareWalletPage,
  route: MainnetNearIntentsRoute,
  expected: { originAsset: string; destinationAsset: string; amount: bigint; refundTo: string; recipient: string },
  selected = false
): Promise<OneClickQuoteResponse> {
  const response = wallet.page.waitForResponse(
    response => {
      if (!response.url().includes('/v0/quote') || response.request().method() !== 'POST') return false;
      const body: unknown = response.request().postDataJSON();
      return (
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        Reflect.get(body, 'dry') === false &&
        Reflect.get(body, 'amount') === expected.amount.toString() &&
        Reflect.get(body, 'originAsset') === expected.originAsset &&
        Reflect.get(body, 'destinationAsset') === expected.destinationAsset &&
        Reflect.get(body, 'refundTo') === expected.refundTo &&
        Reflect.get(body, 'recipient') === expected.recipient
      );
    },
    { timeout: 120_000 }
  );
  // Observe an early rejection; awaiting the original response below still fails closed.
  void response.catch(() => {});
  if (!selected) await selectMainnetNearIntentsDeposit(wallet.page, route);
  // The button enables once the dry preview quote has loaded for a valid refund address.
  await expect(wallet.page.getByTestId('near-intents-get-deposit-address')).toBeEnabled({ timeout: 120_000 });
  await wallet.page.getByTestId('near-intents-get-deposit-address').click();
  const quote = parseOneClickQuoteResponse(await (await response).json());
  await expect(wallet.page.getByTestId('near-intents-deposit-page')).toBeVisible({ timeout: 30_000 });
  return quote;
}

/** Read the deposit page as text only: the page also draws a QR code, which is never captured. */
export async function readMainnetNearIntentsDeposit(page: Page): Promise<MainnetNearIntentsDeposit> {
  const rowId = /#\/receive\/near-intents\/([^/?#]+)/.exec(page.url())?.[1];
  const address = (await page.getByTestId('near-intents-deposit-address-full').textContent())?.trim();
  const amountText = (await page.getByTestId('near-intents-deposit-amount').textContent())?.trim();
  const phase = await page.getByTestId('near-intents-deposit-status').getAttribute('data-phase');
  if (!rowId || !address || !amountText || !phase) throw new Error('The NEAR Intents deposit page is incomplete');
  return {
    rowId,
    address,
    amountText,
    phase,
    hasMemo: (await page.getByTestId('near-intents-deposit-memo').count()) > 0
  };
}
