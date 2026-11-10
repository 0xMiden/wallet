import {
  basketHoldingValues,
  basketNav,
  basketPriceSources,
  fetchBasketPrices,
  isBasketQuote,
  readBasketVault,
  type BasketSource,
  type BasketVault
} from './basket-nav';
import type { TokenPrices } from './binance';

const mockGetAccountDetails = jest.fn();
const mockFree = jest.fn();
const mockFromAccountStorage = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  RpcClient: jest.fn(() => ({ getAccountDetails: mockGetAccountDetails, free: mockFree })),
  BasicFungibleFaucetComponent: { fromAccountStorage: (storage: unknown) => mockFromAccountStorage(storage) }
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: jest.fn(async () => undefined),
  getRpcEndpoint: () => 'https://rpc.example'
}));
jest.mock('lib/miden/sdk/helpers', () => ({ accountRefToSdk: (id: string) => `sdk:${id}` }));
jest.mock('lib/miden/swap/tokens', () => ({ normalizedFaucetId: (id: string) => id.toLowerCase() }));

const quote = (price: number, extra: Record<string, unknown> = {}) => ({
  price,
  change24h: 0,
  percentageChange24h: 0,
  ...extra
});

const SOURCE: BasketSource = {
  faucetId: 'mm1basket',
  priceSymbol: 'BSK',
  constituents: [
    { faucetId: 'mm1btc', priceSymbol: 'BTC', decimals: 8 },
    { faucetId: 'mm1eth', priceSymbol: 'ETH', decimals: 8 }
  ]
};
// 0.001 BTC and 0.05 ETH backing 200 shares of 8 decimals.
const VAULT: BasketVault = { supply: 200n * 10n ** 8n, decimals: 8, balances: [100_000n, 5_000_000n] };
const PRICES: TokenPrices = { BTC: quote(100_000), ETH: quote(4_000) };

describe('basketPriceSources', () => {
  const assets = new Map([
    ['mm1basket', 'BSK'],
    ['mm1btc', 'BTC'],
    ['mm1eth', 'ETH']
  ]);
  const decimals = new Map([
    ['mm1btc', 8],
    ['mm1eth', 8]
  ]);
  const baskets = new Map([['mm1basket', ['mm1btc', 'mm1eth']]]);

  it('names a basket whose price asset no exchange lists, with each constituent priced and its decimals', () => {
    expect(basketPriceSources(baskets, assets, decimals, symbol => symbol === 'BSK')).toEqual([SOURCE]);
  });

  it('leaves out a basket an exchange lists, or before both providers ruled its market out', () => {
    expect(basketPriceSources(baskets, assets, decimals, () => false)).toEqual([]);
  });

  it('leaves out a basket whose price asset another faucet shares', () => {
    const shared = new Map([...assets, ['mm1other', 'BSK']]);
    expect(basketPriceSources(baskets, shared, decimals, () => true)).toEqual([]);
  });

  it('leaves out a basket with a constituent the wallet does not price or whose decimals are unknown', () => {
    expect(basketPriceSources(new Map([['mm1basket', ['mm1btc', 'mm1zzz']]]), assets, decimals, () => true)).toEqual(
      []
    );
    expect(basketPriceSources(baskets, assets, new Map([['mm1btc', 8]]), () => true)).toEqual([]);
  });

  it('names nothing without a list', () => {
    expect(basketPriceSources(null, assets, decimals, () => true)).toEqual([]);
    expect(basketPriceSources(undefined, assets, undefined, () => true)).toEqual([]);
  });
});

