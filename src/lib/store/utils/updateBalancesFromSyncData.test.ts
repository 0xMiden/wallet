import '../../../../test/jest-mocks';

import { TOKEN_IETH } from 'lib/miden/swap/tokens';
import { SerializedVaultAsset } from 'lib/shared/types';
import { __resetFaucetAssetsMetadataForTest, faucetMetadataOf, useWalletStore } from 'lib/store';

import { updateBalancesFromSyncData } from './updateBalancesFromSyncData';

const MOCK_MIDEN_FAUCET_ID = 'miden-faucet-123';
let mockNativeAssetId: string | null = null;
let mockNativeMetadata: { symbol: string; decimals: number } | null = null;
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockNativeAssetId,
  getNativeAssetMetadataSync: () => mockNativeMetadata,
  getSdkSyncedNativeAssetIdSync: () => mockNativeAssetId
}));

jest.mock('lib/miden/assets', () => ({
  ...jest.requireActual('lib/miden/assets'),
  getFaucetIdSetting: jest.fn(async () => 'miden-faucet-123')
}));

const mockFetchTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata', () => ({
  ...jest.requireActual('lib/miden/metadata'),
  fetchTokenMetadata: (...args: any[]) => mockFetchTokenMetadata(...args)
}));

jest.mock('../../miden/front/assets', () => ({
  setTokensBaseMetadata: jest.fn(async () => {})
}));

// The stored overrides are the input under test. The apply logic is the real one.
const mockGetTokenMetadataOverrides = jest.fn();
jest.mock('lib/miden/metadata/overrides', () => ({
  ...jest.requireActual('lib/miden/metadata/overrides'),
  getTokenMetadataOverrides: () => mockGetTokenMetadataOverrides()
}));

