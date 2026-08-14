/**
 * zustandProvider + syncGuardianAccounts — the default provider exposes the
 * store API, and the syncGuardianAccounts driver pulls from it, skips non-
 * Guardian accounts, and swallows per-account errors so one bad account
 * can't block the whole sync cycle.
 */

import { WalletType } from 'screens/onboarding/types';

import { SELF_HEAL_AUTH_FAILURE_THRESHOLD } from './guardian-selfheal';
import { syncGuardianAccounts, zustandProvider } from './guardian-sync';

const storeState: {
  accounts: Array<{ publicKey: string; type: WalletType; requiresHotKeyRotation?: boolean; hotPublicKey?: string }>;
  getPublicKeyForCommitment: jest.Mock;
  signWord: jest.Mock;
  persistNewHotKey: jest.Mock;
  swapHotKey: jest.Mock;
  setGuardianEndpoint: jest.Mock;
  checkGuardianDrift: jest.Mock;
} = {
  accounts: [],
  getPublicKeyForCommitment: jest.fn(),
  signWord: jest.fn(),
  persistNewHotKey: jest.fn(),
  swapHotKey: jest.fn(),
  setGuardianEndpoint: jest.fn(),
  checkGuardianDrift: jest.fn()
};

jest.mock('lib/store', () => ({
  useWalletStore: {
    getState: () => storeState
  }
}));

const mockGetOrCreateMultisigService = jest.fn();
const mockClearGuardianServiceFor = jest.fn();
jest.mock('./guardian-manager', () => ({
  getOrCreateMultisigService: (...args: unknown[]) => mockGetOrCreateMultisigService(...args),
  clearGuardianServiceFor: (...args: unknown[]) => mockClearGuardianServiceFor(...args)
}));

// The self-heal hook dynamic-imports this; stub it so the sync test stays focused
// on sync behavior (the hardening itself is covered in the transactions suite).
const mockEnsureGuardianProcedureThresholds = jest.fn();
jest.mock('lib/miden/transaction', () => ({
  ensureGuardianProcedureThresholds: (...args: unknown[]) => mockEnsureGuardianProcedureThresholds(...args)
}));

// Cold-re-register self-heal dependencies. isGuardianAuthRejection is stubbed to
// treat an error tagged `__authRejection` as a 401 so tests can drive that path.
const mockReRegister = jest.fn();
// The self-heal pulls the guardian's own state before deciding whether to push.
const mockAdoptGuardianState = jest.fn();
const mockBuildColdMultisigService = jest.fn();
jest.mock('lib/miden/guardian', () => ({
  isGuardianAuthRejection: (err: unknown) => (err as { __authRejection?: boolean } | null)?.__authRejection === true,
  MultisigService: {
    buildColdMultisigService: (...args: unknown[]) => mockBuildColdMultisigService(...args)
  }
}));

// The "am I still this account's signer?" guard. `getSignerDetailsFromAccount`
// reads signer slot 0 (hot) off the on-chain account; `commitmentFromPublicKeyHex`
// turns the locally-stored hot PUBLIC KEY into the commitment that slot holds.
// `sameCommitment` is pure, so it runs for real.
const mockGetSignerDetails = jest.fn();
jest.mock('lib/miden/guardian/account', () => ({
  getSignerDetailsFromAccount: (...args: unknown[]) => mockGetSignerDetails(...args)
}));
const mockCommitmentFromPublicKeyHex = jest.fn();
jest.mock('lib/secure-hot-key/commitment', () => ({
  ...jest.requireActual('lib/secure-hot-key/commitment'),
  commitmentFromPublicKeyHex: (...args: unknown[]) => mockCommitmentFromPublicKeyHex(...args)
}));

const mockGetAccount = jest.fn();
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({ getAccount: (...a: unknown[]) => mockGetAccount(...a) }),
  withWasmClientLock: async (fn: () => Promise<unknown>) => fn()
}));

