import {
  basketComposition,
  basketHoldingValues,
  basketNav,
  basketPriceSources,
  fetchBasketPrices,
  isBasketQuote,
  readBasketVault,
  type BasketSource,
  type BasketVault
} from './basket-nav';
import type { TokenPriceInfo, TokenPrices } from './binance';

const mockGetAccountDetails = jest.fn();
const mockFree = jest.fn();
const mockGetAccountProof = jest.fn();
const mockProofFree = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  RpcClient: jest.fn(() => ({
    getAccountDetails: mockGetAccountDetails,
    getAccountProof: mockGetAccountProof,
    free: mockFree
  })),
  Word: jest.fn((limbs: BigUint64Array) => ({ limbs }))
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: jest.fn(async () => undefined),
  getRpcEndpoint: () => 'https://rpc.example'
}));
jest.mock('lib/miden/sdk/helpers', () => ({ accountRefToSdk: (id: string) => `sdk:${id}` }));
jest.mock('lib/miden/swap/tokens', () => ({ normalizedFaucetId: (id: string) => id.toLowerCase() }));

const quote = (price: number, extra: Partial<TokenPriceInfo> = {}) => ({
  price,
  change24h: 0,
  percentageChange24h: 0,
  ...extra
});

const SOURCE: BasketSource = {
  faucetId: 'mm1basket',
  priceSymbol: 'BSK',
  constituents: [
    { faucetId: 'mm1btc', symbol: 'WBTC', priceSymbol: 'BTC', decimals: 8 },
    { faucetId: 'mm1eth', symbol: 'ETH', priceSymbol: 'ETH', decimals: 8 }
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
    const symbols = new Map([['mm1btc', 'WBTC']]);
    expect(basketPriceSources(baskets, assets, decimals, symbol => symbol === 'BSK', symbols)).toEqual([SOURCE]);
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
    const source = {
      ...SOURCE,
      constituents: [{ faucetId: 'mm1usd', symbol: 'USDC', priceSymbol: 'USDC', decimals: 6 }]
    };
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
      BSK: {
        price: 1.5,
        change24h: 0,
        percentageChange24h: 0,
        observedAt: 42,
        source: 'basket',
        // $200 of ETH and $100 of BTC: the vault's own mix, largest first.
        composition: [
          { faucetId: 'mm1eth', symbol: 'ETH', priceSymbol: 'ETH', weight: 2 / 3 },
          { faucetId: 'mm1btc', symbol: 'WBTC', priceSymbol: 'BTC', weight: 1 / 3 }
        ]
      }
    });
    expect(read).toHaveBeenCalledWith(SOURCE);
  });

  it('leaves out a basket whose vault holds nothing', async () => {
    const empty = { ...VAULT, balances: [0n, 0n] };
    const quotes = await fetchBasketPrices([SOURCE], PRICES, async () => empty);
    expect(quotes.BSK).toBeUndefined();
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

const TOKEN_CONFIG = [VAULT.supply, VAULT.supply * 2n, 8n, 8765514n];
const holding = (id: string, amount: bigint) => ({
  faucetId: () => `sdk:${id}`,
  amount: () => amount
});
const HOLDINGS = [holding('mm1eth', 5_000_000n), holding('mm1btc', 100_000n), holding('mm1fee', 999_999n)];
const vaultProof = (config: readonly bigint[] | null = TOKEN_CONFIG, holdings = HOLDINGS) => ({
  accountHeader: () => ({}),
  getStorageSlotValue: jest.fn((slot: string) => {
    if (slot !== 'miden::standards::faucets::fungible::token_config' || config === null) return undefined;
    return { toU64s: () => new BigUint64Array(config) };
  }),
  vaultFungibleAssets: () => holdings,
  free: mockProofFree
});

describe('readBasketVault', () => {
  beforeEach(() => {
    mockGetAccountDetails.mockReset();
    mockGetAccountDetails.mockRejectedValue(new Error('storage map exceeds the node inline limit'));
    mockGetAccountProof.mockReset();
    mockFree.mockReset();
    mockProofFree.mockReset();
  });

  it('reads supply and holdings from one proof when a full-account read would fail for a large storage map', async () => {
    const proof = vaultProof();
    mockGetAccountProof.mockResolvedValue(proof);

    await expect(readBasketVault(SOURCE)).resolves.toEqual(VAULT);
    expect(mockGetAccountProof).toHaveBeenCalledWith('sdk:mm1basket', undefined, undefined, {
      limbs: new BigUint64Array(4)
    });
    expect(mockGetAccountDetails).not.toHaveBeenCalled();
    expect(proof.getStorageSlotValue).toHaveBeenCalledTimes(1);
    expect(proof.getStorageSlotValue).toHaveBeenCalledWith('miden::standards::faucets::fungible::token_config');
    expect(mockProofFree).toHaveBeenCalledTimes(1);
    expect(mockFree).toHaveBeenCalledTimes(1);
  });

  it('uses zero for an absent constituent and ignores other vault assets', async () => {
    mockGetAccountProof.mockResolvedValue(vaultProof(TOKEN_CONFIG, [HOLDINGS[0]!, HOLDINGS[2]!]));
    await expect(readBasketVault(SOURCE)).resolves.toEqual({ ...VAULT, balances: [0n, 5_000_000n] });
  });

  it('accepts an empty vault as zero holdings', async () => {
    mockGetAccountProof.mockResolvedValue(vaultProof(TOKEN_CONFIG, []));
    await expect(readBasketVault(SOURCE)).resolves.toEqual({ ...VAULT, balances: [0n, 0n] });
  });

  it('fails for an account with no public state and frees the proof and client', async () => {
    mockGetAccountProof.mockResolvedValue({ ...vaultProof(), accountHeader: () => undefined });
    await expect(readBasketVault(SOURCE)).rejects.toThrow('has no public state');
    expect(mockProofFree).toHaveBeenCalledTimes(1);
    expect(mockFree).toHaveBeenCalledTimes(1);
  });

  it('rejects a proof with no vault data instead of using zero holdings', async () => {
    mockGetAccountProof.mockResolvedValue({ ...vaultProof(), vaultFungibleAssets: () => undefined });
    await expect(readBasketVault(SOURCE)).rejects.toThrow('has no vault data');
    expect(mockProofFree).toHaveBeenCalledTimes(1);
    expect(mockFree).toHaveBeenCalledTimes(1);
  });

  it.each([
    { config: null, message: 'Missing faucet metadata slot' },
    { config: [2n, 1n, 8n, 8765514n], message: 'Invalid faucet supply' },
    { config: [1n << 63n, 1n << 63n, 8n, 8765514n], message: 'Invalid faucet supply' },
    { config: [1n, 2n, 13n, 8765514n], message: 'Invalid faucet decimals' },
    { config: [1n, 2n, 8n, 0n], message: 'Invalid faucet symbol' }
  ])('rejects invalid token configuration: $message', async ({ config, message }) => {
    mockGetAccountProof.mockResolvedValue(vaultProof(config));
    await expect(readBasketVault(SOURCE)).rejects.toThrow(message);
    expect(mockProofFree).toHaveBeenCalledTimes(1);
    expect(mockFree).toHaveBeenCalledTimes(1);
  });

  it('leaves a basket unpriced when its proof is unavailable and frees the client after retries', async () => {
    mockGetAccountProof.mockRejectedValue(new Error('rpc unavailable'));
    await expect(fetchBasketPrices([SOURCE], PRICES)).resolves.toEqual({});
    expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
    expect(mockFree).toHaveBeenCalledTimes(1);
    expect(mockProofFree).not.toHaveBeenCalled();
  });
});

it('tells a basket quote from the others', () => {
  expect(isBasketQuote(quote(1, { source: 'basket' }))).toBe(true);
  expect(isBasketQuote(quote(1))).toBe(false);
  expect(isBasketQuote(undefined)).toBe(false);
});

it('splits a basket by the value each constituent holds, largest first', () => {
  expect(basketComposition(SOURCE, [100, 300])).toEqual([
    { faucetId: 'mm1eth', symbol: 'ETH', priceSymbol: 'ETH', weight: 0.75 },
    { faucetId: 'mm1btc', symbol: 'WBTC', priceSymbol: 'BTC', weight: 0.25 }
  ]);
  expect(basketComposition(SOURCE, [0, 0])).toBeUndefined();
});
