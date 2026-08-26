/**
 * zustandProvider + syncGuardianAccounts — the default provider exposes the
 * store API, and the syncGuardianAccounts driver pulls from it, skips non-
 * Guardian accounts, and swallows per-account errors so one bad account
 * can't block the whole sync cycle.
 */

import { WalletType } from 'screens/onboarding/types';

import { SELF_HEAL_AUTH_FAILURE_THRESHOLD } from './guardian-selfheal';
import {
  __resetGuardianSyncOutageForTest,
  GUARDIAN_SYNC_OUTAGE_THRESHOLD,
  isGuardianSyncOutage,
  subscribeGuardianSyncOutage,
  SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS,
  syncGuardianAccounts,
  zustandProvider
} from './guardian-sync';

const storeState: {
  accounts: Array<{ publicKey: string; type: WalletType; requiresHotKeyRotation?: boolean; hotPublicKey?: string }>;
  getPublicKeyForCommitment: jest.Mock;
  signWord: jest.Mock;
  persistNewHotKey: jest.Mock;
  swapHotKey: jest.Mock;
  setGuardianEndpoint: jest.Mock;
  checkGuardianDrift: jest.Mock;
  signTransaction: jest.Mock;
} = {
  accounts: [],
  getPublicKeyForCommitment: jest.fn(),
  signWord: jest.fn(),
  persistNewHotKey: jest.fn(),
  swapHotKey: jest.fn(),
  setGuardianEndpoint: jest.fn(),
  checkGuardianDrift: jest.fn(),
  signTransaction: jest.fn()
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
// `startBackgroundTransactionProcessing` comes from the same dynamic import: it is
// the off-extension driver for the row the hardening enqueues.
const mockEnsureGuardianProcedureThresholds = jest.fn();
const mockStartBackgroundTransactionProcessing = jest.fn();
jest.mock('lib/miden/transaction', () => ({
  ensureGuardianProcedureThresholds: (...args: unknown[]) => mockEnsureGuardianProcedureThresholds(...args),
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBackgroundTransactionProcessing(...args)
}));

// Platform gate for the off-extension driver above. Default: extension (the SW owns
// the FIFO loop there), flipped per test.
const mockIsExtension = jest.fn(() => true);
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: () => mockIsExtension()
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
    mockIsExtension.mockReturnValue(true);
    mockEnsureGuardianProcedureThresholds.mockResolvedValue(undefined);
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

  it('drives the queued hardening row off-extension, where the SW nudge is a no-op', async () => {
    // `ensureGuardianProcedureThresholds` only nudges via `requestSWTransactionProcessing()`,
    // which returns immediately when there is no extension service worker. Nothing else
    // starts the FIFO loop from this path, so without an explicit driver the
    // `update-procedure-threshold` row sits Queued for the rest of the session —
    // showing in Activity as a pending entry that never progresses, with the account
    // left un-hardened until the next app launch's OrphanedTransactionRecovery.
    mockIsExtension.mockReturnValue(false);
    mockEnsureGuardianProcedureThresholds.mockResolvedValue('hardening-tx-1');
    storeState.accounts = [{ publicKey: 'guardian-mobile', type: WalletType.Guardian, hotPublicKey: 'hot-mobile' }];
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    await syncGuardianAccounts();

    expect(mockStartBackgroundTransactionProcessing).toHaveBeenCalledTimes(1);
    expect(mockStartBackgroundTransactionProcessing).toHaveBeenCalledWith(
      storeState.signTransaction,
      false,
      zustandProvider
    );
  });

  it('does not start the background driver on the extension (the SW owns the loop)', async () => {
    mockIsExtension.mockReturnValue(true);
    mockEnsureGuardianProcedureThresholds.mockResolvedValue('hardening-tx-2');
    storeState.accounts = [{ publicKey: 'guardian-ext', type: WalletType.Guardian, hotPublicKey: 'hot-ext' }];
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    await syncGuardianAccounts();

    expect(mockStartBackgroundTransactionProcessing).not.toHaveBeenCalled();
  });

  it('does not start the background driver when the account was already hardened', async () => {
    // No row was enqueued, so there is nothing to drive.
    mockIsExtension.mockReturnValue(false);
    mockEnsureGuardianProcedureThresholds.mockResolvedValue(undefined);
    storeState.accounts = [{ publicKey: 'guardian-hardened', type: WalletType.Guardian, hotPublicKey: 'hot-hard' }];
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    await syncGuardianAccounts();

    expect(mockStartBackgroundTransactionProcessing).not.toHaveBeenCalled();
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

describe('syncGuardianAccounts — 429 back-off', () => {
  const rateLimited = (retryAfterSecs?: number) => ({ status: 429, meta: { retryAfterSecs } });

  beforeEach(() => {
    jest.clearAllMocks();
    storeState.accounts = [];
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
  });

  it('stops calling the guardian for the cooldown it asked for', async () => {
    const sync = jest.fn(async () => {
      throw rateLimited(45);
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });
    storeState.accounts = [
      { publicKey: 'acct-429', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(now);
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(1);

    // Inside the 45s the guardian named: not one further request.
    nowSpy.mockReturnValue(now + 44_000);
    await syncGuardianAccounts();
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(1);

    // Past it, syncing resumes.
    nowSpy.mockReturnValue(now + 46_000);
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('applies a floor when the guardian names no cooldown', async () => {
    const sync = jest.fn(async () => {
      throw rateLimited(undefined);
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });
    storeState.accounts = [
      { publicKey: 'acct-429-nofloor', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(now);
    await syncGuardianAccounts();

    nowSpy.mockReturnValue(now + SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS - 1_000);
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(now + SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS + 1_000);
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('never self-heals on a 429 — it is not an auth failure', async () => {
    const sync = jest.fn(async () => {
      throw rateLimited(1);
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });
    storeState.accounts = [
      { publicKey: 'acct-429-noheal', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');
    for (let i = 0; i <= SELF_HEAL_AUTH_FAILURE_THRESHOLD + 2; i++) {
      nowSpy.mockReturnValue(now + i * 60_000);
      await syncGuardianAccounts();
    }
    expect(mockReRegister).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe('syncGuardianAccounts — guardian-unreachable outage flag', () => {
  const guardianAccount = (publicKey: string) => ({ publicKey, type: WalletType.Guardian, hotPublicKey: 'hot' });

  beforeEach(() => {
    jest.clearAllMocks();
    __resetGuardianSyncOutageForTest();
    storeState.accounts = [];
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
    mockEnsureGuardianProcedureThresholds.mockResolvedValue(undefined);
  });

  const runSyncs = async (times: number) => {
    for (let i = 0; i < times; i++) await syncGuardianAccounts();
  };

  it('arms only after the threshold of consecutive server-down failures, and clears on the next success', async () => {
    const pk = 'outage-arm-clear';
    storeState.accounts = [guardianAccount(pk)] as never;
    const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD - 1);
    expect(isGuardianSyncOutage(pk)).toBe(false);

    await runSyncs(1);
    expect(isGuardianSyncOutage(pk)).toBe(true);

    sync.mockResolvedValue(undefined);
    await runSyncs(1);
    expect(isGuardianSyncOutage(pk)).toBe(false);
  });

  it('counts a 5xx response as the guardian being down', async () => {
    const pk = 'outage-5xx';
    storeState.accounts = [guardianAccount(pk)] as never;
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn().mockRejectedValue(Object.assign(new Error('internal server error'), { status: 500 }))
    });

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
    expect(isGuardianSyncOutage(pk)).toBe(true);
  });

  it('a 401 proves the server is up — it never arms the outage and clears an armed one', async () => {
    const pk = 'outage-401';
    storeState.accounts = [guardianAccount(pk)] as never;
    const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
    expect(isGuardianSyncOutage(pk)).toBe(true);

    sync.mockRejectedValue(Object.assign(new Error('nope'), { __authRejection: true }));
    await runSyncs(1);
    expect(isGuardianSyncOutage(pk)).toBe(false);
  });

  it('a local (non-server) failure resets the consecutive count so mixed errors never arm it', async () => {
    const pk = 'outage-mixed';
    storeState.accounts = [guardianAccount(pk)] as never;
    const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD - 1);
    sync.mockRejectedValue(new Error('recursive use of an object')); // local WASM failure
    await runSyncs(1);
    sync.mockRejectedValue(new Error('Failed to fetch'));
    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD - 1);
    expect(isGuardianSyncOutage(pk)).toBe(false);

    await runSyncs(1);
    expect(isGuardianSyncOutage(pk)).toBe(true);
  });

  it('notifies subscribers when the flag arms and when it clears', async () => {
    const pk = 'outage-subscribe';
    storeState.accounts = [guardianAccount(pk)] as never;
    const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    const listener = jest.fn();
    const unsubscribe = subscribeGuardianSyncOutage(listener);

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
    expect(listener).toHaveBeenCalledTimes(1);

    sync.mockResolvedValue(undefined);
    await runSyncs(1);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    sync.mockRejectedValue(new Error('Failed to fetch'));
    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
