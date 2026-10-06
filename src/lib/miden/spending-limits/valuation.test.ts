import {
  TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET,
  TEST_NATIVE_ETH_FAUCET as MIDEN_AGGLAYER_FAUCET_ID
} from 'lib/epoch/testing/bridge-config';
import { _setSwapTokensForTest, TOKEN_IBTC, TOKEN_IETH, TOKEN_IMIDEN, TOKEN_IUSDT } from 'lib/miden/swap/tokens';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import {
  getNativeAssetId,
  getNativeAssetIdSync,
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync
} from 'lib/miden-chain/native-asset';
import { getPriceMicro } from 'lib/prices/usd';
import { initBridgeConfig } from 'lib/remote-config/runtime';

import { fetchTokenMetadata } from '../metadata';
import { SpendingLimitPriceUnavailableError } from './types';
import { resolveSpendsUsd, usdMicroFromAmount } from './valuation';
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(async () => 'native-fee'),
  getNativeAssetMetadata: jest.fn(async () => ({ symbol: 'MIDEN', decimals: 6 })),
  getNativeAssetIdSync: jest.fn(() => 'native-fee'),
  getNativeAssetMetadataSync: jest.fn(() => ({ symbol: 'MIDEN', decimals: 6 })),
  getSdkSyncedNativeAssetIdSync: jest.fn(() => 'native-fee')
}));

// The bridged price entries the testnet config names (the manual mock beside the module).
jest.mock('lib/miden/swap/bridge-price-allowlist');
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: jest.fn(() => Promise.resolve()) }));
jest.mock('lib/prices/usd', () => ({
  ...jest.requireActual('lib/prices/usd'),
  getPriceMicro: jest.fn()
}));
jest.mock('../metadata', () => ({ fetchTokenMetadata: jest.fn() }));
// The shared SDK mock has no MidenClient, so the real readiness call would throw.
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: jest.fn(() => Promise.resolve())
}));
// The dApp custom path emits a faucet's hex spelling; map one to IETH's bech32 id so the test
// can tell whether the canonical id or the raw one reaches the price-symbol lookup.
const IETH_HEX = '0x1eth00000000000000000000000000';
// The shared SDK mock parses no id, and the cap refuses a spend it cannot canonicalize, so every
// other id parses to itself and the metadata mocks below can key on the fixtures' own spelling.
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  accountRefToSdk: (id: string) => id,
  getBech32AddressFromAccountId: (id: string) =>
    id === IETH_HEX ? jest.requireActual('lib/miden/swap/tokens').TOKEN_IETH.faucetId : id
}));

const mockedPrice = jest.mocked(getPriceMicro);
const mockedMetadata = jest.mocked(fetchTokenMetadata);
const mockedSdkReady = jest.mocked(ensureSdkWasmReady);

const base = (symbol: string, decimals: number, scaleIsUnknown?: boolean) => ({
  base: { symbol, decimals, name: symbol, ...(scaleIsUnknown !== undefined && { scaleIsUnknown }) },
  detailed: { symbol, decimals, name: symbol }
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getNativeAssetId).mockResolvedValue('native-fee');
  jest.mocked(getNativeAssetIdSync).mockReturnValue('native-fee');
  jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'MIDEN', decimals: 6 });
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'MIDEN', decimals: 6 });
  jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue('native-fee');
});

describe('usdMicroFromAmount', () => {
  it('converts whole units at the quoted price', () => {
    // 2 ETH at $4000 = $8000
    expect(usdMicroFromAmount(2_000_000_000_000_000_000n, 18, 4_000_000_000n)).toBe(8_000_000_000n);
  });

  it('rounds up so a charge is never understated', () => {
    // 1 base unit of an 18-decimal asset at $4000 is a vanishing fraction of a micro-dollar.
    expect(usdMicroFromAmount(1n, 18, 4_000_000_000n)).toBe(1n);
  });

  it('is exact when the division has no remainder', () => {
    expect(usdMicroFromAmount(1_000_000n, 6, 1_000_000n)).toBe(1_000_000n);
  });

  it('values nothing as nothing', () => {
    expect(usdMicroFromAmount(0n, 6, 1_000_000n)).toBe(0n);
  });

  it('rejects impossible inputs rather than producing a number', () => {
    expect(() => usdMicroFromAmount(-1n, 6, 1n)).toThrow(RangeError);
    expect(() => usdMicroFromAmount(1n, -1, 1n)).toThrow(RangeError);
    expect(() => usdMicroFromAmount(1n, 6, -1n)).toThrow(RangeError);
  });
});

