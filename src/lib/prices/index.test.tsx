import React from 'react';

import { act, render, renderHook } from '@testing-library/react';

import { fetchTokenPrices } from './feed';
import { PriceProvider, useTokenSparkline } from './index';

let mockNetwork = 'testnet';
let mockAssets = new Map([
  ['verified', 'ARB'],
  ['bridge', 'ETH']
]);
let mockSnapshot = 0;
const mockListeners = new Set<() => void>();
const mockListListeners = new Set<(network: string) => void>();
let mockLoadedAssets: Map<string, string> | null = null;
let mockResolveList: ((value: Map<string, string> | null) => void) | undefined;
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
jest.mock('lib/token-list/runtime', () => ({
  peekTokenPriceAssets: () => mockLoadedAssets,
  loadTokenPriceAssets: () =>
    new Promise<Map<string, string> | null>(resolve => {
      mockResolveList = resolve;
    }),
  onTokenListUpdated: (listener: (network: string) => void) => {
    mockListListeners.add(listener);
    return () => {
      mockListListeners.delete(listener);
    };
  }
}));
const mockWallet = { locked: false, ready: true };
jest.mock('lib/remote-config/runtime', () => ({
  subscribeBridgeConfig: (listener: () => void) => {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
  getBridgeConfigSnapshot: () => mockSnapshot
}));
jest.mock('lib/miden/swap/tokens', () => ({ getPriceAssets: () => mockAssets }));
jest.mock('lib/miden/front', () => ({ useMidenContext: () => mockWallet }));
jest.mock('./feed', () => ({ fetchTokenPrices: jest.fn(async () => ({})), fetchKlineData: jest.fn() }));

const mockUseRetryableSWR = jest.fn();
jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: any[]) => mockUseRetryableSWR(...args)
}));

const setTokenPrices = jest.fn();
jest.mock('lib/store', () => ({
  useWalletStore: (selector: any) => selector({ setTokenPrices })
}));

beforeEach(() => {
  mockNetwork = 'testnet';
  mockAssets = new Map([
    ['verified', 'ARB'],
    ['bridge', 'ETH']
  ]);
  mockLoadedAssets = null;
  mockWallet.locked = false;
  mockWallet.ready = true;
  setTokenPrices.mockClear();
  mockUseRetryableSWR.mockReset();
  mockUseRetryableSWR.mockReturnValue({
    data: {
      network: 'testnet',
      assetKey: JSON.stringify([
        ['bridge', 'ETH'],
        ['verified', 'ARB']
      ]),
      prices: { ETH: { price: 3000, change24h: 10, percentageChange24h: 0.1 } }
    }
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
  ])('reads prices once a wallet exists (%s)', async (_state, wallet) => {
    Object.assign(mockWallet, wallet);
    render(<PriceProvider />);
    const [key, fetcher] = mockUseRetryableSWR.mock.calls[0]!;
    expect(key).toEqual([
      'token-prices',
      'testnet',
      JSON.stringify([
        ['bridge', 'ETH'],
        ['verified', 'ARB']
      ])
    ]);
    await expect(fetcher()).resolves.toEqual({ network: 'testnet', assetKey: key[2], prices: {} });
    expect(fetchTokenPrices).toHaveBeenLastCalledWith(['ARB', 'ETH']);
  });

  it('fetches each price asset once and leaves the fixed USDCX quote out', async () => {
    mockAssets = new Map([
      ['verified', 'ARB'],
      ['bridge', 'ETH'],
      ['twin', 'ETH'],
      ['native', 'USDCX']
    ]);
    render(<PriceProvider />);
    await mockUseRetryableSWR.mock.lastCall?.[1]();
    expect(fetchTokenPrices).toHaveBeenLastCalledWith(['ARB', 'ETH']);
  });

  it('requests new assets after the list arrives', async () => {
    render(<PriceProvider />);
    await act(async () => {
      mockAssets = new Map([['new', 'DOGE']]);
      mockLoadedAssets = mockAssets;
      mockResolveList?.(mockAssets);
    });
    expect(mockUseRetryableSWR.mock.lastCall?.[0]).toEqual([
      'token-prices',
      'testnet',
      JSON.stringify([['new', 'DOGE']])
    ]);
    await mockUseRetryableSWR.mock.lastCall?.[1]();
    expect(fetchTokenPrices).toHaveBeenLastCalledWith(['DOGE']);
  });

  it('requests new assets after bridge config arrives', async () => {
    render(<PriceProvider />);
    act(() => {
      mockAssets = new Map([['bridge', 'BTC']]);
      mockSnapshot += 1;
      mockListeners.forEach(listener => listener());
    });
    expect(mockUseRetryableSWR.mock.lastCall?.[0]).toEqual([
      'token-prices',
      'testnet',
      JSON.stringify([['bridge', 'BTC']])
    ]);
    await mockUseRetryableSWR.mock.lastCall?.[1]();
    expect(fetchTokenPrices).toHaveBeenLastCalledWith(['BTC']);
  });

  it('clears quotes when a faucet is removed even when its symbol remains', () => {
    mockAssets.set('duplicate', 'ARB');
    mockUseRetryableSWR.mockReturnValue({
      data: {
        network: 'testnet',
        assetKey: JSON.stringify([
          ['bridge', 'ETH'],
          ['duplicate', 'ARB'],
          ['verified', 'ARB']
        ]),
        prices: { ARB: { price: 1, change24h: 0, percentageChange24h: 0 } }
      }
    });
    const view = render(<PriceProvider />);
    setTokenPrices.mockClear();
    mockAssets.delete('duplicate');
    view.rerender(<PriceProvider />);
    expect(setTokenPrices).toHaveBeenLastCalledWith({});
  });

  it('rejects a response from a previous network', () => {
    const view = render(<PriceProvider />);
    setTokenPrices.mockClear();
    mockNetwork = 'devnet';
    view.rerender(<PriceProvider />);
    expect(setTokenPrices).toHaveBeenCalledTimes(1);
    expect(setTokenPrices).toHaveBeenLastCalledWith({});
  });

  it('clears previous quotes when a request returns an empty price object', () => {
    const view = render(<PriceProvider />);
    mockUseRetryableSWR.mockReturnValue({
      data: {
        network: 'testnet',
        assetKey: JSON.stringify([
          ['bridge', 'ETH'],
          ['verified', 'ARB']
        ]),
        prices: {}
      }
    });
    view.rerender(<PriceProvider />);
    expect(setTokenPrices).toHaveBeenLastCalledWith({});
  });

  it('does not copy cached prices while the SWR key is disabled', () => {
    mockWallet.ready = false;
    render(<PriceProvider />);
    expect(setTokenPrices).toHaveBeenCalledTimes(1);
    expect(setTokenPrices).toHaveBeenCalledWith({});
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
