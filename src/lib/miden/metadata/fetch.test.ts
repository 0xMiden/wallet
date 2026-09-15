import { isMidenAsset } from 'lib/miden/assets';

import { MIDEN_METADATA, DEFAULT_TOKEN_METADATA } from './defaults';
import { fetchTokenMetadata, NotFoundTokenMetadata } from './fetch';
import { AssetMetadata } from './types';

jest.mock('webextension-polyfill', () => ({
  runtime: {
    getURL: jest.fn((path: string) => `chrome-extension://test-id/${path}`)
  }
}));

jest.mock('lib/miden/assets', () => ({
  isMidenAsset: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true)
}));

// Mock @miden-sdk/miden-sdk: RpcClient, Endpoint, Address, BasicFungibleFaucetComponent
const mockGetAccountDetails = jest.fn();
const mockRpcClient = jest.fn(() => ({
  getAccountDetails: mockGetAccountDetails
}));
const mockFromBech32 = jest.fn();
const mockFromAccountStorage = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  RpcClient: function (..._args: unknown[]) {
    return mockRpcClient();
  },
  Address: {
    fromBech32: (...args: unknown[]) => mockFromBech32(...args)
  },
  BasicFungibleFaucetComponent: {
    fromAccountStorage: (storage: unknown) => mockFromAccountStorage(storage)
  }
}));

jest.mock('lib/miden-chain/constants', () => ({
  getRpcEndpoint: jest.fn(() => 'mock-endpoint'),
  ensureSdkWasmReady: jest.fn(() => Promise.resolve())
}));

const mockFetchFromStorage = jest.fn();
const mockPutToStorage = jest.fn();
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args),
  putToStorage: (...args: unknown[]) => mockPutToStorage(...args)
}));

const mockIsMidenAsset = isMidenAsset as unknown as jest.Mock;

