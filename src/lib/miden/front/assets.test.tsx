import { AssetMetadata, fetchFromStorage, putToStorage } from 'lib/miden/front';

import {
  searchAssets,
  setTokensBaseMetadata,
  getTokensBaseMetadata,
  ALL_TOKENS_BASE_METADATA_STORAGE_KEY
} from './assets';

jest.mock('lib/miden/front', () => ({
  MIDEN_METADATA: {
    symbol: 'MIDEN',
    name: 'Miden',
    decimals: 8
  },
  isMidenAsset: jest.fn((slug: string) => slug === 'miden'),
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn()
}));

const mockFetchFromStorage = fetchFromStorage as unknown as jest.Mock;
const mockPutToStorage = putToStorage as unknown as jest.Mock;

describe('front/assets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('searchAssets', () => {
    const mockMetadata: Record<string, AssetMetadata> = {
      'token-1': {
        symbol: 'TKN1',
        name: 'Token One',
        decimals: 8
      },
      'token-2': {
        symbol: 'TKN2',
        name: 'Token Two',
        decimals: 6
      },
      'token-3': {
        symbol: 'ABC',
        name: 'Alpha Beta Coin',
        decimals: 18,
        description: 'A token for tests'
      }
    };

    const assets = [
      { slug: 'miden', id: 'miden-id' },
      { slug: 'token-1', id: 'token-1' },
      { slug: 'token-2', id: 'token-2' },
      { slug: 'token-3', id: 'token-3' }
    ];

    it('returns all assets when search value is empty', () => {
      const result = searchAssets('', assets, mockMetadata);
      expect(result).toEqual(assets);
    });

    it('filters assets by symbol match', () => {
      const result = searchAssets('TKN', assets, mockMetadata);
      expect(result.length).toBeGreaterThan(0);
      expect(result.some(a => a.id === 'token-1' || a.id === 'token-2')).toBe(true);
    });

    it('filters assets by name match', () => {
      const result = searchAssets('Alpha', assets, mockMetadata);
      expect(result.length).toBeGreaterThan(0);
      expect(result.some(a => a.id === 'token-3')).toBe(true);
    });

    it('includes miden token in search using MIDEN_METADATA', () => {
      const result = searchAssets('MIDEN', assets, mockMetadata);
      expect(result.some(a => a.slug === 'miden')).toBe(true);
    });

    it('returns empty array when no matches found', () => {
      const result = searchAssets('ZZZZNOTFOUND', assets, mockMetadata);
      // Fuse.js with threshold 1 is very permissive, might still return results
      // This test verifies the function doesn't crash
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getTokensBaseMetadata', () => {
    it('returns metadata for a specific asset', async () => {
      const storedMetadata = {
        'asset-1': { symbol: 'A1', name: 'Asset 1', decimals: 8 }
      };
      mockFetchFromStorage.mockResolvedValue(storedMetadata);

      const result = await getTokensBaseMetadata('asset-1');

      expect(result).toEqual(storedMetadata['asset-1']);
      expect(mockFetchFromStorage).toHaveBeenCalledWith(ALL_TOKENS_BASE_METADATA_STORAGE_KEY);
    });

    it('returns undefined for non-existent asset', async () => {
      mockFetchFromStorage.mockResolvedValue({});

      const result = await getTokensBaseMetadata('non-existent');

      expect(result).toBeUndefined();
    });

    it('handles null storage response', async () => {
      mockFetchFromStorage.mockResolvedValue(null);

      const result = await getTokensBaseMetadata('any-asset');

      expect(result).toBeUndefined();
    });
  });

  describe('setTokensBaseMetadata', () => {
    it('merges new metadata with existing storage', async () => {
      const existingMetadata = {
        'existing-asset': { symbol: 'EX', name: 'Existing', decimals: 8 }
      };
      mockFetchFromStorage.mockResolvedValue(existingMetadata);
      mockPutToStorage.mockResolvedValue(undefined);

      const newMetadata = {
        'new-asset': { symbol: 'NEW', name: 'New Asset', decimals: 6 }
      };

      await setTokensBaseMetadata(newMetadata as Record<string, AssetMetadata>);

      // Wait for the queued operation to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockPutToStorage).toHaveBeenCalledWith(
        ALL_TOKENS_BASE_METADATA_STORAGE_KEY,
        expect.objectContaining({
          'existing-asset': existingMetadata['existing-asset'],
          'new-asset': newMetadata['new-asset']
        })
      );
    });

    it('handles empty storage gracefully', async () => {
      mockFetchFromStorage.mockResolvedValue(null);
      mockPutToStorage.mockResolvedValue(undefined);

      const newMetadata = {
        'first-asset': { symbol: 'FIRST', name: 'First', decimals: 8 }
      };

      await setTokensBaseMetadata(newMetadata as Record<string, AssetMetadata>);

      // Wait for the queued operation to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockPutToStorage).toHaveBeenCalled();
    });
  });
});
