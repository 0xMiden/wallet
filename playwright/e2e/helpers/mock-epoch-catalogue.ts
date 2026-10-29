import type { BrowserContext } from '@playwright/test';

import { AAVE_V3_USDC, poolsPage } from '../../../src/lib/epoch/testing/pools-fixtures';

const CHAIN = '11155111';
const TOKEN = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';

// The mocked extension uses the policy's Sepolia dummy market, with the real pools response shape.
export const MOCK_SEPOLIA_POOL = {
  ...AAVE_V3_USDC,
  marketUid: `DUMMY_LENDING:${CHAIN}:${TOKEN}`,
  chainId: CHAIN,
  lenderKey: 'DUMMY_LENDING',
  name: 'Dummy Lending USDC',
  lenderInfo: { key: 'DUMMY_LENDING', name: 'Dummy Lending', logoURI: '' },
  underlyingInfo: {
    ...AAVE_V3_USDC.underlyingInfo,
    asset: { ...AAVE_V3_USDC.underlyingInfo.asset, chainId: CHAIN, address: TOKEN }
  }
};

export async function installMockEpochCatalogue(context: Pick<BrowserContext, 'route'>): Promise<void> {
  await context.route(
    url =>
      url.protocol === 'https:' &&
      url.hostname === 'positions-testnet-dev.epochprotocol.xyz' &&
      url.pathname === '/pools',
    async route => {
      const url = new URL(route.request().url());
      if (
        route.request().method() !== 'GET' ||
        url.searchParams.get('chainId') !== CHAIN ||
        url.searchParams.get('underlyings')?.toLowerCase() !== TOKEN
      ) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
        json: poolsPage([MOCK_SEPOLIA_POOL])
      });
    }
  );
}
