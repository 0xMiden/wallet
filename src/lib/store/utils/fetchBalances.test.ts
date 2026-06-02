import '../../../../test/jest-mocks';

import { AssetMetadata, MIDEN_METADATA } from 'lib/miden/metadata';

import { fetchBalances } from './fetchBalances';

// Mock dependencies
const mockGetAccount = jest.fn();
const mockSyncState = jest.fn();
const mockGetMidenClient = jest.fn(() => ({
  getAccount: mockGetAccount,
  syncState: mockSyncState
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: async <T>(operation: () => Promise<T>): Promise<T> => operation()
}));

jest.mock('lib/miden/assets', () => ({
  getFaucetIdSetting: jest.fn(() => 'miden-faucet-id')
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: string) => `bech32-${id}`)
}));

// Mock fetchTokenMetadata used by fetchBalances for inline metadata fetching
const mockFetchTokenMetadata = jest.fn();

jest.mock('lib/miden/metadata', () => ({
  MIDEN_METADATA: { name: 'Miden', symbol: 'MIDEN', decimals: 8 },
  DEFAULT_TOKEN_METADATA: { name: 'Unknown', symbol: 'Unknown', decimals: 6 },
  fetchTokenMetadata: (...args: unknown[]) => mockFetchTokenMetadata(...args),
  getAssetUrl: jest.fn((path: string) => `/${path}`)
}));

jest.mock('../../miden/front/assets', () => ({
  setTokensBaseMetadata: jest.fn()
}));