describe('basketNav', () => {
  it('divides the value of the constituents by the supply', () => {
    // 0.001 BTC * 100,000 + 0.05 ETH * 4,000 = 300, over 200 shares.
    expect(basketHoldingValues(SOURCE, VAULT, PRICES)).toEqual([100, 200]);
    expect(basketNav(SOURCE, VAULT, PRICES)).toBeCloseTo(1.5, 12);
  });

  it('uses each constituent and the basket at their own decimals', () => {
    const source = { ...SOURCE, constituents: [{ faucetId: 'mm1usd', priceSymbol: 'USDC', decimals: 6 }] };
    const vault = { supply: 50_000n, decimals: 4, balances: [10_000_000n] };
    expect(basketNav(source, vault, { USDC: quote(1) })).toBeCloseTo(2, 12);
  });

  it('has no value while any constituent has no market quote', () => {
    expect(basketNav(SOURCE, VAULT, { BTC: quote(100_000) })).toBeUndefined();
    expect(basketNav(SOURCE, VAULT, { ...PRICES, ETH: quote(1, { source: 'basket' }) })).toBeUndefined();
  });

  it('has no value with no supply', () => {
    expect(basketNav(SOURCE, { ...VAULT, supply: 0n }, PRICES)).toBeUndefined();
  });

  it('has no value when the vault read misses a balance', () => {
    expect(basketNav(SOURCE, { ...VAULT, balances: [100_000n] }, PRICES)).toBeUndefined();
  });
});

describe('fetchBasketPrices', () => {
  it('quotes a basket at its net asset value under its price asset, with no move', async () => {
    const read = jest.fn(async () => VAULT);
    await expect(fetchBasketPrices([SOURCE], PRICES, read, () => 42)).resolves.toEqual({
      BSK: { price: 1.5, change24h: 0, percentageChange24h: 0, observedAt: 42, source: 'basket' }
    });
    expect(read).toHaveBeenCalledWith(SOURCE);
  });

  it('leaves out a basket whose vault cannot be read, and prices the others', async () => {
    const other = { ...SOURCE, faucetId: 'mm1other', priceSymbol: 'OTH' };
    const read = jest.fn(async (source: BasketSource) => {
      if (source.faucetId === 'mm1basket') throw new Error('rpc down');
      return VAULT;
    });
    const quotes = await fetchBasketPrices([SOURCE, other], PRICES, read, () => 1);
    expect(Object.keys(quotes)).toEqual(['OTH']);
  });

  it('leaves out a basket it cannot value', async () => {
    await expect(fetchBasketPrices([SOURCE], {}, async () => VAULT)).resolves.toEqual({});
  });
});

describe('readBasketVault', () => {
  beforeEach(() => {
    mockGetAccountDetails.mockReset();
    mockFree.mockReset();
    mockFromAccountStorage.mockReset();
  });

  it("reads the faucet's supply and decimals and each constituent's balance from the node, then frees the client", async () => {
    const storage = {};
    const getBalance = jest.fn((id: string) => (id === 'sdk:mm1btc' ? 100_000n : 5_000_000n));
    mockGetAccountDetails.mockResolvedValue({
      account: () => ({ storage: () => storage, vault: () => ({ getBalance }) })
    });
    mockFromAccountStorage.mockReturnValue({ tokenSupply: () => ({ asInt: () => VAULT.supply }), decimals: () => 8 });

    await expect(readBasketVault(SOURCE)).resolves.toEqual(VAULT);
    expect(mockGetAccountDetails).toHaveBeenCalledWith('sdk:mm1basket');
    expect(mockFromAccountStorage).toHaveBeenCalledWith(storage);
    expect(mockFree).toHaveBeenCalledTimes(1);
  });

  it('fails for an account with no public state, and still frees the client', async () => {
    mockGetAccountDetails.mockResolvedValue({ account: () => undefined });
    await expect(readBasketVault(SOURCE)).rejects.toThrow('has no public state');
    expect(mockFree).toHaveBeenCalledTimes(1);
  });
});

it('tells a basket quote from the others', () => {
  expect(isBasketQuote(quote(1, { source: 'basket' }))).toBe(true);
  expect(isBasketQuote(quote(1))).toBe(false);
  expect(isBasketQuote(undefined)).toBe(false);
});