describe('metadata/fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccountDetails.mockReset();
    mockFromBech32.mockReset();
    mockFromAccountStorage.mockReset();
    mockFetchFromStorage.mockResolvedValue(null);
    mockPutToStorage.mockResolvedValue(undefined);
  });

  describe('fetchTokenMetadata', () => {
    it('returns MIDEN_METADATA for miden asset', async () => {
      mockIsMidenAsset.mockReturnValue(true);

      const result = await fetchTokenMetadata('miden');

      expect(result).toEqual({
        base: MIDEN_METADATA,
        detailed: MIDEN_METADATA
      });
      // Should not call any RPC methods for miden asset
      expect(mockGetAccountDetails).not.toHaveBeenCalled();
    });

    it('returns cached metadata when available in storage', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      const cachedMeta = { decimals: 6, symbol: 'CACHED', name: 'Cached', thumbnailUri: '' };
      mockFetchFromStorage.mockResolvedValueOnce({ 'cached-asset': cachedMeta });

      const result = await fetchTokenMetadata('cached-asset');

      expect(result).toEqual({ base: cachedMeta, detailed: cachedMeta });
      expect(mockGetAccountDetails).not.toHaveBeenCalled();
    });

    it('fetches metadata via RpcClient for non-miden assets', async () => {
      mockIsMidenAsset.mockReturnValue(false);

      const mockAccountId = 'account-id-123';
      mockFromBech32.mockReturnValue({ accountId: () => mockAccountId });

      const mockStorage = { slots: [] };
      const mockUnderlyingAccount = { storage: () => mockStorage };
      mockGetAccountDetails.mockResolvedValue({
        account: () => mockUnderlyingAccount,
        isPublic: () => true
      });

      mockFromAccountStorage.mockReturnValue({
        decimals: () => 8,
        symbol: () => ({ toString: () => 'TEST' })
      });

      const result = await fetchTokenMetadata('test-asset-id');

      expect(mockFromBech32).toHaveBeenCalledWith('test-asset-id');
      expect(mockGetAccountDetails).toHaveBeenCalledWith(mockAccountId);
      expect(mockFromAccountStorage).toHaveBeenCalledWith(mockStorage);
      expect(result.base).toEqual({
        decimals: 8,
        symbol: 'TEST',
        name: 'TEST',
        shouldPreferSymbol: true,
        thumbnailUri: 'chrome-extension://test-id/misc/token-logos/default.svg',
        // The faucet answered, so the scale is a fact — and saying so is what
        // stops the placeholder shape test from mistaking a token that happens
        // to look like the placeholder for one.
        scaleIsUnknown: false
      });
      expect(result.detailed).toEqual(result.base);
    });

    it('persists RPC metadata so later fetches use the existing storage cache', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      const storedMetadata: Record<string, AssetMetadata> = {};
      mockFetchFromStorage.mockImplementation(async () => storedMetadata);
      mockPutToStorage.mockImplementation(async (_key: string, value: Record<string, AssetMetadata>) => {
        Object.assign(storedMetadata, value);
      });
      mockFromBech32.mockReturnValue({ accountId: () => 'account-id-123' });
      mockGetAccountDetails.mockResolvedValue({
        account: () => ({ storage: () => ({ slots: [] }) }),
        isPublic: () => true
      });
      mockFromAccountStorage.mockReturnValue({
        decimals: () => 8,
        symbol: () => ({ toString: () => 'TEST' })
      });

      const first = await fetchTokenMetadata('test-asset-id');
      const second = await fetchTokenMetadata('test-asset-id');

      expect(second).toEqual(first);
      expect(mockGetAccountDetails).toHaveBeenCalledTimes(1);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'test-asset-id': first.base
      });
    });

    it('serializes concurrent metadata writes so neither asset is lost', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      let storedMetadata: Record<string, AssetMetadata> = {};
      mockFetchFromStorage.mockImplementation(async () => storedMetadata);
      mockPutToStorage.mockImplementation(async (_key: string, value: Record<string, AssetMetadata>) => {
        storedMetadata = value;
      });
      mockFromBech32.mockImplementation((assetId: string) => ({ accountId: () => assetId }));
      mockGetAccountDetails.mockImplementation(async (accountId: string) => ({
        account: () => ({ storage: () => accountId }),
        isPublic: () => true
      }));
      mockFromAccountStorage.mockImplementation((accountId: string) => ({
        decimals: () => 8,
        symbol: () => ({ toString: () => accountId.toUpperCase() })
      }));

      const [assetA, assetB] = await Promise.all([fetchTokenMetadata('asset-a'), fetchTokenMetadata('asset-b')]);

      expect(mockPutToStorage).toHaveBeenCalledTimes(2);
      expect(storedMetadata).toEqual({
        'asset-a': assetA.base,
        'asset-b': assetB.base
      });
    });

    it('returns fetched metadata when persisting it fails', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => 'account-id-123' });
      mockGetAccountDetails.mockResolvedValue({
        account: () => ({ storage: () => ({ slots: [] }) }),
        isPublic: () => true
      });
      mockFromAccountStorage.mockReturnValue({
        decimals: () => 8,
        symbol: () => ({ toString: () => 'TEST' })
      });
      mockPutToStorage.mockRejectedValue(new Error('storage unavailable'));

      await expect(fetchTokenMetadata('test-asset-id')).resolves.toMatchObject({
        base: { decimals: 8, symbol: 'TEST', name: 'TEST' }
      });
    });

    it('returns DEFAULT_TOKEN_METADATA when faucet introspection throws (pre-0.15 faucet)', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => 'acc-id' });
      mockGetAccountDetails.mockResolvedValue({
        account: () => ({ storage: () => ({ slots: [] }) }),
        isPublic: () => true
      });
      mockFromAccountStorage.mockImplementation(() => {
        throw new Error('metadata slot unreadable');
      });

      const result = await fetchTokenMetadata('old-faucet-asset-id');

      expect(result).toEqual({
        base: DEFAULT_TOKEN_METADATA,
        detailed: DEFAULT_TOKEN_METADATA
      });
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'old-faucet-asset-id': DEFAULT_TOKEN_METADATA
      });
      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });

    it('returns DEFAULT_TOKEN_METADATA when RPC returns no underlying account (private)', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => 'acc-id' });
      mockGetAccountDetails.mockResolvedValue({
        account: () => null,
        isPublic: () => false
      });

      const result = await fetchTokenMetadata('private-asset-id');

      expect(result).toEqual({
        base: DEFAULT_TOKEN_METADATA,
        detailed: DEFAULT_TOKEN_METADATA
      });
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'private-asset-id': DEFAULT_TOKEN_METADATA
      });
    });

    it('does not cache a transient missing public account and retries on the next fetch', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      const storedMetadata: Record<string, AssetMetadata> = {};
      mockFetchFromStorage.mockImplementation(async () => storedMetadata);
      mockPutToStorage.mockImplementation(async (_key: string, value: Record<string, AssetMetadata>) => {
        Object.assign(storedMetadata, value);
      });
      mockFromBech32.mockReturnValue({ accountId: () => 'acc-id' });
      mockGetAccountDetails
        .mockResolvedValueOnce({
          account: () => null,
          isPublic: () => true
        })
        .mockResolvedValueOnce({
          account: () => ({ storage: () => ({ slots: [] }) }),
          isPublic: () => true
        });
      mockFromAccountStorage.mockReturnValue({
        decimals: () => 8,
        symbol: () => ({ toString: () => 'TEST' })
      });

      const first = await fetchTokenMetadata('public-missing-asset-id');
      const second = await fetchTokenMetadata('public-missing-asset-id');

      expect(first).toEqual({
        base: DEFAULT_TOKEN_METADATA,
        detailed: DEFAULT_TOKEN_METADATA
      });
      expect(second.base).toMatchObject({ decimals: 8, symbol: 'TEST', name: 'TEST' });
      expect(mockGetAccountDetails).toHaveBeenCalledTimes(2);
      expect(mockPutToStorage).toHaveBeenCalledTimes(1);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'public-missing-asset-id': second.base
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to fetch metadata from chain for',
        'public-missing-asset-id',
        'Using default metadata'
      );
      consoleWarnSpy.mockRestore();
    });

    it('throws NotFoundTokenMetadata when RPC call fails', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => 'acc-id' });
      mockGetAccountDetails.mockRejectedValue(new Error('RPC error'));

      await expect(fetchTokenMetadata('rpc-fail-asset-id')).rejects.toThrow(NotFoundTokenMetadata);
      consoleErrorSpy.mockRestore();
    });

    it('throws NotFoundTokenMetadata on unexpected error', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      // Simulate an error that bypasses the inner try/catch (e.g. Address.fromBech32 throws)
      mockFromBech32.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      await expect(fetchTokenMetadata('bad-asset-id')).rejects.toThrow(NotFoundTokenMetadata);
      consoleErrorSpy.mockRestore();
    });
  });

  describe('NotFoundTokenMetadata', () => {
    it('has correct name and message', () => {
      const error = new NotFoundTokenMetadata();

      expect(error.name).toBe('NotFoundTokenMetadata');
      expect(error.message).toBe('Metadata for token not found');
      expect(error).toBeInstanceOf(Error);
    });
  });
});