describe('zustandProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState.accounts = [];
    storeState.getPublicKeyForCommitment.mockResolvedValue('pk');
    storeState.signWord.mockResolvedValue('sig');
    storeState.persistNewHotKey.mockResolvedValue(undefined);
    storeState.swapHotKey.mockResolvedValue(undefined);
  });

  it('getAccounts returns the current store accounts', async () => {
    storeState.accounts = [
      { publicKey: 'a', type: WalletType.Guardian },
      { publicKey: 'b', type: WalletType.OnChain }
    ];
    await expect(zustandProvider.getAccounts()).resolves.toEqual(storeState.accounts);
  });

  it('getPublicKeyForCommitment delegates to the store', async () => {
    await zustandProvider.getPublicKeyForCommitment('commitment-x');
    expect(storeState.getPublicKeyForCommitment).toHaveBeenCalledWith('commitment-x');
  });

  it('signWord delegates to the store', async () => {
    await zustandProvider.signWord('pub', '0xhex');
    expect(storeState.signWord).toHaveBeenCalledWith('pub', '0xhex');
  });

  it('persistNewHotKey delegates to the store', async () => {
    // Optional on the interface; the assertion below fails if it's missing.
    await zustandProvider.persistNewHotKey?.('new-pub', 'new-ciphertext');
    expect(storeState.persistNewHotKey).toHaveBeenCalledWith('new-pub', 'new-ciphertext');
  });

  it('swapHotKey delegates to the store', async () => {
    await zustandProvider.swapHotKey?.('account-pub', 'new-hot-pub');
    expect(storeState.swapHotKey).toHaveBeenCalledWith('account-pub', 'new-hot-pub');
  });

  it('setGuardianEndpoint delegates to the store', () => {
    zustandProvider.setGuardianEndpoint?.('account-pub', 'https://guardian.example');
    expect(storeState.setGuardianEndpoint).toHaveBeenCalledWith('account-pub', 'https://guardian.example');
  });
});

