/**
 * Coverage for getOrCreateMultisigService + isGuardianAccount + cache helpers.
 * Every external dependency (MultisigService, WASM client, storage) is stubbed
 * so these tests stay deterministic and don't touch real SDK/wasm.
 */

import { WalletType } from 'screens/onboarding/types';

import {
  clearGuardianCache,
  clearGuardianServiceFor,
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from './guardian-manager';

const mockFetchFromStorage = jest.fn();
jest.mock('./storage', () => ({
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args)
}));

const mockGetSignerDetailsFromAccount = jest.fn();
jest.mock('../guardian/account', () => ({
  getSignerDetailsFromAccount: (...args: unknown[]) => mockGetSignerDetailsFromAccount(...args)
}));

const mockGetAccount = jest.fn();
const mockGetMidenClient = jest.fn(async (..._args: unknown[]) => ({ getAccount: mockGetAccount }));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: (...args: unknown[]) => mockGetMidenClient(...args),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn()
}));

const mockMultisigServiceInit = jest.fn();
jest.mock('lib/miden/guardian', () => ({
  MultisigService: {
    init: (...args: unknown[]) => mockMultisigServiceInit(...args)
  }
}));

jest.mock('lib/miden-chain/constants', () => ({
  DEFAULT_GUARDIAN_ENDPOINT: 'https://default.guardian.test'
}));

jest.mock('lib/settings/constants', () => ({
  GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting'
}));

const GUARDIAN_PK = 'guardian-pk';
const OTHER_PK = 'other-pk';
const HOT_PK = 'hot-pk-hex';

const guardianAccount = {
  publicKey: GUARDIAN_PK,
  type: WalletType.Guardian,
  name: 'Guardian',
  hdIndex: 0,
  // Phase 4: WalletAccount carries the hot pubkey directly; getOrCreateMultisigService
  // reads it and throws if missing.
  hotPublicKey: HOT_PK
};
const onChainAccount = { publicKey: OTHER_PK, type: WalletType.OnChain, name: 'Public', hdIndex: 1 };

const makeProvider = (accounts: unknown[]): GuardianAccountProvider => ({
  getAccounts: jest.fn(async () => accounts as never),
  getPublicKeyForCommitment: jest.fn(async () => 'pk-for-commitment'),
  signWord: jest.fn(async () => 'signature')
});

