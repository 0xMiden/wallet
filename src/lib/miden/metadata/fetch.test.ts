import { isMidenAsset } from 'lib/miden/assets';
import {
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync,
  getVerificationBaseFee,
  resetNativeAssetCache
} from 'lib/miden-chain/native-asset';

import { DEFAULT_TOKEN_METADATA } from './defaults';
import { fetchTokenMetadata, NotFoundTokenMetadata } from './fetch';
import { getNativeDisplayMetadataSync } from './native';
import type { ensureTokensMetadataSchema } from './storage';
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
const mockGetBlockHeaderByNumber = jest.fn();
const mockRpcClient = jest.fn(() => ({
  getAccountDetails: mockGetAccountDetails,
  getBlockHeaderByNumber: mockGetBlockHeaderByNumber
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

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => 'rpc-bootstrap',
  getEffectiveNetworkName: () => 'devnet',
  getEffectiveFeeFaucetId: () => undefined
}));

jest.mock('lib/miden/front', () => ({}));

jest.mock('lib/miden/metadata', () => jest.requireActual('./fetch'));

const mockFetchFromStorage = jest.fn();
const mockPutToStorage = jest.fn();
jest.mock('lib/miden/front/storage', () => ({
  onStorageChanged: () => Object.assign(() => {}, { attached: Promise.resolve() }),
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args),
  putToStorage: (...args: unknown[]) => mockPutToStorage(...args)
}));

// The shape check has its own tests in storage.test.ts. Here it only must run before the cache read.
const mockEnsureTokensMetadataSchema = jest.fn();
jest.mock('./storage', () => ({
  ...jest.requireActual('./storage'),
  ensureTokensMetadataSchema: (...args: Parameters<typeof ensureTokensMetadataSchema>) =>
    mockEnsureTokensMetadataSchema(...args)
}));

const mockIsMidenAsset = isMidenAsset as unknown as jest.Mock;

/** A stand-in for `BasicFungibleFaucetComponent`. An empty name is what a faucet without a name returns. */
function faucetComponent(symbol: string, decimals: number, name = '', description?: string) {
  return {
    decimals: () => decimals,
    symbol: () => ({ toString: () => symbol }),
    tokenName: () => name,
    description: () => description
  };
}

