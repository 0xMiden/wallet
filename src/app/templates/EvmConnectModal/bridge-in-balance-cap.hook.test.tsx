import { act, renderHook } from '@testing-library/react';

import { useBridgeInBalanceCap } from './bridge-in-balance-cap';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const balances = [
  {
    tokenId: 'faucet-ETH',
    tokenSlug: 'ETH',
    metadata: { name: 'ETH', symbol: 'ETH', decimals: 8 },
    balance: 1,
    fiatPrice: 0,
    change24h: 0
  }
];
const mockPrices = { ETH: { price: 2000, change24h: 0, percentageChange24h: 0, observedAt: NOW } };

jest.mock('lib/miden/front', () => ({
  useAllBalances: () => ({ data: balances, isLoading: false }),
  useAllTokensBaseMetadata: () => ({})
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({ selectBridgeInMaxBalanceUsd: () => 5000 }));
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) => selector({ tokenPrices: mockPrices })
}));
jest.mock('lib/miden/swap/tokens', () => ({
  priceSymbolFor: (_faucetId: string, symbol: string) => symbol,
  tokenQuote: (prices: Record<string, unknown>, _faucetId: string, symbol: string) => prices[symbol]
}));

describe('useBridgeInBalanceCap', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('stops clearing a deposit once the holdings quote expires, without any other update', () => {
    const { result } = renderHook(() =>
      useBridgeInBalanceCap({
        accountPublicKey: 'pk',
        depositAmount: 1,
        depositPriceUsd: 1,
        depositPricePending: false
      })
    );
    expect(result.current.state).toBe('clear');

    act(() => {
      jest.advanceTimersByTime(10 * 60_000 + 30_000);
    });

    expect(result.current.state).toBe('loading');
  });
});
