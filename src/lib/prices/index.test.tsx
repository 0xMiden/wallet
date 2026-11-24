import React from 'react';

import { act, render, renderHook } from '@testing-library/react';

import { fetchBasketPrices } from './basket-nav';
import { fetchKlineSeries, fetchTokenPrices, hasNoUsdMarket } from './feed';
import { PriceProvider, useBasketSparkline, useTokenSparkline } from './index';
import { writeUsdPriceCache } from './usd';

let mockNetwork = 'testnet';
let mockAssets = new Map([
  ['verified', 'ARB'],
  ['bridge', 'ETH']
]);
let mockSnapshot = 0;
const mockListeners = new Set<() => void>();
const mockListListeners = new Set<(network: string) => void>();
let mockLoadedAssets: Map<string, string> | null = null;
let mockBaskets: Map<string, string[]> | null = null;
let mockDecimals: Map<string, number> | null = null;
let mockSymbols: Map<string, string> | null = null;
let mockResolveList: ((value: Map<string, string> | null) => void) | undefined;
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
jest.mock('lib/token-list/runtime', () => ({
  peekTokenPriceAssets: () => mockLoadedAssets,
  peekTokenBaskets: () => mockBaskets,
  peekTokenDecimals: () => mockDecimals,
  peekTokenSymbols: () => mockSymbols,
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
jest.mock('lib/miden/swap/tokens', () => ({
  getPriceAssets: () => mockAssets,
  normalizedFaucetId: (id: string) => id
}));
jest.mock('lib/miden/front', () => ({ useMidenContext: () => mockWallet }));
jest.mock('./feed', () => ({
  fetchTokenPrices: jest.fn(async () => ({})),
  fetchKlineData: jest.fn(),
  fetchKlineSeries: jest.fn(),
  hasNoUsdMarket: jest.fn(() => false)
}));
jest.mock('./basket-nav', () => ({
  ...jest.requireActual('./basket-nav'),
  fetchBasketPrices: jest.fn(async () => ({}))
}));
jest.mock('./usd', () => ({ writeUsdPriceCache: jest.fn(async () => undefined) }));

// The list key while no list has loaded (`peekPriceListKey` with every peek null).
const NO_LIST_KEY = JSON.stringify([null, null, null, null]);

const mockUseRetryableSWR = jest.fn();
jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: any[]) => mockUseRetryableSWR(...args)
}));

const setTokenPrices = jest.fn();
const mockSetPriceState = jest.fn();
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign((selector: any) => selector({ setTokenPrices }), {
    setState: (...args: unknown[]) => mockSetPriceState(...args)
  })
}));

beforeEach(() => {
  mockNetwork = 'testnet';
  mockAssets = new Map([
    ['verified', 'ARB'],
    ['bridge', 'ETH']
  ]);
  mockLoadedAssets = null;
  mockBaskets = null;
  mockDecimals = null;
  mockSymbols = null;
  jest.mocked(hasNoUsdMarket).mockReturnValue(false);
  jest.mocked(fetchKlineSeries).mockReset();
  jest.mocked(fetchTokenPrices).mockClear();
  jest.mocked(fetchBasketPrices).mockClear();
  jest.mocked(writeUsdPriceCache).mockClear();
  mockWallet.locked = false;
  mockWallet.ready = true;
  setTokenPrices.mockClear();
  mockSetPriceState.mockClear();
  mockUseRetryableSWR.mockReset();
  mockUseRetryableSWR.mockReturnValue({
    data: {
      network: 'testnet',
      listKey: NO_LIST_KEY,
      assetKey: JSON.stringify([
        ['bridge', 'ETH'],
        ['verified', 'ARB']
      ]),
      prices: { ETH: { price: 3000, change24h: 10, percentageChange24h: 0.1, kind: 'market' as const } }
    }
  });
});