describe('syncGuardianAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState.accounts = [];
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
  });

  it('is a no-op when no Guardian accounts are present', async () => {
    storeState.accounts = [{ publicKey: 'pub', type: WalletType.OnChain }];

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
  });

  it('calls service.sync for every Guardian account', async () => {
    storeState.accounts = [
      { publicKey: 'guardian-1', type: WalletType.Guardian, hotPublicKey: 'hot-1' },
      { publicKey: 'public-1', type: WalletType.OnChain },
      { publicKey: 'guardian-2', type: WalletType.Guardian, hotPublicKey: 'hot-2' }
    ];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(2);
    expect(mockGetOrCreateMultisigService).toHaveBeenNthCalledWith(1, 'guardian-1', zustandProvider);
    expect(mockGetOrCreateMultisigService).toHaveBeenNthCalledWith(2, 'guardian-2', zustandProvider);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('self-heals the update_guardian hardening once per account per session', async () => {
    storeState.accounts = [{ publicKey: 'guardian-heal', type: WalletType.Guardian, hotPublicKey: 'hot-heal' }];
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    await syncGuardianAccounts();
    await syncGuardianAccounts(); // second pass — the session guard suppresses a re-check

    expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledTimes(1);
    expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledWith('guardian-heal', undefined, zustandProvider);
  });

  it('continues syncing remaining accounts when one throws', async () => {
    storeState.accounts = [
      { publicKey: 'guardian-bad', type: WalletType.Guardian, hotPublicKey: 'hot-bad' },
      { publicKey: 'guardian-good', type: WalletType.Guardian, hotPublicKey: 'hot-good' }
    ];
    const goodSync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ sync: goodSync });

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();
    expect(goodSync).toHaveBeenCalledTimes(1);
  });

  it('skips Guardian accounts that still require hot-key rotation (post-recovery, pre-activation)', async () => {
    // Recovered accounts have requiresHotKeyRotation=true and no hotPublicKey
    // until the Activate Device Key banner runs the cold-signed update_signers
    // rotation. Sync would throw on the missing hotPublicKey gate inside
    // getOrCreateMultisigService — skip them upstream so AutoSync stays quiet.
    storeState.accounts = [
      { publicKey: 'guardian-pending', type: WalletType.Guardian, requiresHotKeyRotation: true },
      { publicKey: 'guardian-active', type: WalletType.Guardian, hotPublicKey: 'hot-active' }
    ];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledWith('guardian-active', zustandProvider);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('skips legacy Guardian accounts with no hot key (un-migrated / upgrade window)', async () => {
    // A pre-3-key Guardian record carries neither hotPublicKey nor the
    // requiresHotKeyRotation flag — e.g. right after a wallet upgrade and before
    // the forced re-unlock runs migrateLegacyGuardianAccounts. getOrCreateMultisigService
    // would throw "missing hotPublicKey" on it every cycle; skip it instead. The
    // account is recovered by migration → Activate Device Key banner, not here.
    storeState.accounts = [
      { publicKey: 'guardian-legacy', type: WalletType.Guardian }, // no hotPublicKey, no rotation flag
      { publicKey: 'guardian-active', type: WalletType.Guardian, hotPublicKey: 'hot-active' }
    ];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();

    // Only the active account is synced; the legacy one is skipped, no throw.
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledWith('guardian-active', zustandProvider);
  });

  it('checks guardian drift for each guardian account with a hot key', async () => {
    storeState.accounts = [
      { publicKey: 'pk1', type: WalletType.Guardian, hotPublicKey: 'h1' },
      { publicKey: 'pk2', type: WalletType.OnChain }
    ];
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    await syncGuardianAccounts();

    expect(storeState.checkGuardianDrift).toHaveBeenCalledWith('pk1');
    expect(storeState.checkGuardianDrift).not.toHaveBeenCalledWith('pk2');
  });

  it('survives a rejected checkGuardianDrift call (best-effort)', async () => {
    storeState.accounts = [{ publicKey: 'guardian-drift-fail', type: WalletType.Guardian, hotPublicKey: 'hot-1' }];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });
    storeState.checkGuardianDrift.mockRejectedValue(new Error('drift check failed'));

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();

    expect(storeState.checkGuardianDrift).toHaveBeenCalledWith('guardian-drift-fail');
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('syncGuardianAccounts — cold re-register self-heal', () => {
  const authError = { __authRejection: true, message: '401 session expired' };

  beforeEach(() => {
    mockBuildColdMultisigService.mockClear();
    mockReRegister.mockClear();
    mockGetAccount.mockClear();
    mockClearGuardianServiceFor.mockClear();
    mockAdoptGuardianState.mockClear();
    mockAdoptGuardianState.mockResolvedValue(undefined);
    mockBuildColdMultisigService.mockResolvedValue({
      reRegisterCurrentStateOnGuardian: mockReRegister,
      adoptGuardianStateOnce: mockAdoptGuardianState
    });
    mockGetAccount.mockResolvedValue({ __sdkAccount: true });
    mockReRegister.mockResolvedValue(undefined);
    // Default: this device IS still the account's on-chain hot signer.
    mockGetSignerDetails.mockClear();
    mockCommitmentFromPublicKeyHex.mockClear();
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    mockCommitmentFromPublicKeyHex.mockResolvedValue('0xAABB');
  });

  it('cold re-registers only after the 401 has persisted to the threshold', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-heal', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    // Below the threshold: evicted every time, but no cold re-register yet.
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD - 1; i++) await syncGuardianAccounts();
    expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
    expect(mockClearGuardianServiceFor).toHaveBeenCalledWith('acct-heal');

    // The threshold-th consecutive 401 triggers the cold re-register.
    await syncGuardianAccounts();
    expect(mockBuildColdMultisigService).toHaveBeenCalledTimes(1);
    expect(mockReRegister).toHaveBeenCalledTimes(1);
  });

  it('does not re-register once this device is no longer the on-chain hot signer', async () => {
    // The account was recovered onto ANOTHER device, which rotated the hot key
    // to itself. `/configure` is account-wide, so re-registering here would
    // revoke the device that now legitimately owns the account — and that device
    // would heal right back, livelocking both (a successful sync in between
    // clears selfHealState, so the attempt cap never accumulates).
    mockGetSignerDetails.mockResolvedValue({ commitment: '0xsomeotherdeviceshotkey' });
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-rotated-away', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + 2; i++) await syncGuardianAccounts();

    // The cold service IS built and IS used to read: the guardian holds the only
    // current copy of a private account's state, so this device cannot tell it was
    // rotated out without asking. What must not happen is the WRITE.
    expect(mockAdoptGuardianState).toHaveBeenCalled();
    expect(mockReRegister).not.toHaveBeenCalled();
  });

  it('still re-registers when the on-chain hot signer is this device (0x/case differences aside)', async () => {
    mockGetSignerDetails.mockResolvedValue({ commitment: 'AABB' });
    mockCommitmentFromPublicKeyHex.mockResolvedValue('0xaabb');
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-still-mine', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();

    expect(mockReRegister).toHaveBeenCalledTimes(1);
  });

  it('does not self-heal on a non-auth (network) error', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw new Error('network');
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-net', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + 1; i++) await syncGuardianAccounts();
    expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
  });

  it('skips the cold re-register when the account has no cold key', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [{ publicKey: 'acct-nocold', type: WalletType.Guardian, hotPublicKey: 'hot' }] as never;
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();
    expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
  });

  it('returns before building the cold service when the account is missing locally', async () => {
    mockGetAccount.mockResolvedValue(null);
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-missing', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();
    expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
  });

  it('swallows a re-register failure so the sync loop stays alive', async () => {
    mockReRegister.mockRejectedValue(new Error('/configure down'));
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-cfgdown', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();
    expect(mockBuildColdMultisigService).toHaveBeenCalledTimes(1);
    expect(mockReRegister).toHaveBeenCalledTimes(1);
  });
});
