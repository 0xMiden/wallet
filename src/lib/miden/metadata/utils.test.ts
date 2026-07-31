import { getFaucetIdSetting, getTokensBaseMetadata } from '../front';
import { DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from './defaults';
import { AssetMetadata, DetailedAssetMetdata } from './types';
import { getAssetSymbol, getAssetName, toBaseMetadata, getTokenMetadata } from './utils';

jest.mock('../front', () => ({
  getFaucetIdSetting: jest.fn(),
  getTokensBaseMetadata: jest.fn()
}));

const mockGetFaucetIdSetting = getFaucetIdSetting as jest.Mock;
const mockGetTokensBaseMetadata = getTokensBaseMetadata as jest.Mock;

describe('metadata/utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAssetSymbol', () => {
    it('returns "???" for null metadata', () => {
      expect(getAssetSymbol(null)).toBe('???');
    });

    it('returns full symbol when short is false', () => {
      const metadata: AssetMetadata = {
        symbol: 'MIDEN',
        name: 'Miden Token',
        decimals: 8,
        shouldPreferSymbol: true
      };
      expect(getAssetSymbol(metadata)).toBe('MIDEN');
      expect(getAssetSymbol(metadata, false)).toBe('MIDEN');
    });

    it('returns "aleo" unchanged when short is true', () => {
      const metadata: AssetMetadata = {
        symbol: 'aleo',
        name: 'Aleo Token',
        decimals: 8,
        shouldPreferSymbol: true
      };
      expect(getAssetSymbol(metadata, true)).toBe('aleo');
    });

    it('truncates symbol to 5 chars when short is true', () => {
      const metadata: AssetMetadata = {
        symbol: 'LONGSYMBOL',
        name: 'Long Token',
        decimals: 8,
        shouldPreferSymbol: true
      };
      expect(getAssetSymbol(metadata, true)).toBe('LONGS');
    });

    it('returns short symbol unchanged if already <= 5 chars', () => {
      const metadata: AssetMetadata = {
        symbol: 'BTC',
        name: 'Bitcoin',
        decimals: 8,
        shouldPreferSymbol: true
      };
      expect(getAssetSymbol(metadata, true)).toBe('BTC');
    });
  });

  describe('getAssetName', () => {
    it('returns "Unknown Token" for null metadata', () => {
      expect(getAssetName(null)).toBe('Unknown Token');
    });

    it('returns symbol from metadata', () => {
      const metadata: AssetMetadata = {
        symbol: 'MIDEN',
        name: 'Miden Token',
        decimals: 8,
        shouldPreferSymbol: true
      };
      expect(getAssetName(metadata)).toBe('MIDEN');
    });
  });

  describe('toBaseMetadata', () => {
    it('extracts base metadata fields from detailed metadata', () => {
      const detailed: DetailedAssetMetdata = {
        symbol: 'MIDEN',
        name: 'Miden Token',
        decimals: 8,
        shouldPreferSymbol: true,
        thumbnailUri: 'https://example.com/thumb.png',
        displayUri: 'https://example.com/display.png',
        artifactUri: 'https://example.com/artifact.png'
      };

      const result = toBaseMetadata(detailed);

      expect(result).toEqual({
        symbol: 'MIDEN',
        name: 'Miden Token',
        decimals: 8,
        shouldPreferSymbol: true,
        thumbnailUri: 'https://example.com/thumb.png',
        displayUri: 'https://example.com/display.png',
        artifactUri: 'https://example.com/artifact.png'
      });
    });

    it('handles metadata without optional URI fields', () => {
      const metadata: AssetMetadata = {
        symbol: 'TEST',
        name: 'Test Token',
        decimals: 6,
        shouldPreferSymbol: false
      };

      const result = toBaseMetadata(metadata);

      expect(result).toEqual({
        symbol: 'TEST',
        name: 'Test Token',
        decimals: 6,
        shouldPreferSymbol: false,
        thumbnailUri: undefined,
        displayUri: undefined,
        artifactUri: undefined
      });
    });
  });

  describe('getTokenMetadata', () => {
    const mockFaucetId = 'miden-faucet-123';

    beforeEach(() => {
      mockGetFaucetIdSetting.mockResolvedValue(mockFaucetId);
    });

    it('returns MIDEN_METADATA for null tokenId', async () => {
      const result = await getTokenMetadata(null);
      expect(result).toBe(MIDEN_METADATA);
    });

    it('returns MIDEN_METADATA when tokenId matches faucet setting', async () => {
      const result = await getTokenMetadata(mockFaucetId);
      expect(result).toBe(MIDEN_METADATA);
      expect(mockGetFaucetIdSetting).toHaveBeenCalled();
    });

    it('fetches and returns token metadata for other tokenIds', async () => {
      const customMetadata: AssetMetadata = {
        symbol: 'CUSTOM',
        name: 'Custom Token',
        decimals: 6,
        shouldPreferSymbol: true
      };
      mockGetTokensBaseMetadata.mockResolvedValue(customMetadata);

      const result = await getTokenMetadata('other-token-id');

      expect(result).toBe(customMetadata);
      expect(mockGetTokensBaseMetadata).toHaveBeenCalledWith('other-token-id');
    });

    it('returns DEFAULT_TOKEN_METADATA when token metadata lookup returns null', async () => {
      mockGetTokensBaseMetadata.mockResolvedValue(null);

      const result = await getTokenMetadata('unknown-token-id');

      expect(result).toBe(DEFAULT_TOKEN_METADATA);
    });
  });
});
