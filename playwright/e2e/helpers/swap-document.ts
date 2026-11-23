import type { Page } from '@playwright/test';

export interface SwapTokenDescriptor {
  symbol: string;
  /** bech32 faucet id, as the wallet keys balances. */
  faucetId: string;
  decimals: number;
}

export async function installSwapTestTokens(page: Page, tokens: SwapTokenDescriptor[]): Promise<void> {
  await page.waitForFunction(() => typeof Reflect.get(window, '__TEST_SET_SWAP_TOKENS__') === 'function', undefined, {
    timeout: 60_000
  });
  await page.evaluate(t => Reflect.get(window, '__TEST_SET_SWAP_TOKENS__')(t), tokens);
}

export async function openSwapDocument(
  page: Page,
  extensionId: string,
  surface: 'fullpage' | 'sidepanel',
  tokens?: SwapTokenDescriptor[]
): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/${surface}.html#/swap`);
  // The registry override is in memory and must be reinstalled in this document.
  if (tokens) await installSwapTestTokens(page, tokens);
}
