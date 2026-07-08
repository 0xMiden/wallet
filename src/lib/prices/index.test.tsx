import React from 'react';

import { render, renderHook } from '@testing-library/react';

import { PriceProvider, useTokenSparkline } from './index';

const mockUseRetryableSWR = jest.fn();
jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: any[]) => mockUseRetryableSWR(...args)
}));

const setTokenPrices = jest.fn();
jest.mock('lib/store', () => ({
  useWalletStore: (selector: any) => selector({ setTokenPrices })
}));

beforeEach(() => {
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