describe('fetchBalances', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGetAccount.mockReset();
    mockSyncState.mockReset();
    mockFetchTokenMetadata.mockReset();
  });

  beforeAll(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('returns default MIDEN balance when account not found', async () => {
    mockGetAccount.mockResolvedValueOnce(null);

    const result = await fetchBalances('unknown-address', {});

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      tokenId: 'miden-faucet-id',
      tokenSlug: 'MIDEN',
      metadata: MIDEN_METADATA,
      fiatPrice: 1,
      balance: 0,
      change24h: 0
    });
  });

  it('returns empty list when account not found AND native-asset discovery has not resolved', async () => {
    // Pre-discovery state: getFaucetIdSetting returns '' / undefined, so we
    // can't fabricate a "0 MIDEN" row and must return [] so the UI renders a
    // skeleton instead of a misattributed token.
    const { getFaucetIdSetting } = jest.requireMock('lib/miden/assets');
    getFaucetIdSetting.mockReturnValueOnce(undefined);
    mockGetAccount.mockResolvedValueOnce(null);

    const result = await fetchBalances('unknown-address', {});

    expect(result).toEqual([]);
  });

  it('returns balances for account with assets', async () => {
    // Mock so bech32 conversion always returns the miden faucet id for this test
    // (called multiple times: filter check + map in balance building)
    const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
    getBech32AddressFromAccountId.mockImplementation(() => 'miden-faucet-id');

    const mockAssets = [
      {
        faucetId: () => 'raw-miden-faucet',
        amount: () => ({ toString: () => '100000000' }) // 1 MIDEN (8 decimals per mock)
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    const result = await fetchBalances('my-address', {});

    expect(result).toHaveLength(1);
    expect(result[0]!.tokenSlug).toBe('MIDEN');
    expect(result[0]!.balance).toBe(1);

    // Restore default mock
    getBech32AddressFromAccountId.mockImplementation((id: string) => `bech32-${id}`);
  });

  it('includes zero MIDEN balance if not in vault', async () => {
    const tokenMetadata: AssetMetadata = { name: 'Other Token', symbol: 'OTH', decimals: 6 };
    const mockAssets = [
      {
        faucetId: () => 'other-faucet',
        amount: () => ({ toString: () => '1000000' }) // 1 OTH (6 decimals)
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    const result = await fetchBalances('my-address', { 'bech32-other-faucet': tokenMetadata });

    // Should NOT call fetchTokenMetadata — metadata already cached in tokenMetadatas
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    // Other token
    expect(result[0]!.tokenSlug).toBe('OTH');
    expect(result[0]!.balance).toBe(1);
    // MIDEN with 0 balance
    expect(result[1]!.tokenSlug).toBe('MIDEN');
    expect(result[1]!.balance).toBe(0);
  });

  it('shows unknown tokens with default metadata when fetch fails', async () => {
    const mockAssets = [
      {
        faucetId: () => 'unknown-faucet',
        amount: () => ({ toString: () => '1000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    // fetchTokenMetadata will throw for unknown token — falls back to DEFAULT_TOKEN_METADATA
    mockFetchTokenMetadata.mockRejectedValueOnce(new Error('Not found'));

    const result = await fetchBalances('my-address', {});

    // Unknown token shown with default metadata + MIDEN with 0 balance
    expect(result).toHaveLength(2);
    expect(result[0]!.tokenSlug).toBe('Unknown');
    expect(result[1]!.tokenSlug).toBe('MIDEN');
  });

  it('fetches metadata inline and calls setAssetsMetadata', async () => {
    const mockSetAssetsMetadata = jest.fn();
    const { setTokensBaseMetadata } = jest.requireMock('../../miden/front/assets');

    const mockAssets = [
      {
        faucetId: () => 'new-faucet',
        amount: () => ({ toString: () => '1000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    // Mock fetchTokenMetadata to return metadata for the new faucet
    mockFetchTokenMetadata.mockResolvedValueOnce({
      base: {
        decimals: 6,
        symbol: 'NEW',
        name: 'NEW',
        shouldPreferSymbol: true,
        thumbnailUri: '/misc/token-logos/default.svg'
      },
      detailed: {
        decimals: 6,
        symbol: 'NEW',
        name: 'NEW',
        shouldPreferSymbol: true,
        thumbnailUri: '/misc/token-logos/default.svg'
      }
    });

    await fetchBalances('my-address', {}, { setAssetsMetadata: mockSetAssetsMetadata });

    // Should call fetchTokenMetadata with the bech32 asset id
    expect(mockFetchTokenMetadata).toHaveBeenCalledWith('bech32-new-faucet');
    // Should call setAssetsMetadata with fetched metadata
    expect(mockSetAssetsMetadata).toHaveBeenCalledWith({
      'bech32-new-faucet': expect.objectContaining({
        symbol: 'NEW',
        decimals: 6
      })
    });
    // Should persist metadata
    expect(setTokensBaseMetadata).toHaveBeenCalled();
  });

  it('uses fetchTokenMetadata for metadata fetching (no importAccountById)', async () => {
    const mockSetAssetsMetadata = jest.fn();
    const mockAssets = [
      {
        faucetId: () => 'new-faucet',
        amount: () => ({ toString: () => '1000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    // Mock fetchTokenMetadata to return metadata (simulates RPC fetch)
    mockFetchTokenMetadata.mockResolvedValueOnce({
      base: {
        decimals: 8,
        symbol: 'FETCHED',
        name: 'FETCHED',
        shouldPreferSymbol: true,
        thumbnailUri: '/misc/token-logos/default.svg'
      },
      detailed: {
        decimals: 8,
        symbol: 'FETCHED',
        name: 'FETCHED',
        shouldPreferSymbol: true,
        thumbnailUri: '/misc/token-logos/default.svg'
      }
    });

    await fetchBalances('my-address', {}, { setAssetsMetadata: mockSetAssetsMetadata });

    // Should delegate metadata fetching to fetchTokenMetadata
    expect(mockFetchTokenMetadata).toHaveBeenCalledWith('bech32-new-faucet');
    // Should call setAssetsMetadata with fetched metadata
    expect(mockSetAssetsMetadata).toHaveBeenCalledWith({
      'bech32-new-faucet': expect.objectContaining({
        symbol: 'FETCHED',
        decimals: 8
      })
    });
  });

  it('falls back to DEFAULT_TOKEN_METADATA when fetchTokenMetadata throws', async () => {
    const mockSetAssetsMetadata = jest.fn();
    const { DEFAULT_TOKEN_METADATA } = jest.requireMock('lib/miden/metadata');
    const mockAssets = [
      {
        faucetId: () => 'bad-faucet',
        amount: () => ({ toString: () => '1000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    // fetchTokenMetadata throws — should not break balance loading
    mockFetchTokenMetadata.mockRejectedValueOnce(new Error('RPC error'));

    const result = await fetchBalances('my-address', {}, { setAssetsMetadata: mockSetAssetsMetadata });

    // Should still include the token with default metadata
    expect(mockSetAssetsMetadata).toHaveBeenCalledWith({
      'bech32-bad-faucet': DEFAULT_TOKEN_METADATA
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.tokenSlug).toBe('Unknown');
  });

  it('skips MIDEN token when fetching metadata', async () => {
    const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
    // Return miden-faucet-id for both the filter and the balance loop
    getBech32AddressFromAccountId.mockReturnValue('miden-faucet-id');

    const mockAssets = [
      {
        faucetId: () => 'raw-miden-faucet',
        amount: () => ({ toString: () => '100000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    await fetchBalances('my-address', {});

    // Should NOT call fetchTokenMetadata for the MIDEN token
    expect(mockFetchTokenMetadata).not.toHaveBeenCalled();

    // Reset mock to default behavior
    getBech32AddressFromAccountId.mockImplementation((id: string) => `bech32-${id}`);
  });

  it('reads from IndexedDB (getAccount) without calling syncState', async () => {
    const mockAssets = [
      {
        faucetId: () => 'raw-miden-faucet',
        amount: () => ({ toString: () => '100000000' })
      }
    ];

    mockGetAccount.mockResolvedValueOnce({
      vault: () => ({
        fungibleAssets: () => mockAssets
      })
    });

    const { getBech32AddressFromAccountId } = jest.requireMock('lib/miden/sdk/helpers');
    getBech32AddressFromAccountId.mockReturnValueOnce('miden-faucet-id');

    await fetchBalances('my-address', {});

    // Should read from IndexedDB
    expect(mockGetAccount).toHaveBeenCalledWith('my-address');
    // Should NOT call syncState - that happens separately via AutoSync
    expect(mockSyncState).not.toHaveBeenCalled();
  });
});