describe('updateBalancesFromSyncData', () => {
  beforeEach(() => {
    useWalletStore.setState({
      balances: {},
      balancesLoading: {},
      balancesLastFetched: {},
      assetsMetadata: {},
      tokenMetadataOverrides: {}
    });
    __resetFaucetAssetsMetadataForTest();
    jest.clearAllMocks();
    mockGetTokenMetadataOverrides.mockReset().mockResolvedValue({});
  });

  describe('the user override of a token', () => {
    it("scales the balance by the faucet's decimals whatever decimals are stored, and the store adopts the faucet record unchanged", async () => {
      const faucetRecord = { name: 'CustomToken', symbol: 'CTK', decimals: 6 };
      const override = { name: 'Mine', symbol: 'MINE', decimals: 2 };
      // Stored, and loaded into the store: a landed read shows the store's overrides.
      mockGetTokenMetadataOverrides.mockResolvedValue({ 'custom-faucet-456': override });
      useWalletStore.getState().hydrateTokenMetadataOverrides({ 'custom-faucet-456': override });

      await updateBalancesFromSyncData('account-1', [
        { faucetId: 'custom-faucet-456', amountBaseUnits: '2000000', metadata: faucetRecord }
      ]);

      const custom = useWalletStore.getState().balances['account-1']!.find(b => b.tokenId === 'custom-faucet-456');
      // 2000000 base units at the faucet's 6 decimals.
      expect(custom).toMatchObject({
        tokenSlug: 'MINE',
        balance: 2,
        metadata: { name: 'Mine', symbol: 'MINE', decimals: 6 }
      });
      expect(custom!.metadata.scaleFromOverride).toBeUndefined();
      expect(faucetMetadataOf('custom-faucet-456')).toEqual(faucetRecord);
    });

    it('gives a quantity to a token with no metadata once the user states its decimals', async () => {
      const override = { name: 'Mine', symbol: 'MN', decimals: 3 };
      mockGetTokenMetadataOverrides.mockResolvedValue({ 'bare-faucet': override });
      useWalletStore.getState().hydrateTokenMetadataOverrides({ 'bare-faucet': override });

      await updateBalancesFromSyncData('account-1', [{ faucetId: 'bare-faucet', amountBaseUnits: '2000' }]);

      const bare = useWalletStore.getState().balances['account-1']!.find(b => b.tokenId === 'bare-faucet');
      expect(bare).toMatchObject({
        balance: 2,
        metadata: { decimals: 3, scaleIsUnknown: false, scaleFromOverride: true }
      });
    });

    it("adopts the sync's record over the placeholder an override made, and shows the override on top", async () => {
      const override = { name: 'Mine', symbol: 'MN', decimals: 3 };
      // The provider's hydration of a stored override for a faucet with no record. Its decimals make the entry a known scale.
      useWalletStore.getState().hydrateTokenMetadataOverrides({ 'fresh-faucet': override });
      mockGetTokenMetadataOverrides.mockResolvedValue({ 'fresh-faucet': override });
      const faucetRecord = { name: 'Fresh', symbol: 'FRS', decimals: 6 };

      await updateBalancesFromSyncData('account-1', [
        { faucetId: 'fresh-faucet', amountBaseUnits: '2000000', metadata: faucetRecord }
      ]);

      expect(faucetMetadataOf('fresh-faucet')).toEqual(faucetRecord);
      const state = useWalletStore.getState();
      expect(state.assetsMetadata['fresh-faucet']).toEqual({ name: 'Mine', symbol: 'MN', decimals: 6 });
      expect(state.balances['account-1']!.find(b => b.tokenId === 'fresh-faucet')).toMatchObject({
        tokenSlug: 'MN',
        balance: 2
      });
    });

    it('shows the placeholder for an unresolved faucet whose override the store no longer holds', async () => {
      // The sync's storage read still returned the override; the store has already dropped it.
      mockGetTokenMetadataOverrides.mockResolvedValue({ 'bare-faucet': { name: 'Mine', symbol: 'MN', decimals: 3 } });

      await updateBalancesFromSyncData('account-1', [{ faucetId: 'bare-faucet', amountBaseUnits: '2000' }]);

      const landed = useWalletStore.getState().balances['account-1']!.find(b => b.tokenId === 'bare-faucet')!;
      expect(landed.tokenSlug).toBe('Unknown');
      expect(landed).toMatchObject({
        balance: 0.002,
        metadata: { symbol: 'Unknown', decimals: 6, scaleIsUnknown: true }
      });
    });

    it("shows the store's override when the storage read had not seen it yet", async () => {
      // Saved in the store; its storage write has not landed, so the sync's read returns none.
      useWalletStore.getState().hydrateTokenMetadataOverrides({ 'fresh-faucet': { name: 'Mine', symbol: 'MN' } });
      mockGetTokenMetadataOverrides.mockResolvedValue({});

      await updateBalancesFromSyncData('account-1', [
        {
          faucetId: 'fresh-faucet',
          amountBaseUnits: '2000000',
          metadata: { name: 'Fresh', symbol: 'FRS', decimals: 6 }
        }
      ]);

      const landed = useWalletStore.getState().balances['account-1']!.find(b => b.tokenId === 'fresh-faucet')!;
      expect(landed.tokenSlug).toBe('MN');
      expect(landed).toMatchObject({ balance: 2, metadata: { name: 'Mine', symbol: 'MN', decimals: 6 } });
    });

    it('leaves the display row of a legacy faucet setting as the sync built it', async () => {
      mockNativeAssetId = 'actual-native';
      mockNativeMetadata = { symbol: 'USDCX', decimals: 6 };
      const legacyRecord = { name: 'Legacy', symbol: 'LEGACY', decimals: 2 };
      // The legacy faucet's record reaches the store while the sync runs, after it read the store.
      mockGetTokenMetadataOverrides.mockImplementation(async () => {
        useWalletStore.getState().setAssetsMetadata({ [MOCK_MIDEN_FAUCET_ID]: legacyRecord });
        return {};
      });

      await updateBalancesFromSyncData('account-1', []);

      const display = useWalletStore.getState().balances['account-1']!.find(b => b.tokenId === MOCK_MIDEN_FAUCET_ID)!;
      expect(display.tokenSlug).toBe('USDCX');
      expect(display).toMatchObject({ balance: 0, metadata: { symbol: 'USDCX', decimals: 6 } });
      expect(useWalletStore.getState().assetsMetadata[MOCK_MIDEN_FAUCET_ID]).toEqual(legacyRecord);
    });

    it('never applies an override to the native token', async () => {
      mockNativeAssetId = MOCK_MIDEN_FAUCET_ID;
      mockNativeMetadata = { symbol: 'MIDEN', decimals: 6 };
      mockGetTokenMetadataOverrides.mockResolvedValue({
        [MOCK_MIDEN_FAUCET_ID]: { name: 'Fake', symbol: 'FAKE', decimals: 2 }
      });

      await updateBalancesFromSyncData('account-1', [{ faucetId: MOCK_MIDEN_FAUCET_ID, amountBaseUnits: '5000000' }]);

      expect(useWalletStore.getState().balances['account-1']![0]).toMatchObject({ tokenSlug: 'MIDEN', balance: 5 });
    });
  });

  afterEach(() => {
    mockNativeAssetId = null;
    mockNativeMetadata = null;
  });

  it('converts vault assets to balances with MIDEN token', async () => {
    mockNativeAssetId = MOCK_MIDEN_FAUCET_ID;
    mockNativeMetadata = { symbol: 'MIDEN', decimals: 6 };
    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: MOCK_MIDEN_FAUCET_ID, amountBaseUnits: '5000000000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    const state = useWalletStore.getState();
    const balances = state.balances['account-1']!;
    expect(balances).toBeDefined();
    expect(balances.length).toBe(1);
    expect(balances[0]!.tokenId).toBe(MOCK_MIDEN_FAUCET_ID);
    expect(balances[0]!.tokenSlug).toBe('MIDEN');
    expect(balances[0]!.balance).toBe(5000); // 5000000000 / 10^6
    expect(state.balancesLoading['account-1']).toBe(false);
    expect(state.balancesLastFetched['account-1']).toBeGreaterThan(0);
  });

  it('always includes MIDEN token even when vault is empty', async () => {
    await updateBalancesFromSyncData('account-1', []);

    const balances = useWalletStore.getState().balances['account-1']!;
    expect(balances.length).toBe(1);
    expect(balances[0]!.tokenId).toBe(MOCK_MIDEN_FAUCET_ID);
    expect(balances[0]!.balance).toBe(0);
  });

  it("adopts the snapshot's record into the store and leaves persisting it to the service worker", async () => {
    const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');
    // Swapped through the state, not spied on a state object: every later state copies the property.
    const original = useWalletStore.getState().setAssetsMetadata;
    const setAssetsMetadata = jest.fn(original);
    useWalletStore.setState({ setAssetsMetadata });
    const record = { name: 'TOK', symbol: 'TOK', decimals: 6 };

    try {
      await updateBalancesFromSyncData('account-1', [
        { faucetId: 'tok-faucet', amountBaseUnits: '1000000', metadata: record }
      ]);

      expect(setTokensBaseMetadata).not.toHaveBeenCalled();
      expect(setAssetsMetadata).toHaveBeenCalledWith({ 'tok-faucet': record });
      expect(faucetMetadataOf('tok-faucet')).toEqual(record);
    } finally {
      useWalletStore.setState({ setAssetsMetadata: original });
    }
  });

  it('uses pre-fetched metadata from sync data for unknown tokens', async () => {
    const customFaucetId = 'custom-faucet-456';

    const vaultAssets: SerializedVaultAsset[] = [
      {
        faucetId: customFaucetId,
        amountBaseUnits: '2000000',
        metadata: { name: 'CustomToken', symbol: 'CTK', decimals: 6 }
      }
    ];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    // Should NOT fetch via RPC — metadata comes from sync data
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();

    const balances = useWalletStore.getState().balances['account-1']!;
    // Custom token + default MIDEN (0 balance)
    expect(balances.length).toBe(2);
    const customBalance = balances.find(b => b.tokenId === customFaucetId);
    expect(customBalance).toBeDefined();
    expect(customBalance!.tokenSlug).toBe('CTK');
    expect(customBalance!.balance).toBe(2); // 2000000 / 10^6
  });

  it('uses cached metadata from Zustand store instead of fetching', async () => {
    const customFaucetId = 'cached-faucet-789';
    useWalletStore.setState({
      assetsMetadata: {
        [customFaucetId]: { name: 'CachedToken', symbol: 'CACHE', decimals: 8 }
      }
    });

    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: customFaucetId, amountBaseUnits: '100000000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    // Should not fetch — metadata was already in the store
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();

    const balances = useWalletStore.getState().balances['account-1']!;
    const cachedBalance = balances.find(b => b.tokenId === customFaucetId);
    expect(cachedBalance!.balance).toBe(1); // 100000000 / 10^8
  });

  it('uses existing tokenPrices from store (non-nullish tokenPrices branch)', async () => {
    useWalletStore.setState({
      tokenPrices: { MIDEN: { price: 2.5, change24h: 0.1, percentageChange24h: 5 } }
    });

    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: MOCK_MIDEN_FAUCET_ID, amountBaseUnits: '1000000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    const balances = useWalletStore.getState().balances['account-1'];
    expect(balances).toBeDefined();
    expect(balances!.length).toBe(1);
    expect(balances![0]!.tokenId).toBe(MOCK_MIDEN_FAUCET_ID);
  });

  it('stores the quote of the price symbol, and no price for a token the feed does not quote', async () => {
    useWalletStore.setState({
      tokenPrices: { ETH: { price: 3000, change24h: 40, percentageChange24h: 1.2 } }
    });
    const vaultAssets: SerializedVaultAsset[] = [
      {
        faucetId: TOKEN_IETH.faucetId,
        amountBaseUnits: '38000000',
        metadata: { name: 'IETH', symbol: 'IETH', decimals: 8 }
      },
      {
        faucetId: 'custom-faucet-456',
        amountBaseUnits: '2000000',
        metadata: { name: 'CustomToken', symbol: 'CTK', decimals: 6 }
      }
    ];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    const balances = useWalletStore.getState().balances['account-1']!;
    const priceOf = (tokenId: string) => {
      const { fiatPrice, change24h } = balances.find(b => b.tokenId === tokenId)!;
      return { fiatPrice, change24h };
    };
    expect(priceOf(TOKEN_IETH.faucetId)).toEqual({ fiatPrice: 3000, change24h: 40 });
    expect(priceOf('custom-faucet-456')).toEqual({ fiatPrice: 0, change24h: 0 });
    // The fabricated native row has no quote either: MIDEN is not on the feed.
    expect(priceOf(MOCK_MIDEN_FAUCET_ID)).toEqual({ fiatPrice: 0, change24h: 0 });
  });

  it('uses default metadata when sync data has no metadata for a token', async () => {
    const unknownFaucetId = 'unknown-faucet';

    // No metadata field — simulates SW metadata fetch failure
    const vaultAssets: SerializedVaultAsset[] = [{ faucetId: unknownFaucetId, amountBaseUnits: '1000' }];

    await updateBalancesFromSyncData('account-1', vaultAssets);

    const balances = useWalletStore.getState().balances['account-1']!;
    // Should still have the token (with default metadata) + MIDEN
    expect(balances.length).toBe(2);
    const unknownBalance = balances.find(b => b.tokenId === unknownFaucetId);
    expect(unknownBalance).toBeDefined();
    expect(unknownBalance!.tokenSlug).toBe('Unknown');
  });
  // A cached record whose scale is a guess is provisional. Preferring the cache
  // unconditionally is what made a single failed lookup permanent: the placeholder
  // was written once and then outranked every later, correct answer.
  describe('a cached record whose scale is unknown', () => {
    const FOREIGN = 'foreign-faucet';

    it('is replaced by real metadata arriving on a later sync', async () => {
      useWalletStore.setState({
        assetsMetadata: { [FOREIGN]: { symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true } }
      });

      await updateBalancesFromSyncData('account-1', [
        {
          faucetId: FOREIGN,
          amountBaseUnits: '1000000000000000000',
          metadata: { symbol: 'DAI', name: 'Dai', decimals: 18 }
        }
      ]);

      const balances = useWalletStore.getState().balances['account-1']!;
      const dai = balances.find(b => b.tokenId === FOREIGN)!;
      expect(dai.metadata.symbol).toBe('DAI');
      // Scaled by the real 18, not the placeholder's 6 — which would read
      // 1,000,000,000,000 instead of 1.
      expect(dai.balance).toBe(1);
    });

    it('is not written to the cache, so the faucet stays eligible for a retry', async () => {
      const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');

      await updateBalancesFromSyncData('account-1', [{ faucetId: FOREIGN, amountBaseUnits: '1000' }]);

      const persisted = setTokensBaseMetadata.mock.calls.some(
        ([written]: [Record<string, unknown>]) => written && FOREIGN in written
      );
      expect(persisted).toBe(false);
      // Nor recorded as the faucet's record, which is what decides whether it is fetched again.
      expect(faucetMetadataOf(FOREIGN)).toBeUndefined();
    });

    // The guard that matters here is on the `asset.metadata` branch: a placeholder
    // arriving ON the sync payload is the one that would otherwise be written.
    // The no-metadata case exercises a different branch that never writes at all.
    it('is not persisted when the placeholder arrives on the sync payload', async () => {
      const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');

      await updateBalancesFromSyncData('account-1', [
        {
          faucetId: FOREIGN,
          amountBaseUnits: '1000',
          metadata: { symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true }
        }
      ]);

      const wrote = (calls: [Record<string, unknown>][]) => calls.some(([written]) => written && FOREIGN in written);

      expect(wrote(setTokensBaseMetadata.mock.calls)).toBe(false);
      expect(useWalletStore.getState().assetsMetadata[FOREIGN]).toBeUndefined();
      expect(faucetMetadataOf(FOREIGN)).toBeUndefined();
    });

    it('still lists the token so the holding does not vanish', async () => {
      await updateBalancesFromSyncData('account-1', [{ faucetId: FOREIGN, amountBaseUnits: '1000' }]);

      const balances = useWalletStore.getState().balances['account-1']!;
      expect(balances.some(b => b.tokenId === FOREIGN)).toBe(true);
    });
  });
});