describe('metadata/fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccountDetails.mockReset();
    mockFromBech32.mockReset();
    mockFromAccountStorage.mockReset();
    mockFetchFromStorage.mockResolvedValue(null);
    mockPutToStorage.mockResolvedValue(undefined);
    mockEnsureTokensMetadataSchema.mockReset().mockResolvedValue(undefined);
  });

  describe('fetchTokenMetadata', () => {
    it('returns provisional USDCX for the native asset alias', async () => {
      mockIsMidenAsset.mockReturnValue(true);

      const result = await fetchTokenMetadata('miden');

      expect(result).toEqual(expect.objectContaining({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: true }));
      // Should not call any RPC methods for miden asset
      expect(mockGetAccountDetails).not.toHaveBeenCalled();
    });

    it('returns cached metadata when available in storage', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      const cachedMeta = { decimals: 6, symbol: 'CACHED', name: 'Cached' };
      mockFetchFromStorage.mockResolvedValueOnce({ 'cached-asset': cachedMeta });

      const result = await fetchTokenMetadata('cached-asset');

      expect(result).toEqual(cachedMeta);
      expect(mockGetAccountDetails).not.toHaveBeenCalled();
    });

    it('runs the cache shape check before it reads the cache', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      const order: string[] = [];
      mockEnsureTokensMetadataSchema.mockImplementation(async () => {
        order.push('check');
      });
      mockFetchFromStorage.mockImplementation(async () => {
        order.push('read');
        return { 'cached-asset': { decimals: 6, symbol: 'CACHED', name: 'Cached' } };
      });

      await fetchTokenMetadata('cached-asset');

      expect(mockEnsureTokensMetadataSchema).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
      expect(order).toEqual(['check', 'read']);
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

      mockFromAccountStorage.mockReturnValue(faucetComponent('TEST', 8, 'Test Token', 'A token for tests'));

      const result = await fetchTokenMetadata('test-asset-id');

      expect(mockFromBech32).toHaveBeenCalledWith('test-asset-id');
      expect(mockGetAccountDetails).toHaveBeenCalledWith(mockAccountId);
      expect(mockFromAccountStorage).toHaveBeenCalledWith(mockStorage);
      expect(result).toEqual({
        decimals: 8,
        symbol: 'TEST',
        name: 'Test Token',
        description: 'A token for tests',
        // The faucet answered, so the scale is a fact — and saying so is what
        // stops the placeholder shape test from mistaking a token that happens
        // to look like the placeholder for one.
        scaleIsUnknown: false
      });
    });

    it('uses the symbol as the name when the faucet name is empty', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => 'account-id-123' });
      mockGetAccountDetails.mockResolvedValue({
        account: () => ({ storage: () => ({ slots: [] }) }),
        isPublic: () => true
      });
      mockFromAccountStorage.mockReturnValue(faucetComponent('TEST', 8, ''));

      const result = await fetchTokenMetadata('test-asset-id');

      expect(result.name).toBe('TEST');
    });

    it.each([
      ['absent', undefined],
      ['empty', '']
    ])('leaves the description out when the faucet description is %s', async (_label, description) => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => 'account-id-123' });
      mockGetAccountDetails.mockResolvedValue({
        account: () => ({ storage: () => ({ slots: [] }) }),
        isPublic: () => true
      });
      mockFromAccountStorage.mockReturnValue(faucetComponent('TEST', 8, 'Test Token', description));

      const result = await fetchTokenMetadata('test-asset-id');

      expect(result).toStrictEqual({ decimals: 8, symbol: 'TEST', name: 'Test Token', scaleIsUnknown: false });
      expect('description' in result).toBe(false);
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
      mockFromAccountStorage.mockReturnValue(faucetComponent('TEST', 8));

      const first = await fetchTokenMetadata('test-asset-id');
      const second = await fetchTokenMetadata('test-asset-id');

      expect(second).toEqual(first);
      expect(mockGetAccountDetails).toHaveBeenCalledTimes(1);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'test-asset-id': first
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
      mockFromAccountStorage.mockImplementation((accountId: string) => faucetComponent(accountId.toUpperCase(), 8));

      const [assetA, assetB] = await Promise.all([fetchTokenMetadata('asset-a'), fetchTokenMetadata('asset-b')]);

      expect(mockPutToStorage).toHaveBeenCalledTimes(2);
      expect(storedMetadata).toEqual({
        'asset-a': assetA,
        'asset-b': assetB
      });
    });

    it('returns fetched metadata when persisting it fails', async () => {
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => 'account-id-123' });
      mockGetAccountDetails.mockResolvedValue({
        account: () => ({ storage: () => ({ slots: [] }) }),
        isPublic: () => true
      });
      mockFromAccountStorage.mockReturnValue(faucetComponent('TEST', 8));
      mockPutToStorage.mockRejectedValue(new Error('storage unavailable'));

      await expect(fetchTokenMetadata('test-asset-id')).resolves.toMatchObject({
        decimals: 8,
        symbol: 'TEST',
        name: 'TEST'
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

      expect(result).toEqual(DEFAULT_TOKEN_METADATA);
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

      expect(result).toEqual(DEFAULT_TOKEN_METADATA);
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
      mockFromAccountStorage.mockReturnValue(faucetComponent('TEST', 8));

      const first = await fetchTokenMetadata('public-missing-asset-id');
      const second = await fetchTokenMetadata('public-missing-asset-id');

      expect(first).toEqual(DEFAULT_TOKEN_METADATA);
      expect(second).toMatchObject({ decimals: 8, symbol: 'TEST', name: 'TEST' });
      expect(mockGetAccountDetails).toHaveBeenCalledTimes(2);
      expect(mockPutToStorage).toHaveBeenCalledTimes(1);
      expect(mockPutToStorage).toHaveBeenCalledWith('tokens_base_metadata', {
        'public-missing-asset-id': second
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

  describe('native bootstrap through actual metadata fetching', () => {
    const nativeId = 'native-A';
    const foreignId = 'foreign-B';
    const proofKey = 'native_asset_synced_id:v1:rpc-bootstrap|devnet';
    const nativeMetadataKey = 'native_asset_meta:v5:rpc-bootstrap|devnet';
    const foreignMetadata = { symbol: 'BRAND', name: 'Legacy branding', decimals: 4, scaleIsUnknown: false };
    let storage: Record<string, any>;

    beforeEach(async () => {
      storage = {};
      mockFetchFromStorage.mockImplementation(async (key: string) => storage[key] ?? null);
      mockPutToStorage.mockImplementation(async (key: string, value: unknown) => {
        storage[key] = value;
      });
      await resetNativeAssetCache();
      storage[proofKey] = nativeId;
      storage.tokens_base_metadata = { [foreignId]: foreignMetadata };
      mockIsMidenAsset.mockImplementation(jest.requireActual('lib/miden/assets/utils').isMidenAsset);
      mockFromBech32.mockImplementation((id: string) => ({ accountId: () => id }));
      mockGetAccountDetails.mockResolvedValue({
        account: () => ({ storage: () => ({}) }),
        isPublic: () => true
      });
      mockFromAccountStorage.mockReturnValue(faucetComponent('USDCX', 6));
      mockGetBlockHeaderByNumber.mockReset().mockResolvedValue({ verificationBaseFee: () => 7 });
    });

    afterEach(async () => {
      await resetNativeAssetCache();
    });

    it('preserves genuine chain MIDEN for the native alias', async () => {
      mockFromAccountStorage.mockReturnValue(faucetComponent('MIDEN', 6));
      await expect(getNativeAssetMetadata()).resolves.toEqual({ symbol: 'MIDEN', decimals: 6 });
      await expect(fetchTokenMetadata('miden')).resolves.toEqual(
        expect.objectContaining({ symbol: 'MIDEN', name: 'Miden', decimals: 6, scaleIsUnknown: false })
      );
    });

    it.each([false, true])(
      'reads native chain scale and preserves foreign cache, stale native cache=%s',
      async stale => {
        if (stale)
          storage.tokens_base_metadata[nativeId] = {
            symbol: 'USDCX',
            name: 'USDCX',
            decimals: 8,
            scaleIsUnknown: false
          };
        expect(isMidenAsset(nativeId)).toBe(false);
        await expect(fetchTokenMetadata(foreignId)).resolves.toEqual(foreignMetadata);
        const expectedCachedNative = stale
          ? { symbol: 'USDCX', name: 'USDCX', decimals: 8, scaleIsUnknown: false }
          : undefined;
        const cachedNative = stale ? await fetchTokenMetadata(nativeId) : undefined;
        expect(cachedNative).toEqual(expectedCachedNative);
        expect(mockGetAccountDetails).not.toHaveBeenCalled();

        await expect(getNativeAssetMetadata()).resolves.toEqual({ symbol: 'USDCX', decimals: 6 });
        expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'USDCX', decimals: 6 });
        await expect(fetchTokenMetadata('miden')).resolves.toEqual(
          expect.objectContaining({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: false })
        );
        expect(getSdkSyncedNativeAssetIdSync()).toBe(nativeId);
        expect(storage[nativeMetadataKey]).toEqual({ faucetId: nativeId, symbol: 'USDCX', decimals: 6 });
        expect(mockGetAccountDetails).toHaveBeenCalledTimes(1);
        expect(mockGetAccountDetails).toHaveBeenCalledWith(nativeId);
        expect(getNativeDisplayMetadataSync(undefined, nativeId)).toMatchObject({
          symbol: 'USDCX',
          decimals: 6,
          scaleIsUnknown: false
        });
        expect(getNativeDisplayMetadataSync(foreignMetadata, foreignId)).toEqual(foreignMetadata);
        expect(storage.tokens_base_metadata[foreignId]).toEqual(foreignMetadata);
        await expect(fetchTokenMetadata(foreignId)).resolves.toEqual(foreignMetadata);
        expect(mockGetAccountDetails).toHaveBeenCalledTimes(1);
        await expect(getVerificationBaseFee()).resolves.toBe(7);
        expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(1);
      }
    );

    it.each(['RPC rejection', 'unknown chain scale'])(
      'does not promote stale generic native metadata after %s',
      async failure => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
          storage.tokens_base_metadata[nativeId] = {
            symbol: 'USDCX',
            name: 'USDCX',
            decimals: 8,
            scaleIsUnknown: false
          };
          if (failure === 'RPC rejection') mockGetAccountDetails.mockRejectedValue(new Error('RPC unavailable'));
          else
            mockFromAccountStorage.mockImplementation(() => {
              throw new Error('Unknown faucet interface');
            });
          await expect(getNativeAssetMetadata()).resolves.toBeNull();
          expect(getNativeAssetMetadataSync()).toBeNull();
          expect(storage[nativeMetadataKey]).toBeNull();
          expect(getSdkSyncedNativeAssetIdSync()).toBe(nativeId);
          expect(mockGetAccountDetails).toHaveBeenCalledWith(nativeId);
          expect(storage.tokens_base_metadata[foreignId]).toEqual(foreignMetadata);
        } finally {
          warn.mockRestore();
          error.mockRestore();
        }
      }
    );
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