describe('resolveSpendsUsd', () => {
  it('waits for this realm to hydrate the bridge config before it identifies or prices a spend', async () => {
    let hydrated: () => void = () => undefined;
    jest.mocked(initBridgeConfig).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          hydrated = () =>
            resolve({ network: 'testnet', status: 'ready', config: null, derived: null, lastFetch: null });
        })
    );
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    const valued = resolveSpendsUsd([{ faucetId: MIDEN_USDC_FAUCET, amount: 25_000_000n }], 10);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockedMetadata).not.toHaveBeenCalled();
    hydrated();

    await expect(valued).resolves.toBe(25_000_000n);
  });

  it('values a covered asset', async () => {
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: MIDEN_USDC_FAUCET, amount: 25_000_000n }], 10)).resolves.toBe(
      25_000_000n
    );
  });

  // #1131: coverage comes from the faucet id, never from the symbol a faucet gives itself.
  it('counts a faucet that only calls itself USDC as uncovered and never asks for its price', async () => {
    mockedMetadata.mockResolvedValue(base('USDC', 6));

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 25_000_000n }], 10)).resolves.toBe(0n);
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('counts an uncovered asset as nothing and never asks for its price', async () => {
    mockedMetadata.mockResolvedValue(base('MIDEN', 6));

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 999_000_000n }], 10)).resolves.toBe(0n);
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('sums across several assets', async () => {
    mockedMetadata.mockImplementation(async faucetId =>
      faucetId === MIDEN_AGGLAYER_FAUCET_ID
        ? base('ETH', 18)
        : faucetId === MIDEN_USDC_FAUCET
          ? base('USDC', 6)
          : base('MIDEN', 6)
    );
    mockedPrice.mockImplementation(async symbol => (symbol === 'ETH' ? 4_000_000_000n : 1_000_000n));

    const total = await resolveSpendsUsd(
      [
        { faucetId: MIDEN_AGGLAYER_FAUCET_ID, amount: 1_000_000_000_000_000_000n },
        { faucetId: MIDEN_USDC_FAUCET, amount: 10_000_000n },
        { faucetId: 'miden', amount: 500_000_000n }
      ],
      10
    );

    expect(total).toBe(4_010_000_000n);
  });

  it('fails closed when a covered asset has no fresh price', async () => {
    mockedMetadata.mockResolvedValue(base('ETH', 18));
    mockedPrice.mockResolvedValue(undefined);

    await expect(resolveSpendsUsd([{ faucetId: MIDEN_AGGLAYER_FAUCET_ID, amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('fails closed when a covered asset has untrustworthy decimals', async () => {
    mockedMetadata.mockResolvedValue(base('USDC', 6, true));
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('fails closed when the asset cannot be identified at all', async () => {
    mockedMetadata.mockRejectedValue(new Error('rpc down'));

    const valued = resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10);
    await expect(valued).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    await expect(valued).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'rpc down' }) });
  });

  it('fails closed when metadata resolves to the unidentified placeholder instead of rejecting', async () => {
    // `fetchTokenMetadata` does not always throw on a faucet it cannot identify - three of its
    // paths RESOLVE the `Unknown` placeholder instead (and cache it on two of them). That is still
    // an unidentified faucet, so the spend is challenged before the allowlist match, not counted
    // as an uncovered faucet at zero.
    mockedMetadata.mockResolvedValue(base('Unknown', 6, true));

    await expect(resolveSpendsUsd([{ faucetId: 'f1', amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('values an empty spend list as nothing', async () => {
    await expect(resolveSpendsUsd([], 10)).resolves.toBe(0n);
    expect(mockedMetadata).not.toHaveBeenCalled();
    expect(mockedSdkReady).not.toHaveBeenCalled();
  });

  it('reads no metadata until the SDK has loaded (#1131 F-012)', async () => {
    let load!: () => void;
    mockedSdkReady.mockReturnValueOnce(new Promise<void>(resolve => (load = resolve)));
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    const valued = resolveSpendsUsd([{ faucetId: MIDEN_USDC_FAUCET, amount: 25_000_000n }], 10);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockedMetadata).not.toHaveBeenCalled();

    load();
    await expect(valued).resolves.toBe(25_000_000n);
    expect(mockedSdkReady).toHaveBeenCalledTimes(1);
  });

  it('refuses a spend it cannot value because the SDK will not load (#1131 F-012)', async () => {
    mockedSdkReady.mockRejectedValueOnce(new Error('wasm fetch failed'));
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    const valued = resolveSpendsUsd([{ faucetId: MIDEN_USDC_FAUCET, amount: 25_000_000n }], 10);
    await expect(valued).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    await expect(valued).rejects.toMatchObject({ symbol: MIDEN_USDC_FAUCET });
    await expect(valued).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'wasm fetch failed' }) });
    expect(mockedMetadata).not.toHaveBeenCalled();
  });

  it('values IETH and IBTC at the ETH and BTC price (#1133)', async () => {
    mockedMetadata.mockImplementation(async faucetId =>
      faucetId === TOKEN_IETH.faucetId ? base('IETH', 8) : base('IBTC', 8)
    );
    mockedPrice.mockImplementation(async symbol => (symbol === 'ETH' ? 4_000_000_000n : 100_000_000_000n));

    const total = await resolveSpendsUsd(
      [
        { faucetId: TOKEN_IETH.faucetId, amount: 50_000_000n },
        { faucetId: TOKEN_IBTC.faucetId, amount: 1_000_000n }
      ],
      10
    );

    // 0.5 ETH at $4000 + 0.01 BTC at $100000
    expect(total).toBe(3_000_000_000n);
    expect(mockedPrice.mock.calls.map(call => call[0]).sort()).toEqual(['BTC', 'ETH']);
  });

  it('values an IETH spend spelled as hex, as the dApp custom path emits it (#1133)', async () => {
    mockedMetadata.mockResolvedValue(base('IETH', 8));
    mockedPrice.mockResolvedValue(4_000_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: IETH_HEX, amount: 100_000_000n }], 10)).resolves.toBe(4_000_000_000n);
    expect(mockedPrice).toHaveBeenCalledWith('ETH', 10);
  });

  it('fails closed when IETH has no fresh ETH price (#1133)', async () => {
    mockedMetadata.mockResolvedValue(base('IETH', 8));
    mockedPrice.mockResolvedValue(undefined);

    await expect(resolveSpendsUsd([{ faucetId: TOKEN_IETH.faucetId, amount: 1n }], 10)).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
    expect(mockedPrice).toHaveBeenCalledWith('ETH', 10);
  });

  it('does not value a non-registry faucet that calls itself IETH at the ETH price (#1133)', async () => {
    mockedMetadata.mockResolvedValue(base('IETH', 8));
    mockedPrice.mockResolvedValue(4_000_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: 'mtst1notregistry', amount: 100_000_000n }], 10)).resolves.toBe(0n);
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  // #1131: allowlist membership is coverage. A price symbol the feed never quotes has no price to
  // read, so the spend is refused rather than counted as nothing.
  it('refuses an allowlisted faucet whose price symbol the feed does not quote (#1131 F-004)', async () => {
    _setSwapTokensForTest([
      { symbol: 'INOPE', faucetId: 'mtst1nope', decimals: 8, logoSymbol: 'MIDEN', priceSymbol: 'NOPE' }
    ]);
    try {
      mockedMetadata.mockResolvedValue(base('INOPE', 8));
      mockedPrice.mockResolvedValue(undefined);

      await expect(resolveSpendsUsd([{ faucetId: 'mtst1nope', amount: 100_000_000n }], 10)).rejects.toBeInstanceOf(
        SpendingLimitPriceUnavailableError
      );
      expect(mockedPrice).toHaveBeenCalledWith('NOPE', 10);
    } finally {
      _setSwapTokensForTest(undefined);
    }
  });

  it('still counts registry tokens without a price symbol as nothing (#1133)', async () => {
    mockedMetadata.mockImplementation(async faucetId =>
      faucetId === TOKEN_IUSDT.faucetId ? base('IUSDT', 8) : base('IMIDEN', 8)
    );

    await expect(
      resolveSpendsUsd(
        [
          { faucetId: TOKEN_IUSDT.faucetId, amount: 999_000_000n },
          { faucetId: TOKEN_IMIDEN.faucetId, amount: 999_000_000n }
        ],
        10
      )
    ).resolves.toBe(0n);
    expect(mockedPrice).not.toHaveBeenCalled();
  });
});