describe('PriceProvider', () => {
  it('exposes loading and failure separately from quote freshness', () => {
    mockUseRetryableSWR.mockReturnValue({ isLoading: true });
    const { rerender } = render(<PriceProvider />);
    expect(mockSetPriceState).toHaveBeenCalledWith({ tokenPricesStatus: 'loading' });
    mockUseRetryableSWR.mockReturnValue({ error: new Error('offline') });
    rerender(<PriceProvider />);
    expect(mockSetPriceState).toHaveBeenCalledWith({ tokenPricesStatus: 'error' });
  });
  it('pushes prices into the wallet store on mount', () => {
    render(<PriceProvider />);
    expect(setTokenPrices).toHaveBeenCalledWith({
      ETH: { price: 3000, change24h: 10, percentageChange24h: 0.1, kind: 'market' as const }
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
      ]),
      NO_LIST_KEY
    ]);
    await expect(fetcher()).resolves.toEqual({
      network: 'testnet',
      assetKey: key[2],
      listKey: key[3],
      prices: {},
      basketPrices: {}
    });
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
      JSON.stringify([['new', 'DOGE']]),
      JSON.stringify([[['new', 'DOGE']], null, null, null])
    ]);
    await mockUseRetryableSWR.mock.lastCall?.[1]();
    expect(fetchTokenPrices).toHaveBeenLastCalledWith(['DOGE']);
  });

  it('fetches again when a list refresh changes only a basket or its decimals', async () => {
    // Prices for the first loaded list key stay the answer after the list changes, as a stale cache would give them.
    let published: string | undefined;
    const nav = { ARB: { price: 1.5, change24h: 0, percentageChange24h: 0, kind: 'basket' as const } };
    mockUseRetryableSWR.mockImplementation((key: string[] | null) => {
      if (key && key[3] !== NO_LIST_KEY) published ??= key[3];
      const data = { network: key?.[1], assetKey: key?.[2], listKey: published, prices: {}, basketPrices: nav };
      return { data: key && published !== undefined ? data : undefined };
    });
    render(<PriceProvider />);
    await act(async () => {
      mockLoadedAssets = mockAssets;
      mockBaskets = new Map([['verified', ['bridge']]]);
      mockDecimals = new Map([['bridge', 8]]);
      mockResolveList?.(mockAssets);
    });
    const before = mockUseRetryableSWR.mock.lastCall?.[0];
    expect(setTokenPrices).toHaveBeenLastCalledWith(nav);

    await act(async () => {
      mockDecimals = new Map([['bridge', 18]]);
      mockListListeners.forEach(listener => listener('testnet'));
      mockResolveList?.(mockAssets);
    });
    const after = mockUseRetryableSWR.mock.lastCall?.[0];
    expect(after?.[2]).toBe(before?.[2]);
    expect(after?.[3]).not.toBe(before?.[3]);
    expect(after?.[3]).toBe(
      JSON.stringify([Array.from(mockAssets), [['verified', ['bridge']]], [['bridge', 18]], null])
    );
    // The old value is cleared, and prices fetched for the old list are not applied to the new one.
    expect(setTokenPrices).toHaveBeenLastCalledWith({});
  });

  it('symbol-only list change changes the price list key', async () => {
    render(<PriceProvider />);
    await act(async () => {
      mockLoadedAssets = mockAssets;
      mockBaskets = new Map([['verified', ['bridge']]]);
      mockDecimals = new Map([['bridge', 8]]);
      mockSymbols = new Map([['bridge', 'WETH']]);
      mockResolveList?.(mockAssets);
    });
    const before = mockUseRetryableSWR.mock.lastCall?.[0];

    // Only the constituent's symbol changes: its price asset, the basket and the decimals stay the same.
    await act(async () => {
      mockSymbols = new Map([['bridge', 'ETHER']]);
      mockListListeners.forEach(listener => listener('testnet'));
      mockResolveList?.(mockAssets);
    });
    const after = mockUseRetryableSWR.mock.lastCall?.[0];
    expect(after?.[2]).toBe(before?.[2]);
    expect(after?.[3]).not.toBe(before?.[3]);
    expect(after?.[3]).toBe(
      JSON.stringify([Array.from(mockAssets), [['verified', ['bridge']]], [['bridge', 8]], [['bridge', 'ETHER']]])
    );
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
      JSON.stringify([['bridge', 'BTC']]),
      NO_LIST_KEY
    ]);
    await mockUseRetryableSWR.mock.lastCall?.[1]();
    expect(fetchTokenPrices).toHaveBeenLastCalledWith(['BTC']);
  });

  it('clears quotes when a faucet is removed even when its symbol remains', () => {
    mockAssets.set('duplicate', 'ARB');
    mockUseRetryableSWR.mockReturnValue({
      data: {
        network: 'testnet',
        listKey: NO_LIST_KEY,
        assetKey: JSON.stringify([
          ['bridge', 'ETH'],
          ['duplicate', 'ARB'],
          ['verified', 'ARB']
        ]),
        prices: { ARB: { price: 1, change24h: 0, percentageChange24h: 0, kind: 'market' as const } }
      }
    });
    const view = render(<PriceProvider />);
    setTokenPrices.mockClear();
    mockSetPriceState.mockClear();
    mockAssets.delete('duplicate');
    view.rerender(<PriceProvider />);
    expect(setTokenPrices).toHaveBeenLastCalledWith({});
  });

  it('rejects a response from a previous network', () => {
    const view = render(<PriceProvider />);
    setTokenPrices.mockClear();
    mockSetPriceState.mockClear();
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
        listKey: NO_LIST_KEY,
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

  it('prices a basket from its vault only once the feed has ruled out its market', async () => {
    mockBaskets = new Map([['verified', ['bridge']]]);
    mockDecimals = new Map([['bridge', 8]]);
    mockSymbols = new Map([['bridge', 'WETH']]);
    render(<PriceProvider />);
    await mockUseRetryableSWR.mock.lastCall?.[1]();
    expect(fetchBasketPrices).not.toHaveBeenCalled();

    jest.mocked(hasNoUsdMarket).mockImplementation(symbol => symbol === 'ARB');
    const exchange = { ETH: { price: 3000, change24h: 10, percentageChange24h: 0.1, kind: 'market' as const } };
    jest.mocked(fetchTokenPrices).mockResolvedValueOnce(exchange);
    const basketPrices = {
      ARB: { price: 1.5, change24h: 0, percentageChange24h: 0, observedAt: 1, kind: 'basket' as const }
    };
    jest.mocked(fetchBasketPrices).mockResolvedValueOnce(basketPrices);
    await expect(mockUseRetryableSWR.mock.lastCall?.[1]()).resolves.toMatchObject({ basketPrices });
    expect(fetchBasketPrices).toHaveBeenCalledWith(
      [
        {
          faucetId: 'verified',
          priceSymbol: 'ARB',
          constituents: [{ faucetId: 'bridge', symbol: 'WETH', priceSymbol: 'ETH', decimals: 8 }]
        }
      ],
      exchange
    );
  });

  it('shows basket quotes under exchange quotes and never writes them to the spending-limit cache', () => {
    const exchange = { ETH: { price: 3000, change24h: 10, percentageChange24h: 0.1, kind: 'market' as const } };
    mockUseRetryableSWR.mockReturnValue({
      data: {
        network: 'testnet',
        listKey: NO_LIST_KEY,
        assetKey: JSON.stringify([
          ['bridge', 'ETH'],
          ['verified', 'ARB']
        ]),
        prices: exchange,
        basketPrices: {
          ARB: { price: 1.5, change24h: 0, percentageChange24h: 0, kind: 'basket' as const },
          ETH: { price: 1, change24h: 0, percentageChange24h: 0, kind: 'basket' as const }
        }
      }
    });
    render(<PriceProvider />);
    expect(setTokenPrices).toHaveBeenLastCalledWith({
      ...exchange,
      ARB: { price: 1.5, change24h: 0, percentageChange24h: 0, kind: 'basket' as const }
    });
    expect(writeUsdPriceCache).toHaveBeenLastCalledWith(exchange);
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

describe('useBasketSparkline', () => {
  const composition = [
    { faucetId: 'f-btc', symbol: 'WBTC', priceSymbol: 'BTC', weight: 0.6 },
    { faucetId: 'f-eth', symbol: 'ETH', priceSymbol: 'ETH', weight: 0.4 }
  ];
  const basketQuote = { price: 2, change24h: 0, percentageChange24h: 0, kind: 'basket' as const, composition };
  const livePrices = {
    BTC: { price: 120, change24h: 0, percentageChange24h: 0, kind: 'market' as const },
    ETH: { price: 50, change24h: 0, percentageChange24h: 0, kind: 'market' as const }
  };
  const btc = {
    stepMs: 10,
    points: [
      { time: 0, value: 100 },
      { time: 10, value: 110 }
    ]
  };
  const eth = {
    stepMs: 10,
    points: [
      { time: 0, value: 50 },
      { time: 10, value: 40 }
    ]
  };

  it("draws the basket's line from its tokens' candles, fetched once per mix and re-anchored locally", async () => {
    const candles = new Map([
      ['BTC', btc],
      ['ETH', eth]
    ]);
    mockUseRetryableSWR.mockReturnValue({ data: candles });

    const { result, rerender } = renderHook(
      ({ quote, prices }: { quote: typeof basketQuote; prices: typeof livePrices }) =>
        useBasketSparkline(quote, prices),
      { initialProps: { quote: basketQuote, prices: livePrices } }
    );

    expect(result.current).toEqual([1.8, 1.74]);
    const [key, fetcher, options] = mockUseRetryableSWR.mock.calls.at(-1)!;
    // The key has no price in it: a new net asset value re-anchors the line without another fetch.
    expect(key).toEqual(['basket-candles', 'BTC', 'ETH', '1D']);
    expect(options).toEqual(expect.objectContaining({ refreshInterval: 300000, dedupingInterval: 60000 }));
    jest.mocked(fetchKlineSeries).mockResolvedValueOnce(btc).mockResolvedValueOnce(eth);
    await expect(fetcher()).resolves.toEqual(candles);
    expect(fetchKlineSeries).toHaveBeenCalledTimes(2);
    expect(fetchKlineSeries).toHaveBeenCalledWith('BTC', '1D');
    expect(fetchKlineSeries).toHaveBeenCalledWith('ETH', '1D');

    jest.mocked(fetchKlineSeries).mockClear();
    const updatedQuote = { ...basketQuote, price: 4 };
    rerender({ quote: updatedQuote, prices: livePrices });
    expect(result.current).toEqual([3.6, 3.48]);
    expect(mockUseRetryableSWR.mock.calls.at(-1)![0]).toEqual(['basket-candles', 'BTC', 'ETH', '1D']);
    expect(fetchKlineSeries).not.toHaveBeenCalled();

    const updatedPrices = {
      BTC: { price: 150, change24h: 0, percentageChange24h: 0, kind: 'market' as const },
      ETH: { price: 80, change24h: 0, percentageChange24h: 0, kind: 'market' as const }
    };
    rerender({ quote: updatedQuote, prices: updatedPrices });
    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toBeCloseTo(2.6, 10);
    expect(result.current[1]).toBeCloseTo(2.56, 10);
    expect(mockUseRetryableSWR.mock.calls.at(-1)![0]).toEqual(['basket-candles', 'BTC', 'ETH', '1D']);
    expect(fetchKlineSeries).not.toHaveBeenCalled();
  });

  it('keeps the same SWR key and preserves composition order when weights are reordered', () => {
    const reordered = [
      { faucetId: 'f-eth', symbol: 'ETH', priceSymbol: 'ETH', weight: 0.4 },
      { faucetId: 'f-btc', symbol: 'WBTC', priceSymbol: 'BTC', weight: 0.6 }
    ];
    mockUseRetryableSWR.mockReturnValue({
      data: new Map([
        ['BTC', btc],
        ['ETH', eth]
      ])
    });

    const { result } = renderHook(() => useBasketSparkline({ ...basketQuote, composition: reordered }, livePrices));

    expect(mockUseRetryableSWR.mock.calls.at(-1)![0]).toEqual(['basket-candles', 'BTC', 'ETH', '1D']);
    expect(result.current).toEqual([1.8, 1.74]);
  });

  it('fetches each unique priceSymbol once across faucets sharing a priceSymbol', async () => {
    const repeated = [
      { faucetId: 'f-eth', symbol: 'ETH', priceSymbol: 'ETH', weight: 0.3 },
      { faucetId: 'f-btc', symbol: 'WBTC', priceSymbol: 'BTC', weight: 0.5 },
      { faucetId: 'f-reth', symbol: 'rETH', priceSymbol: 'ETH', weight: 0.2 }
    ];
    const candles = new Map([
      ['BTC', btc],
      ['ETH', eth]
    ]);
    mockUseRetryableSWR.mockReturnValue({ data: candles });

    const { result } = renderHook(() => useBasketSparkline({ ...basketQuote, composition: repeated }, livePrices));

    const [key, fetcher] = mockUseRetryableSWR.mock.calls.at(-1)!;
    expect(key).toEqual(['basket-candles', 'BTC', 'ETH', '1D']);
    jest.mocked(fetchKlineSeries).mockResolvedValueOnce(btc).mockResolvedValueOnce(eth);
    await expect(fetcher()).resolves.toEqual(candles);
    expect(fetchKlineSeries).toHaveBeenCalledTimes(2);
    expect(fetchKlineSeries).toHaveBeenCalledWith('BTC', '1D');
    expect(fetchKlineSeries).toHaveBeenCalledWith('ETH', '1D');
    // At t=0: 2 * (0.3 * 1 + 0.5 * (100/120) + 0.2 * 1) = 2 * (0.5 + 5/12) = 11/6
    // At t=10: 2 * (0.3 * 0.8 + 0.5 * (110/120) + 0.2 * 0.8) = 2 * (0.4 + 11/24) = 103/60
    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toBeCloseTo(11 / 6, 10);
    expect(result.current[1]).toBeCloseTo(103 / 60, 10);
  });

  it('fetches nothing and returns an empty line for a quote that is not a basket', () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined });

    const { result } = renderHook(() =>
      useBasketSparkline({ kind: 'market' as const, price: 2, change24h: 0, percentageChange24h: 0 }, {})
    );

    expect(result.current).toEqual([]);
    expect(mockUseRetryableSWR.mock.calls.at(-1)![0]).toBeNull();
  });

  it('fetches nothing and returns an empty line for a market quote carrying a composition', () => {
    mockUseRetryableSWR.mockReturnValue({
      data: new Map([
        ['BTC', btc],
        ['ETH', eth]
      ])
    });

    const { result } = renderHook(() =>
      useBasketSparkline({ kind: 'market' as const, price: 2, change24h: 0, percentageChange24h: 0, composition }, {})
    );

    expect(result.current).toEqual([]);
    expect(mockUseRetryableSWR.mock.calls.at(-1)![0]).toBeNull();
  });

  it('fetches nothing and returns an empty line when composition is empty or has an empty priceSymbol', () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined });

    const { result: emptyResult } = renderHook(() => useBasketSparkline({ ...basketQuote, composition: [] }, {}));
    expect(emptyResult.current).toEqual([]);
    expect(mockUseRetryableSWR.mock.calls.at(-1)![0]).toBeNull();

    const { result: blankSymbolResult } = renderHook(() =>
      useBasketSparkline(
        {
          ...basketQuote,
          composition: [
            { faucetId: 'f-btc', symbol: 'WBTC', priceSymbol: 'BTC', weight: 0.6 },
            { faucetId: 'f-empty', symbol: 'EMPTY', priceSymbol: '', weight: 0.4 }
          ]
        },
        {}
      )
    );

    expect(blankSymbolResult.current).toEqual([]);
    expect(mockUseRetryableSWR.mock.calls.at(-1)![0]).toBeNull();
  });

  it('returns an empty line while the candles load', () => {
    mockUseRetryableSWR.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useBasketSparkline(basketQuote, {}));

    expect(result.current).toEqual([]);
  });
});
