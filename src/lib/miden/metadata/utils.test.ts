import { getNativeAssetId, getNativeAssetMetadata } from 'lib/miden-chain/native-asset';

import { getFaucetIdSetting, getTokensBaseMetadata } from '../front';
import { DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from './defaults';
import { AssetMetadata } from './types';
import { getAssetSymbol, getAssetName, toBaseMetadata, getTokenMetadata } from './utils';

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(async () => 'miden-faucet-123'),
  getNativeAssetMetadata: jest.fn(async () => ({ symbol: 'MIDEN', decimals: 6 }))
}));

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
        decimals: 8
      };
      expect(getAssetSymbol(metadata)).toBe('MIDEN');
      expect(getAssetSymbol(metadata, false)).toBe('MIDEN');
    });

    it('returns "aleo" unchanged when short is true', () => {
      const metadata: AssetMetadata = {
        symbol: 'aleo',
        name: 'Aleo Token',
        decimals: 8
      };
      expect(getAssetSymbol(metadata, true)).toBe('aleo');
    });

    it('truncates symbol to 5 chars when short is true', () => {
      const metadata: AssetMetadata = {
        symbol: 'LONGSYMBOL',
        name: 'Long Token',
        decimals: 8
      };
      expect(getAssetSymbol(metadata, true)).toBe('LONGS');
    });

    it('returns short symbol unchanged if already <= 5 chars', () => {
      const metadata: AssetMetadata = {
        symbol: 'BTC',
        name: 'Bitcoin',
        decimals: 8
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
        decimals: 8
      };
      expect(getAssetName(metadata)).toBe('MIDEN');
    });
  });

  describe('toBaseMetadata', () => {
    it('keeps the faucet metadata fields and drops unknown ones', () => {
      const stored = {
        symbol: 'MIDEN',
        name: 'Miden Token',
        decimals: 8,
        description: 'The native token',
        thumbnailUri: 'https://example.com/thumb.png'
      };

      const result = toBaseMetadata(stored);

      expect(result).toStrictEqual({
        symbol: 'MIDEN',
        name: 'Miden Token',
        decimals: 8,
        description: 'The native token',
        scaleIsUnknown: undefined
      });
    });

    it('carries the unknown-scale marker, which must not be laundered off a copy', () => {
      expect(toBaseMetadata(DEFAULT_TOKEN_METADATA).scaleIsUnknown).toBe(true);
    });

    it('leaves the marker off metadata that reported its own decimals', () => {
      expect(toBaseMetadata({ symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }).scaleIsUnknown).toBeUndefined();
    });

    it('handles metadata without a description', () => {
      const metadata: AssetMetadata = {
        symbol: 'TEST',
        name: 'Test Token',
        decimals: 6
      };

      const result = toBaseMetadata(metadata);

      expect(result).toEqual({
        symbol: 'TEST',
        name: 'Test Token',
        decimals: 6
      });
      expect(result.description).toBeUndefined();
    });
  });

  describe('getTokenMetadata', () => {
    const mockFaucetId = 'miden-faucet-123';

    beforeEach(() => {
      mockGetFaucetIdSetting.mockResolvedValue(mockFaucetId);
    });

    it('returns MIDEN_METADATA for null tokenId', async () => {
      const result = await getTokenMetadata(null);
      expect(result).toEqual({ ...MIDEN_METADATA, scaleIsUnknown: false });
    });

    it('returns MIDEN_METADATA when tokenId matches faucet setting', async () => {
      const result = await getTokenMetadata(mockFaucetId);
      expect(result).toEqual({ ...MIDEN_METADATA, scaleIsUnknown: false });
      expect(getNativeAssetId).toHaveBeenCalled();
    });

    it('fetches and returns token metadata for other tokenIds', async () => {
      const customMetadata: AssetMetadata = {
        symbol: 'CUSTOM',
        name: 'Custom Token',
        decimals: 6
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

it('returns native USDCX metadata to dApp callers without assuming six decimals', async () => {
  jest.mocked(getNativeAssetMetadata).mockResolvedValueOnce({ symbol: 'USDCX', decimals: 8 });
  await expect(getTokenMetadata('miden-faucet-123')).resolves.toEqual(
    expect.objectContaining({ symbol: 'USDCX', name: 'USDCX', decimals: 8, scaleIsUnknown: false })
  );
});