describe('native chain metadata', () => {
  it('preserves the native symbol and eight-decimal scale received from sync', async () => {
    useWalletStore.setState({ balances: {}, assetsMetadata: {} });
    await updateBalancesFromSyncData('native-account', [
      {
        faucetId: MOCK_MIDEN_FAUCET_ID,
        amountBaseUnits: '123000000',
        metadata: { symbol: 'USDCX', decimals: 8, name: 'USDCX', scaleIsUnknown: false }
      }
    ]);
    expect(useWalletStore.getState().balances['native-account']?.[0]).toEqual(
      expect.objectContaining({
        tokenSlug: 'USDCX',
        balance: 1.23,
        metadata: expect.objectContaining({ symbol: 'USDCX', decimals: 8 })
      })
    );
  });
});

describe('actual native sync balance with a separate legacy display selection', () => {
  const actual = 'native-A';
  const legacy = 'legacy-B';
  beforeEach(() => {
    mockNativeAssetId = actual;
    mockNativeMetadata = { symbol: 'USDCX', decimals: 6 };
    jest.requireMock('lib/miden/assets').getFaucetIdSetting.mockResolvedValue(legacy);
    useWalletStore.setState({
      balances: {},
      tokenPrices: {},
      assetsMetadata: {
        [actual]: { symbol: 'MIDEN', name: 'Miden', decimals: 8 },
        [legacy]: { symbol: 'LEGACY', name: 'Legacy', decimals: 2 },
        foreign: { symbol: 'FOREIGN', name: 'Foreign', decimals: 8 }
      }
    });
  });
  afterEach(() => {
    mockNativeAssetId = null;
    mockNativeMetadata = null;
    jest.requireMock('lib/miden/assets').getFaucetIdSetting.mockResolvedValue(MOCK_MIDEN_FAUCET_ID);
  });
  it.each([legacy, actual, undefined])('uses actual native metadata with legacy selection %s', async selection => {
    jest.requireMock('lib/miden/assets').getFaucetIdSetting.mockResolvedValue(selection);
    await updateBalancesFromSyncData('native-account', [
      { faucetId: actual, amountBaseUnits: '1000000', metadata: { symbol: 'USDCX', name: 'USDCX', decimals: 6 } },
      {
        faucetId: 'foreign',
        amountBaseUnits: '200000000',
        metadata: { symbol: 'IGNORED', name: 'Ignored', decimals: 6 }
      }
    ]);
    const balances = useWalletStore.getState().balances['native-account']!;
    const native = balances.find(row => row.tokenId === actual)!;
    expect(native.balance).toBe(1);
    expect(native.metadata).toMatchObject({ symbol: 'USDCX', decimals: 6 });
    expect(native.fiatPrice * native.balance).toBe(1);
    expect(balances.find(row => row.tokenId === 'foreign')).toMatchObject({ balance: 2, tokenSlug: 'FOREIGN' });
    expect(
      balances.filter(row => row.tokenId === legacy).map(({ balance, tokenSlug }) => ({ balance, tokenSlug }))
    ).toEqual(selection === legacy ? [{ balance: 0, tokenSlug: 'LEGACY' }] : []);
  });
  it.each([
    { symbol: 'Unknown', name: 'Unknown', decimals: 8, scaleIsUnknown: true },
    { symbol: 'STALE', name: 'Stale', decimals: 8 }
  ])('preserves known foreign legacy metadata over incoming $symbol metadata', async metadata => {
    await updateBalancesFromSyncData('native-account', [
      { faucetId: actual, amountBaseUnits: '1000000', metadata: { symbol: 'USDCX', name: 'USDCX', decimals: 6 } },
      { faucetId: legacy, amountBaseUnits: '125', metadata }
    ]);
    const balances = useWalletStore.getState().balances['native-account']!;
    const native = balances.find(row => row.tokenId === actual)!;
    expect(native).toMatchObject({ balance: 1, fiatPrice: 1, metadata: { symbol: 'USDCX', decimals: 6 } });
    const legacyBalance = balances.find(row => row.tokenId === legacy)!;
    expect(legacyBalance).toMatchObject({ balance: 1.25, fiatPrice: 0, metadata: { symbol: 'LEGACY', decimals: 2 } });
    expect(legacyBalance.metadata.scaleIsUnknown).not.toBe(true);
    expect(useWalletStore.getState().assetsMetadata[legacy]).toMatchObject({ symbol: 'LEGACY', decimals: 2 });
  });

  it('preserves native eight-decimal scale against cached six-decimal metadata', async () => {
    mockNativeMetadata = { symbol: 'USDCX', decimals: 8 };
    useWalletStore.setState({ assetsMetadata: { [actual]: { symbol: 'USDCX', name: 'USDCX', decimals: 6 } } });
    await updateBalancesFromSyncData('native-account', [
      { faucetId: actual, amountBaseUnits: '100000000', metadata: { symbol: 'USDCX', name: 'USDCX', decimals: 8 } }
    ]);
    const native = useWalletStore.getState().balances['native-account']!.find(row => row.tokenId === actual)!;
    expect(native.balance).toBe(1);
    expect(native.metadata.decimals).toBe(8);
    expect(native.fiatPrice).toBe(1);
  });
});
