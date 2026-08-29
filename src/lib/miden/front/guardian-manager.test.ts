/**
 * Coverage for getOrCreateMultisigService + isGuardianAccount + cache helpers.
 * Every external dependency (MultisigService, WASM client, storage) is stubbed
 * so these tests stay deterministic and don't touch real SDK/wasm.
 */

import { WalletType } from 'screens/onboarding/types';

// The real (dependency-free) poison module — guardian-manager reads the client
// generation from it, so a test can simulate a lock recovery by bumping it.
import {
  clearGuardianCache,
  clearGuardianServiceFor,
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from './guardian-manager';
import { bumpWasmClientGeneration } from '../sdk/wasm-client-poison';

const mockFetchFromStorage = jest.fn();
jest.mock('./storage', () => ({
  fetchFromStorage: (...args: unknown[]) => mockFetchFromStorage(...args)
}));

const mockGetSignerDetailsFromAccount = jest.fn();
jest.mock('../guardian/account', () => ({
  getSignerDetailsFromAccount: (...args: unknown[]) => mockGetSignerDetailsFromAccount(...args),
  // Mirror the real resolver: prefer the per-account endpoint, else the stored
  // global key (driven by mockFetchFromStorage), else the default.
  resolveGuardianEndpoint: async (acc: { guardianEndpoint?: string }) =>
    acc.guardianEndpoint ?? (await mockFetchFromStorage('guardian_url_setting')) ?? 'https://default.guardian.test'
}));

const mockGetAccount = jest.fn();
const mockGetMidenClient = jest.fn(async (..._args: unknown[]) => ({ getAccount: mockGetAccount }));
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
// A sentinel hold, so `assertWasmHoldCurrent` can be asserted on rather than merely
// tolerated: the guard's whole job is to run between the account read and every read
// derived from it, and a mock that dropped the argument could not tell whether it did.
const TEST_HOLD = { label: 'test-hold' };
const mockAssertWasmHoldCurrent = jest.fn();
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: (...args: unknown[]) => mockGetMidenClient(...args),
  withWasmClientLock: async <T>(fn: (hold: unknown) => Promise<T>) => fn(TEST_HOLD),
  assertWasmHoldCurrent: (...args: unknown[]) => mockAssertWasmHoldCurrent(...args)
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
      expect(mockMultisigServiceInit).toHaveBeenCalledWith(
        expect.anything(),
        `0x${HOT_PK}`,
        '0xabc',
        provider.signWord,
        // The resolved per-account endpoint is now passed through to init.
        'https://default.guardian.test',
        // As are the build's lock options — `init`'s hold is the one that parks.
        { label: 'guardian-service-build' }
      );
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

    it('uses the per-account guardianEndpoint over the global key (multi-account isolation)', async () => {
      // Two Guardian accounts on different operators must not collide: the one
      // carrying its own endpoint binds to it regardless of the global key.
      const service = { guardianEndpoint: 'https://per-account.guardian', tag: 'isolated' };
      mockMultisigServiceInit.mockResolvedValueOnce(service);
      const provider = makeProvider([{ ...guardianAccount, guardianEndpoint: 'https://per-account.guardian' }]);

      const result = await getOrCreateMultisigService(GUARDIAN_PK, provider);

      expect(result).toBe(service);
      expect(mockMultisigServiceInit).toHaveBeenCalledWith(
        expect.anything(),
        `0x${HOT_PK}`,
        '0xabc',
        provider.signWord,
        'https://per-account.guardian',
        // The build's lock options reach `init` too: its hold — the client build plus
        // the guardian `load()` — is the longer of the two the build takes, so leaving
        // it unlabelled and on the default backstop was what made `boundAtSyncCeiling`
        // not do what its docstring said.
        { label: 'guardian-service-build' }
      );
      // The per-account field short-circuits the global-key lookup.
      expect(mockFetchFromStorage).not.toHaveBeenCalled();
    });

    it('coalesces concurrent service initialization for the same account', async () => {
      const service = { guardianEndpoint: 'https://default.guardian.test', tag: 'shared' };
      let resolveInit!: (value: unknown) => void;
      mockMultisigServiceInit.mockReturnValueOnce(
        new Promise(resolve => {
          resolveInit = resolve;
        })
      );
      const provider = makeProvider([guardianAccount]);

      const first = getOrCreateMultisigService(GUARDIAN_PK, provider);
      const second = getOrCreateMultisigService(GUARDIAN_PK, provider);

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(provider.getAccounts).toHaveBeenCalledTimes(1);
      expect(mockMultisigServiceInit).toHaveBeenCalledTimes(1);

      resolveInit(service);
      await expect(Promise.all([first, second])).resolves.toEqual([service, service]);
    });

    // Issue #775: lock recovery replaces the WASM client under a cached service.
    // The service holds the SDK `Account` handle it was built from, so after a
    // recovery every call it makes throws — and the guardian sync would keep
    // using it every ~3s until a reload, turning a transparent recovery into a
    // permanently broken guardian account.
    it('rebuilds a cached service after a WASM lock recovery replaced the client', async () => {
      const stale = { guardianEndpoint: 'https://default.guardian.test', tag: 'pre-recovery' };
      const fresh = { guardianEndpoint: 'https://default.guardian.test', tag: 'post-recovery' };
      mockMultisigServiceInit.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
      const provider = makeProvider([guardianAccount]);

      expect(await getOrCreateMultisigService(GUARDIAN_PK, provider)).toBe(stale);

      bumpWasmClientGeneration();

      // Nothing about the endpoint or hot key drifted — only the client did.
      expect(await getOrCreateMultisigService(GUARDIAN_PK, provider)).toBe(fresh);
      expect(mockMultisigServiceInit).toHaveBeenCalledTimes(2);
    });

    it('does not cache a service whose client was replaced while it was initializing', async () => {
      const midInit = { guardianEndpoint: 'https://default.guardian.test', tag: 'built-on-dead-client' };
      const rebuilt = { guardianEndpoint: 'https://default.guardian.test', tag: 'rebuilt' };
      let resolveInit!: (value: unknown) => void;
      mockMultisigServiceInit
        .mockReturnValueOnce(
          new Promise(resolve => {
            resolveInit = resolve;
          })
        )
        .mockResolvedValueOnce(rebuilt);
      const provider = makeProvider([guardianAccount]);

      const inflight = getOrCreateMultisigService(GUARDIAN_PK, provider);
      await new Promise(resolve => setTimeout(resolve, 0));
      // Recovery lands while the init is still in flight, so the service it is
      // about to resolve is already bound to the dead client.
      bumpWasmClientGeneration();
      resolveInit(midInit);
      // Its own caller still gets it — and fails on its next WASM call, exactly
      // as every other in-flight user of that client does.
      expect(await inflight).toBe(midInit);

      expect(await getOrCreateMultisigService(GUARDIAN_PK, provider)).toBe(rebuilt);
    });

    it('does not coalesce a post-recovery caller onto an init started before the recovery', async () => {
      const preRecovery = { guardianEndpoint: 'https://default.guardian.test', tag: 'pre' };
      const postRecovery = { guardianEndpoint: 'https://default.guardian.test', tag: 'post' };
      let resolveFirst!: (value: unknown) => void;
      mockMultisigServiceInit
        .mockReturnValueOnce(
          new Promise(resolve => {
            resolveFirst = resolve;
          })
        )
        .mockResolvedValueOnce(postRecovery);
      const provider = makeProvider([guardianAccount]);

      const first = getOrCreateMultisigService(GUARDIAN_PK, provider);
      await new Promise(resolve => setTimeout(resolve, 0));
      bumpWasmClientGeneration();

      // The next guardian tick must start its own init rather than adopting the
      // one already building on the client that just died.
      const second = getOrCreateMultisigService(GUARDIAN_PK, provider);
      resolveFirst(preRecovery);

      expect(await first).toBe(preRecovery);
      expect(await second).toBe(postRecovery);
      expect(mockMultisigServiceInit).toHaveBeenCalledTimes(2);
    });

    it('throws when the account is not of type Guardian', async () => {
      const provider = makeProvider([onChainAccount]);

      await expect(getOrCreateMultisigService(OTHER_PK, provider)).rejects.toThrow('Account is not a Guardian account');
    });

    it('throws loudly when a Guardian account is missing its hot pubkey', async () => {
      // A Guardian record without hotPublicKey is a pre-migration/half-written
      // state — fail rather than silently bind to a missing signer.
      const { hotPublicKey, ...noHotKey } = guardianAccount;
      void hotPublicKey;
      const provider = makeProvider([noHotKey]);

      await expect(getOrCreateMultisigService(GUARDIAN_PK, provider)).rejects.toThrow('missing hotPublicKey');
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

    it('matches a dApp-supplied bare address against the stored composite publicKey', async () => {
      // Regression: dApp/adapter txs arrive with the bare bech32 address, but
      // WalletAccount.publicKey is a composite `<address>_<suffix>`. A raw `===`
      // missed → the Guardian account was misrouted through the non-guardian path
      // (no co-signature → on-chain AUTH_UNAUTHORIZED). Must resolve to guardian.
      const compositeGuardian = { ...guardianAccount, publicKey: 'mtst1qabc_qr7suffix' };
      const provider = makeProvider([compositeGuardian, onChainAccount]);

      await expect(isGuardianAccount('mtst1qabc', provider)).resolves.toBe(true);
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