describe('guardian-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearGuardianCache();
    mockFetchFromStorage.mockResolvedValue('https://default.guardian.test');
    mockGetSignerDetailsFromAccount.mockResolvedValue({ commitment: 'abc' });
    mockGetAccount.mockResolvedValue({ id: () => ({ toString: () => 'acc-id' }) });
  });

  describe('getOrCreateMultisigService', () => {
    it('creates, caches, and returns a MultisigService for a Guardian account', async () => {
      const service = { guardianEndpoint: 'https://default.guardian.test', tag: 'first' };
      mockMultisigServiceInit.mockResolvedValueOnce(service);
      const provider = makeProvider([guardianAccount]);

      const result = await getOrCreateMultisigService(GUARDIAN_PK, provider);

      expect(result).toBe(service);
      // The publicKey arg comes from WalletAccount.hotPublicKey (not from
      // getSignerDetailsFromAccount anymore), prefixed with `0x`.
      expect(mockMultisigServiceInit).toHaveBeenCalledWith(expect.anything(), `0x${HOT_PK}`, '0xabc', provider.signWord);
      // Second call for the same account returns the cached instance without
      // re-initializing the service.
      mockMultisigServiceInit.mockClear();
      const second = await getOrCreateMultisigService(GUARDIAN_PK, provider);
      expect(second).toBe(service);
      expect(mockMultisigServiceInit).not.toHaveBeenCalled();
    });

    it('falls back to DEFAULT_GUARDIAN_ENDPOINT when storage is empty on the cache-drift re-check', async () => {
      // First call seeds the cache with a service pinned to the default endpoint.
      const service = { guardianEndpoint: 'https://default.guardian.test', tag: 'cached' };
      mockMultisigServiceInit.mockResolvedValueOnce(service);
      const provider = makeProvider([guardianAccount]);
      await getOrCreateMultisigService(GUARDIAN_PK, provider);

      // Second call: storage returns `undefined`, so the re-check computes the
      // default endpoint via the `|| DEFAULT_GUARDIAN_ENDPOINT` fallback and
      // the cached instance stays valid.
      mockFetchFromStorage.mockResolvedValueOnce(undefined);
      mockMultisigServiceInit.mockClear();

      const second = await getOrCreateMultisigService(GUARDIAN_PK, provider);

      expect(second).toBe(service);
      expect(mockMultisigServiceInit).not.toHaveBeenCalled();
    });

    it('evicts the cached service and reinitializes when the stored guardian URL drifts', async () => {
      const firstService = { guardianEndpoint: 'https://default.guardian.test', tag: 'first' };
      const secondService = { guardianEndpoint: 'https://new.guardian.test', tag: 'second' };
      mockMultisigServiceInit.mockResolvedValueOnce(firstService).mockResolvedValueOnce(secondService);
      const provider = makeProvider([guardianAccount]);

      await getOrCreateMultisigService(GUARDIAN_PK, provider);
      // User switched guardian — storage now returns a new URL.
      mockFetchFromStorage.mockResolvedValueOnce('https://new.guardian.test');

      const result = await getOrCreateMultisigService(GUARDIAN_PK, provider);

      expect(result).toBe(secondService);
      expect(mockMultisigServiceInit).toHaveBeenCalledTimes(2);
    });

    it('throws when the account is not of type Guardian', async () => {
      const provider = makeProvider([onChainAccount]);

      await expect(getOrCreateMultisigService(OTHER_PK, provider)).rejects.toThrow('Account is not a Guardian account');
    });

    it('throws when the public key is unknown to the provider', async () => {
      const provider = makeProvider([guardianAccount]);

      await expect(getOrCreateMultisigService('missing-pk', provider)).rejects.toThrow(
        'Account is not a Guardian account'
      );
    });

    it('throws when the SDK has no record of the account', async () => {
      mockGetAccount.mockResolvedValueOnce(null);
      const provider = makeProvider([guardianAccount]);

      await expect(getOrCreateMultisigService(GUARDIAN_PK, provider)).rejects.toThrow(
        'Account not found in local storage'
      );
    });
  });

  describe('isGuardianAccount', () => {
    it('returns true for a Guardian-typed account', async () => {
      const provider = makeProvider([guardianAccount, onChainAccount]);

      await expect(isGuardianAccount(GUARDIAN_PK, provider)).resolves.toBe(true);
    });

    it('returns false for a non-Guardian account', async () => {
      const provider = makeProvider([guardianAccount, onChainAccount]);

      await expect(isGuardianAccount(OTHER_PK, provider)).resolves.toBe(false);
    });

    it('returns false for an unknown public key', async () => {
      const provider = makeProvider([guardianAccount]);

      await expect(isGuardianAccount('ghost', provider)).resolves.toBe(false);
    });
  });

  describe('cache helpers', () => {
    it('clearGuardianServiceFor drops only the matching entry', async () => {
      const svcA = { guardianEndpoint: 'https://default.guardian.test', id: 'A' };
      const svcB = { guardianEndpoint: 'https://default.guardian.test', id: 'B' };
      mockMultisigServiceInit.mockResolvedValueOnce(svcA).mockResolvedValueOnce(svcB);
      const providerA = makeProvider([{ ...guardianAccount, publicKey: 'A' }]);
      const providerB = makeProvider([{ ...guardianAccount, publicKey: 'B' }]);

      await getOrCreateMultisigService('A', providerA);
      await getOrCreateMultisigService('B', providerB);

      clearGuardianServiceFor('A');

      // B is still cached; A must reinitialize.
      mockMultisigServiceInit.mockClear();
      await getOrCreateMultisigService('B', providerB);
      expect(mockMultisigServiceInit).not.toHaveBeenCalled();

      mockMultisigServiceInit.mockResolvedValueOnce({ guardianEndpoint: 'https://default.guardian.test', id: 'A2' });
      await getOrCreateMultisigService('A', providerA);
      expect(mockMultisigServiceInit).toHaveBeenCalledTimes(1);
    });

    it('clearGuardianCache wipes every entry', async () => {
      mockMultisigServiceInit
        .mockResolvedValueOnce({ guardianEndpoint: 'https://default.guardian.test' })
        .mockResolvedValueOnce({ guardianEndpoint: 'https://default.guardian.test' });
      const providerA = makeProvider([{ ...guardianAccount, publicKey: 'A' }]);
      const providerB = makeProvider([{ ...guardianAccount, publicKey: 'B' }]);

      await getOrCreateMultisigService('A', providerA);
      await getOrCreateMultisigService('B', providerB);

      clearGuardianCache();

      mockMultisigServiceInit.mockClear();
      mockMultisigServiceInit
        .mockResolvedValueOnce({ guardianEndpoint: 'https://default.guardian.test' })
        .mockResolvedValueOnce({ guardianEndpoint: 'https://default.guardian.test' });

      await getOrCreateMultisigService('A', providerA);
      await getOrCreateMultisigService('B', providerB);
      expect(mockMultisigServiceInit).toHaveBeenCalledTimes(2);
    });
  });
});
