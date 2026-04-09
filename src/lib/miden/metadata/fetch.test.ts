import { isMidenAsset } from 'lib/miden/assets';

import { MIDEN_METADATA, DEFAULT_TOKEN_METADATA } from './defaults';
import { fetchTokenMetadata, NotFoundTokenMetadata } from './fetch';

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
const mockFromAccount = jest.fn();

jest.mock('@miden-sdk/miden-sdk', () => ({
  RpcClient: function (..._args: unknown[]) {
    return mockRpcClient();
  },
  Address: {
    fromBech32: (...args: unknown[]) => mockFromBech32(...args)
  },
  BasicFungibleFaucetComponent: {
    fromAccount: (account: unknown) => mockFromAccount(account)
  }
}));

jest.mock('lib/miden-chain/constants', () => ({
  getRpcEndpoint: jest.fn(() => 'mock-endpoint')
}));

const mockIsMidenAsset = isMidenAsset as unknown as jest.Mock;

describe('metadata/fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccountDetails.mockReset();
    mockFromBech32.mockReset();
    mockFromAccount.mockReset();
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

    it('fetches metadata via RpcClient for non-miden assets', async () => {
      mockIsMidenAsset.mockReturnValue(false);

      const mockAccountId = 'account-id-123';
      mockFromBech32.mockReturnValue({ accountId: () => mockAccountId });

      const mockUnderlyingAccount = { id: 'underlying' };
      mockGetAccountDetails.mockResolvedValue({
        account: () => mockUnderlyingAccount,
        isPublic: () => true
      });

      mockFromAccount.mockReturnValue({
        decimals: () => 8,
        symbol: () => ({ toString: () => 'TEST' })
      });

      const result = await fetchTokenMetadata('test-asset-id');

      expect(mockFromBech32).toHaveBeenCalledWith('test-asset-id');
      expect(mockGetAccountDetails).toHaveBeenCalledWith(mockAccountId);
      expect(result.base).toEqual({
        decimals: 8,
        symbol: 'TEST',
        name: 'TEST',
        shouldPreferSymbol: true,
        thumbnailUri: 'chrome-extension://test-id/misc/token-logos/default.svg'
      });
      expect(result.detailed).toEqual(result.base);
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
    });

    it('returns DEFAULT_TOKEN_METADATA when RPC returns no underlying account (public, warns)', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockIsMidenAsset.mockReturnValue(false);
      mockFromBech32.mockReturnValue({ accountId: () => 'acc-id' });
      mockGetAccountDetails.mockResolvedValue({
        account: () => null,
        isPublic: () => true
      });

      const result = await fetchTokenMetadata('public-missing-asset-id');

      expect(result).toEqual({
        base: DEFAULT_TOKEN_METADATA,
        detailed: DEFAULT_TOKEN_METADATA
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
