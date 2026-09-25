import React from 'react';

import { render, renderHook } from '@testing-library/react';

import { fetchTokenPrices } from './binance';
import { PriceProvider, useTokenSparkline } from './index';

const mockWallet = { locked: false, ready: true };
jest.mock('lib/miden/front', () => ({ useMidenContext: () => mockWallet }));

const mockUseRetryableSWR = jest.fn();
jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: any[]) => mockUseRetryableSWR(...args)
}));

const setTokenPrices = jest.fn();
jest.mock('lib/store', () => ({
  useWalletStore: (selector: any) => selector({ setTokenPrices })
}));

beforeEach(() => {
  mockWallet.locked = false;
  mockWallet.ready = true;
  setTokenPrices.mockClear();
  mockUseRetryableSWR.mockReset();
  mockUseRetryableSWR.mockReturnValue({
    data: { ETH: { price: 3000, change24h: 10, percentageChange24h: 0.1 } }
  });
});

describe('PriceProvider', () => {
  it('pushes prices into the wallet store on mount', () => {
    render(<PriceProvider />);
    expect(setTokenPrices).toHaveBeenCalledWith({
      ETH: { price: 3000, change24h: 10, percentageChange24h: 0.1 }
    });
  });

  it('reads no prices while there is no wallet', () => {
    mockWallet.ready = false;
    render(<PriceProvider />);
    expect(mockUseRetryableSWR.mock.calls[0]![0]).toBeNull();
  });

  it.each([
    ['locked', { locked: true, ready: false }],
    ['ready', { locked: false, ready: true }]
  ])('reads prices once a wallet exists (%s)', (_state, wallet) => {
    Object.assign(mockWallet, wallet);
    render(<PriceProvider />);
    const [key, fetcher] = mockUseRetryableSWR.mock.calls[0]!;
    expect(key).toBe('token-prices');
    expect(fetcher).toBe(fetchTokenPrices);
  });

  it('renders nothing (returns null)', () => {
    const { container } = render(<PriceProvider />);
    expect(container.firstChild).toBeNull();
  });
});

describe('useTokenSparkline', () => {
  it('returns close values from fetched kline data', () => {
    mockUseRetryableSWR.mockReturnValue({
      data: [
        { time: 1, value: 10 },
        { time: 2, value: 12.5 }
      ]
    });

    const { result } = renderHook(() => useTokenSparkline('MIDEN', '1W'));

    expect(result.current).toEqual([10, 12.5]);
    expect(mockUseRetryableSWR).toHaveBeenCalledWith(
      ['kline', 'MIDEN', '1W'],
      expect.any(Function),
      expect.objectContaining({ refreshInterval: 300000, dedupingInterval: 60000 })
    );
  });

  it('uses a null SWR key and returns an empty array when symbol is empty', () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useTokenSparkline(''));

    expect(result.current).toEqual([]);
    expect(mockUseRetryableSWR).toHaveBeenCalledWith(
      null,
      expect.any(Function),
      expect.objectContaining({ refreshInterval: 300000, dedupingInterval: 60000 })
    );
  });
});
