import { expect, type Page } from '@playwright/test';

import { reviewQueryParam, waitForReviewSubmitEnabled } from './bridge';
import { selectSendNetwork } from './contact-network';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

const STEP_MS = 30_000;

/**
 * Burn USDCx to `destination` on a mainnet chain through Send. The testnet helper asserts Arc Testnet
 * is the preselected chip, which a mainnet build does not show.
 */
export async function burnUsdcxToAddress(
  wallet: GuardianAwareWalletPage,
  opts: { tokenId: string; amount: string; destination: string; networkId: string; networkName: string }
): Promise<void> {
  const { page, extensionId } = wallet;
  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/send?tokenId=${encodeURIComponent(opts.tokenId)}`);
  const flow = page.getByTestId('send-flow');
  await expect(flow).toBeVisible({ timeout: STEP_MS });
  await flow.getByTestId('send-recipient-input').fill(opts.destination);
  await selectSendNetwork(page, { id: opts.networkId, name: opts.networkName }, STEP_MS);
  await flow.getByTestId('send-recipient-confirm').click({ timeout: STEP_MS });
  await flow.getByTestId('send-amount-input').fill(opts.amount);
  await flow.getByTestId('send-amount-confirm').click({ timeout: STEP_MS });
  const route = flow.getByTestId('bridge-route-usdcx');
  await expect(route).toBeVisible({ timeout: STEP_MS });
  await route.click({ timeout: STEP_MS });
  await flow.getByTestId('bridge-route-confirm').click({ timeout: STEP_MS });
  await page.waitForURL(/#\/send\/review\?/, { timeout: STEP_MS });
  expect(reviewQueryParam(page.url(), 'network')).toBe(opts.networkId);
  await waitForReviewSubmitEnabled(page, 120_000);
  await page.getByTestId('send-review-submit').click({ timeout: STEP_MS });
  await page.waitForURL(/generating-transaction/, { timeout: 180_000 });
}

export async function tokenIdBySymbol(page: Page, symbol: string): Promise<string> {
  const wanted = symbol.toLowerCase();
  return page.evaluate(name => {
    const state = (
      window as unknown as {
        __TEST_STORE__?: {
          getState(): {
            balances?: Record<string, Array<{ tokenId?: string; metadata?: { symbol?: string } }>>;
            assetsMetadata?: Record<string, { symbol?: string }>;
          };
        };
      }
    ).__TEST_STORE__?.getState?.();
    for (const list of Object.values(state?.balances ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const token of list) {
        const id = String(token?.tokenId ?? '');
        const found = String(token?.metadata?.symbol ?? state?.assetsMetadata?.[id]?.symbol ?? '').toLowerCase();
        if (found === name && id) return id;
      }
    }
    return '';
  }, wanted);
}