describe('native identity readiness', () => {
  it.each([
    [6, 8, 1_000_000n],
    [8, 6, 100_000_000n]
  ])('values a native dollar at chain decimals %i despite cached decimals %i', async (chain, cached, amount) => {
    jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'USDCX', decimals: chain });
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: chain });
    mockedMetadata.mockResolvedValue(base('USDCX', cached));
    mockedPrice.mockResolvedValue(1_000_000n);
    await expect(resolveSpendsUsd([{ faucetId: 'native-fee', amount }])).resolves.toBe(1_000_000n);
    expect(mockedMetadata).not.toHaveBeenCalled();
  });

  it('values independently allowlisted foreign USDC before native identity is available', async () => {
    jest
      .mocked(getNativeAssetId)
      .mockRejectedValueOnce(new Error('fee faucet is not known until the first successful chain sync'));
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(null);
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: MIDEN_USDC_FAUCET, amount: 1_000_000n }], 10)).resolves.toBe(1_000_000n);
    expect(mockedMetadata).toHaveBeenCalledWith(MIDEN_USDC_FAUCET);
    expect(mockedPrice).toHaveBeenCalledWith('USDC', 10);
    expect(getNativeAssetMetadata).not.toHaveBeenCalled();
  });

  it.each(['USDCX', 'USDC'])(
    'refuses an independently unpriced %s spend while native identity is unavailable',
    async symbol => {
      const cause = new Error('fee faucet is not known until the first successful chain sync');
      jest.mocked(getNativeAssetId).mockRejectedValueOnce(cause);
      jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
      jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(null);
      mockedMetadata.mockResolvedValue(base(symbol, 6));

      await expect(resolveSpendsUsd([{ faucetId: 'native-fee', amount: 1_000_000n }])).rejects.toMatchObject({ cause });
      expect(mockedPrice).not.toHaveBeenCalled();
    }
  );

  it('values foreign allowlisted USDC without native USDCX authentication proof', async () => {
    jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(null);
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);
    await expect(resolveSpendsUsd([{ faucetId: MIDEN_USDC_FAUCET, amount: 1_000_000n }])).resolves.toBe(1_000_000n);
    expect(mockedPrice).toHaveBeenCalledWith('USDC', undefined);
  });

  it('refuses a native identity WASM trap even for independently allowlisted foreign USDC', async () => {
    const cause = new WebAssembly.RuntimeError('native identity hydration trapped');
    jest.mocked(getNativeAssetId).mockRejectedValueOnce(cause);
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    const valued = resolveSpendsUsd([{ faucetId: MIDEN_USDC_FAUCET, amount: 1_000_000n }]);
    await expect(valued).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    await expect(valued).rejects.toMatchObject({ cause });
    expect(mockedMetadata).not.toHaveBeenCalled();
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('refuses a native USDCX spend with another synchronized faucet proof', async () => {
    jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue('other-native-fee');
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: 'native-fee', amount: 1_000_000n }])).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('values independently allowlisted foreign USDC when native protocol proof differs', async () => {
    jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue('other-native-fee');
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockResolvedValue(1_000_000n);

    await expect(resolveSpendsUsd([{ faucetId: MIDEN_USDC_FAUCET, amount: 1_000_000n }])).resolves.toBe(1_000_000n);
  });

  it('refuses a native USDCX spend without protocol proof', async () => {
    jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(null);
    mockedMetadata.mockResolvedValue(base('USDCX', 6));
    await expect(resolveSpendsUsd([{ faucetId: 'native-fee', amount: 1_000_000n }])).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('refuses a native spend with an explicit unknown-scale marker', async () => {
    jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: true });
    mockedMetadata.mockResolvedValue(base('USDCX', 6));
    await expect(resolveSpendsUsd([{ faucetId: 'native-fee', amount: 1_000_000n }])).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('refuses valuation when native identity cannot be hydrated', async () => {
    jest.mocked(getNativeAssetId).mockRejectedValueOnce(new Error('native identity unavailable'));
    await expect(resolveSpendsUsd([{ faucetId: 'native-fee', amount: 1_000_000n }])).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
  });

  it('refuses a native USDCX spend when native metadata is unresolved', async () => {
    jest.mocked(getNativeAssetId).mockResolvedValueOnce('native-fee');
    jest.mocked(getNativeAssetMetadata).mockResolvedValueOnce(null);
    mockedMetadata.mockResolvedValue(base('USDCX', 6));
    await expect(resolveSpendsUsd([{ faucetId: 'native-fee', amount: 1_000_000n }])).rejects.toBeInstanceOf(
      SpendingLimitPriceUnavailableError
    );
    expect(mockedPrice).not.toHaveBeenCalled();
  });

  it('hydrates native identity before resolving its fixed quote in a cold realm', async () => {
    let release: () => void = () => undefined;
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(null);
    jest.mocked(getNativeAssetId).mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          release = () => {
            jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
            jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue('native-fee');
            resolve('native-fee');
          };
        })
    );
    jest.mocked(getNativeAssetMetadata).mockResolvedValueOnce({ symbol: 'USDCX', decimals: 6 });
    mockedMetadata.mockResolvedValue(base('USDCX', 6));
    mockedPrice.mockResolvedValue(1_000_000n);
    const valued = resolveSpendsUsd([{ faucetId: 'native-fee', amount: 1_000_000n }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockedMetadata).not.toHaveBeenCalled();
    release();
    await expect(valued).resolves.toBe(1_000_000n);
  });
  it.each(['stable', 'metadata', 'price'])(
    'counts both dollars across the preceding foreign %s boundary',
    async boundary => {
      jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'USDCX', decimals: 6 });
      jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
      const invalidateLiveCache = () => {
        jest.mocked(getNativeAssetIdSync).mockReturnValue(null);
        jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
      };
      mockedMetadata.mockImplementation(async () => {
        if (boundary === 'metadata') invalidateLiveCache();
        return base('USDC', 6);
      });
      mockedPrice.mockImplementation(async symbol => {
        if (boundary === 'price' && symbol === 'USDC') invalidateLiveCache();
        return 1_000_000n;
      });

      await expect(
        resolveSpendsUsd([
          { faucetId: MIDEN_USDC_FAUCET, amount: 1_000_000n },
          { faucetId: 'native-fee', amount: 1_000_000n }
        ])
      ).resolves.toBe(2_000_000n);
      expect(mockedMetadata.mock.calls).toEqual([[MIDEN_USDC_FAUCET]]);
      expect(mockedPrice.mock.calls).toEqual([
        ['USDC', undefined],
        ['USDCX', undefined]
      ]);
    }
  );

  it('refuses the second native spend when synchronized proof is lost during the first price await', async () => {
    jest.mocked(getNativeAssetMetadata).mockResolvedValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    mockedMetadata.mockResolvedValue(base('USDC', 6));
    mockedPrice.mockImplementationOnce(async () => {
      jest.mocked(getNativeAssetIdSync).mockReturnValue(null);
      jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
      jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(null);
      return 1_000_000n;
    });

    await expect(
      resolveSpendsUsd([
        { faucetId: MIDEN_USDC_FAUCET, amount: 1_000_000n },
        { faucetId: 'native-fee', amount: 1_000_000n }
      ])
    ).rejects.toBeInstanceOf(SpendingLimitPriceUnavailableError);
    expect(mockedPrice.mock.calls).toEqual([['USDC', undefined]]);
  });
});
