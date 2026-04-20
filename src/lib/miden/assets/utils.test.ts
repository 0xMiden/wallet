import BigNumber from 'bignumber.js';

import { getNativeAssetId } from 'lib/miden-chain/native-asset';
import { fetchFromStorage } from 'lib/miden/front';

import { FAUCET_ID_STORAGE_KEY } from './constants';
import {
  toTransferParams,
  toTokenSlug,
  isFA2Token,
  isMidenAsset,
  isTokenAsset,
  getFaucetIdSetting,
  setFaucetIdSetting,
  getTokenId,
  isMidenFaucet
} from './utils';

jest.mock('lib/miden/front', () => ({
  fetchFromStorage: jest.fn(),
  searchAssets: jest.fn(),
  useAllTokensBaseMetadata: jest.fn()
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn()
}));

const mockFetchFromStorage = fetchFromStorage as jest.Mock;
const mockGetNativeAssetId = getNativeAssetId as jest.Mock;

describe('assets/utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  describe('toTokenSlug', () => {
    it('returns "aleo" for aleo contract', () => {
      expect(toTokenSlug('aleo')).toBe('aleo');
      expect(toTokenSlug('aleo', 0)).toBe('aleo');
      expect(toTokenSlug('aleo', 123)).toBe('aleo');
    });

    it('returns contract_id format for other contracts', () => {
      expect(toTokenSlug('contract123')).toBe('contract123_0');
      expect(toTokenSlug('contract123', 0)).toBe('contract123_0');
      expect(toTokenSlug('contract123', 42)).toBe('contract123_42');
    });

    it('handles BigNumber values for id', () => {
      expect(toTokenSlug('contract', new BigNumber(100))).toBe('contract_100');
      expect(toTokenSlug('contract', '999')).toBe('contract_999');
    });
  });

  describe('isFA2Token', () => {
    it('returns true when token has id property', () => {
      const fa2Token = { contract: 'contract123', id: 42 };
      expect(isFA2Token(fa2Token as any)).toBe(true);
    });

    it('returns false when token has no id property', () => {
      const fa1Token = { contract: 'contract123' };
      expect(isFA2Token(fa1Token as any)).toBe(false);
    });

    it('returns true even for id of 0', () => {
      const fa2Token = { contract: 'contract123', id: 0 };
      expect(isFA2Token(fa2Token as any)).toBe(true);
    });
  });

  describe('isMidenAsset', () => {
    it('returns true for "miden" string', () => {
      expect(isMidenAsset('miden')).toBe(true);
    });

    it('returns false for other strings', () => {
      expect(isMidenAsset('other')).toBe(false);
      expect(isMidenAsset('MIDEN')).toBe(false);
      expect(isMidenAsset('')).toBe(false);
    });

    it('returns false for token objects', () => {
      expect(isMidenAsset({ contract: 'something' } as any)).toBe(false);
    });
  });

  describe('isTokenAsset', () => {
    it('returns false for "miden" string', () => {
      expect(isTokenAsset('miden')).toBe(false);
    });

    it('returns true for token objects', () => {
      expect(isTokenAsset({ contract: 'something' } as any)).toBe(true);
    });
  });

  describe('toTransferParams', () => {
    it('returns transfer params for miden asset', async () => {
      const result = await toTransferParams('miden', 'recipient-key', 100);
      expect(result).toEqual({
        to: 'recipient-key',
        amount: 100
      });
    });

    it('returns placeholder for non-miden assets', async () => {
      const result = await toTransferParams('other-asset', 'recipient-key', 100);
      expect(result).toEqual({
        to: 'not a public key',
        amount: 420
      });
    });
  });

  describe('getFaucetIdSetting', () => {
    it('returns stored faucet id override when set', async () => {
      mockFetchFromStorage.mockResolvedValue('stored-faucet-id');

      const result = await getFaucetIdSetting();

      expect(result).toBe('stored-faucet-id');
      expect(mockFetchFromStorage).toHaveBeenCalledWith(FAUCET_ID_STORAGE_KEY);
      expect(mockGetNativeAssetId).not.toHaveBeenCalled();
    });

    it('falls through to discovered native asset id when no override', async () => {
      mockFetchFromStorage.mockResolvedValue(null);
      mockGetNativeAssetId.mockResolvedValue('discovered-native-id');

      const result = await getFaucetIdSetting();

      expect(result).toBe('discovered-native-id');
      expect(mockGetNativeAssetId).toHaveBeenCalled();
    });

    it('returns null when discovery fails (no hardcoded fallback)', async () => {
      mockFetchFromStorage.mockResolvedValue(null);
      mockGetNativeAssetId.mockRejectedValue(new Error('RPC unreachable'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await getFaucetIdSetting();

      expect(result).toBeNull();
      warnSpy.mockRestore();
    });
  });

  describe('setFaucetIdSetting', () => {
    it('stores faucet id in localStorage', () => {
      setFaucetIdSetting('new-faucet-id');

      expect(localStorage.getItem(FAUCET_ID_STORAGE_KEY)).toBe('new-faucet-id');
    });
  });

  describe('getTokenId', () => {
    it('returns "MIDEN" for miden faucet', async () => {
      const midenFaucetId = 'mtst1aqmat9m63ctdsgz6xcyzpuprpulwk9vg_qruqqypuyph';
      mockFetchFromStorage.mockResolvedValue(midenFaucetId);

      const result = await getTokenId(midenFaucetId);

      expect(result).toBe('MIDEN');
    });

    it('returns "Unknown" for non-miden faucet', async () => {
      mockFetchFromStorage.mockResolvedValue('miden-faucet-id');

      const result = await getTokenId('other-faucet-id');

      expect(result).toBe('Unknown');
    });
  });

  describe('isMidenFaucet', () => {
    it('returns true when faucetId matches stored setting', async () => {
      mockFetchFromStorage.mockResolvedValue('my-faucet-id');

      const result = await isMidenFaucet('my-faucet-id');

      expect(result).toBe(true);
    });

    it('returns false when faucetId does not match', async () => {
      mockFetchFromStorage.mockResolvedValue('my-faucet-id');

      const result = await isMidenFaucet('other-faucet-id');

      expect(result).toBe(false);
    });
  });
});
