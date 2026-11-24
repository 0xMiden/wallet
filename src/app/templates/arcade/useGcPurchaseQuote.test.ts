import { renderHook } from '@testing-library/react';

import type { GcSale } from 'lib/miden/arcade/gc-sale';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { useGcPurchaseQuote } from './useGcPurchaseQuote';

const mockSale: GcSale = {
  saleNoteId: 'exact-package',
  sellerAccountId: 'seller',
  gcFaucetId: 'gc',
  payFaucetId: 'usdcx',
  offeredAmount: 1_000_000_000n,
  requestedAmount: 1_000_000n,
  fillFloor: 0n
};
let mockSales: GcSale[] = [];
const mockMutate = jest.fn(async () => mockSales);

jest.mock('swr', () => () => ({ data: mockSales, mutate: mockMutate }));
jest.mock('app/layouts/page-active', () => ({ usePageActive: () => true }));
jest.mock('lib/miden/arcade/gc-sale', () => ({
  ...jest.requireActual('lib/miden/arcade/gc-sale'),
  getGcSaleConfig: () => ({ sellerAccountId: 'seller' })
}));
jest.mock('lib/miden/sdk/helpers', () => ({ sameWalletAccountId: (a: string, b: string) => a === b }));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetIdSync: () => 'usdcx' }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => null }));

function renderQuote(sales: GcSale[]) {
  mockSales = sales;
  return renderHook(() => useGcPurchaseQuote(MIDEN_NETWORK_NAME.MAINNET, 'buyer')).result.current;
}

it('keeps the entry unavailable when separate sales cannot back one atomic package', async () => {
  const half: GcSale = { ...mockSale, offeredAmount: 500_000_000n, requestedAmount: 500_000n };
  const quote = renderQuote([{ ...half, saleNoteId: 'half-one' }, { ...half, saleNoteId: 'half-two' }]);

  expect(quote.state).toBe('unavailable');
  expect(quote.sale).toBeNull();
  await expect(quote.refresh()).resolves.toBeNull();
});

it('keeps the entry unavailable when the only sale has a different price', () => {
  const quote = renderQuote([{ ...mockSale, requestedAmount: 999_999n }]);

  expect(quote.state).toBe('unavailable');
  expect(quote.sale).toBeNull();
});

it('opens the entry for an exact backed package', async () => {
  const quote = renderQuote([mockSale]);

  expect(quote.state).toBe('ready');
  expect(quote.sale).toBe(mockSale);
  await expect(quote.refresh()).resolves.toBe(mockSale);
});
