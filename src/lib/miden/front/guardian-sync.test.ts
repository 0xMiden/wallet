/**
 * zustandProvider + syncGuardianAccounts — the default provider exposes the
 * store API, and the syncGuardianAccounts driver pulls from it, skips non-
 * Guardian accounts, and swallows per-account errors so one bad account
 * can't block the whole sync cycle.
 */

import { GuardianRegistrationPreflightError } from 'lib/miden/guardian/direct-switch';
import { WalletType } from 'screens/onboarding/types';

import { SELF_HEAL_AUTH_FAILURE_THRESHOLD, SELF_HEAL_COOLDOWN_MS, SELF_HEAL_MAX_ATTEMPTS } from './guardian-selfheal';
import {
  __resetGuardianSyncOutageForTest,
  getGuardianLastSyncAt,
  GUARDIAN_SYNC_OUTAGE_THRESHOLD,
  isGuardianSyncOutage,
  isGuardianUnrepairable,
  MISSING_REGISTRATION_BACKOFF_MS,
  MISSING_REGISTRATION_MAX_ATTEMPTS,
  MISSING_REGISTRATION_PERSISTENCE_THRESHOLD,
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
// `getGuardianCommitmentFromAccount` reads a DIFFERENT slot — the guardian
// operator's key — which is how the missing-registration heal decides whether
// this device's account state describes the rotation it is about to register.
const mockGetSignerDetails = jest.fn();
const mockGetGuardianCommitmentFromAccount = jest.fn();
jest.mock('lib/miden/guardian/account', () => ({
  getSignerDetailsFromAccount: (...args: unknown[]) => mockGetSignerDetails(...args),
  getGuardianCommitmentFromAccount: (...args: unknown[]) => mockGetGuardianCommitmentFromAccount(...args)
}));

// One unauthenticated GET /pubkey: does the operator we are about to register on
// actually hold the guardian key the local account state names?
const mockCheckEndpointCommitment = jest.fn();
jest.mock('lib/miden/guardian/operator-map', () => ({
  checkEndpointCommitment: (...args: unknown[]) => mockCheckEndpointCommitment(...args)
}));
const mockCommitmentFromPublicKeyHex = jest.fn();
jest.mock('lib/secure-hot-key/commitment', () => ({
  ...jest.requireActual('lib/secure-hot-key/commitment'),
  commitmentFromPublicKeyHex: (...args: unknown[]) => mockCommitmentFromPublicKeyHex(...args)
}));

// `isGuardianUnreachableError` runs for real (the outage tests depend on its
// actual classification); only the registration WRITE is stubbed.
const mockFinalizeDirectGuardianSwitch = jest.fn();
jest.mock('lib/miden/guardian/direct-switch', () => ({
  ...jest.requireActual('lib/miden/guardian/direct-switch'),
  finalizeDirectGuardianSwitch: (...args: unknown[]) => mockFinalizeDirectGuardianSwitch(...args)
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

  // The ~3s tick fires this without awaiting it, and a guardian request has no
  // client-side deadline, so overlapping runs would each count the SAME shared
  // rejection toward the outage threshold and would each read the 429 cooldown
  // before any of them wrote it.
  it('coalesces an overlapping tick onto the in-flight run', async () => {
    storeState.accounts = [{ publicKey: 'coalesce-pk', type: WalletType.Guardian, hotPublicKey: 'hot' }] as never;
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    const first = syncGuardianAccounts();
    const second = syncGuardianAccounts();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(sync).toHaveBeenCalledTimes(1);

    // And the coalescing window closes with the run: the next tick syncs again.
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  // Resetting the module's state used to retire the MARKER while leaving the pass
  // running, so the retired pass's `finally` cleared the marker belonging to
  // whichever pass had started after it — and coalescing, which exists to stop
  // overlapping runs from miscounting a shared rejection, was off from then on.
  it('a mid-pass state reset does not let the retired run hand away a later run’s slot', async () => {
    storeState.accounts = [{ publicKey: 'retire-pk', type: WalletType.Guardian, hotPublicKey: 'hot' }] as never;
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    // Each pass parks in its own gate, so both are in flight at the same time
    // and the order in which they finish is this test's to choose.
    let releaseRetired = (): void => {};
    let releaseCurrent = (): void => {};
    const retiredGate = new Promise<void>(resolve => {
      releaseRetired = resolve;
    });
    const currentGate = new Promise<void>(resolve => {
      releaseCurrent = resolve;
    });
    storeState.checkGuardianDrift.mockImplementationOnce(() => retiredGate).mockImplementationOnce(() => currentGate);

    try {
      const retired = syncGuardianAccounts();
      __resetGuardianSyncOutageForTest();
      const current = syncGuardianAccounts();
      expect(current).not.toBe(retired);

      // The retired pass finishes while the current one is still running. Its
      // cleanup must leave the current pass's marker alone.
      releaseRetired();
      await retired;

      expect(syncGuardianAccounts()).toBe(current);

      releaseCurrent();
      await current;
    } finally {
      // Never leave a gate armed: a leftover `mockImplementationOnce` survives
      // `clearAllMocks`, and a later test picking one up would hang.
      releaseRetired();
      releaseCurrent();
      storeState.checkGuardianDrift.mockReset();
      storeState.checkGuardianDrift.mockResolvedValue(undefined);
    }
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

  it('does not re-register when the guardian state could not be read at all', async () => {
    // Without the guardian's copy the comparison below runs against this device's
    // own pre-rotation state, in which it is signer 0 by construction — so a
    // swallowed read failure does not weaken the guard, it inverts it, passing
    // exactly the rotated-out case the guard exists to catch.
    mockAdoptGuardianState.mockRejectedValue(new Error('guardian unreachable'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-unreadable', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    // Well past the attempt cap: a read this device never got through on is not a
    // finding about the account, so it must not spend the bounded budget either.
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS + 2; i++) {
      await syncGuardianAccounts();
    }

    expect(mockReRegister).not.toHaveBeenCalled();
    expect(mockGetSignerDetails).not.toHaveBeenCalled();
  });

  // The SDK refusing to import a guardian state that is NOT AHEAD of local is an
  // answer, not a failed look: a device that had been rotated out would be facing
  // a guardian holding the NEWER state. Refusing here would make the repair
  // unreachable in the one state it is for.
  it('proceeds when the guardian state is merely behind local, which is what the re-register repairs', async () => {
    mockAdoptGuardianState.mockRejectedValue(
      new Error('Refusing to overwrite local state: incoming nonce 3 is not greater than local nonce 4')
    );
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-behind', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();

    expect(mockReRegister).toHaveBeenCalledTimes(1);
  });

  // The other half of the fail-closed guard: this device failing to derive its OWN
  // commitment is just as much "I cannot show I am still the signer" as the chain
  // read failing, and must not buy the account-wide write either.
  it('does not re-register when this device cannot derive its own hot-key commitment', async () => {
    mockCommitmentFromPublicKeyHex.mockRejectedValue(new Error('key material unavailable'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-noderive', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();

    expect(mockReRegister).not.toHaveBeenCalled();
  });

  // A 401 clears the outage flag (the server answered) and stamps no sync, so once
  // the repair budget is spent nothing else in this module says the account is
  // stuck. That silence is what the guardian screen used to render as "Checking".
  it('reports the account as unrepairable once the re-register budget is spent', async () => {
    mockReRegister.mockRejectedValue(new Error('configure rejected'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-stuck', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    let now = 5_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    expect(isGuardianUnrepairable('acct-stuck')).toBe(false);
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      await syncGuardianAccounts();
      now += SELF_HEAL_COOLDOWN_MS;
    }

    expect(isGuardianUnrepairable('acct-stuck')).toBe(true);

    // And a sync that finally lands stands it back down.
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => undefined) });
    await syncGuardianAccounts();
    expect(isGuardianUnrepairable('acct-stuck')).toBe(false);

    nowSpy.mockRestore();
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

  // The budget exists to stop a re-register that demonstrably does not help. A
  // run that never reached the guardian has demonstrated nothing — and since the
  // budget is only reset by a successful sync, which the stale allowlist is what
  // prevents, charging those runs would disable the repair permanently after
  // three unlucky local reads.
  it('does not spend the bounded budget on runs that never reached the guardian', async () => {
    mockGetSignerDetails.mockRejectedValue(new Error('storage read failed'));
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-unreadable', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');
    // Enough refusals to blow a budget of SELF_HEAL_MAX_ATTEMPTS, each past the
    // cooldown so the decision gate itself is not what is holding them back.
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      nowSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }
    expect(mockReRegister).not.toHaveBeenCalled();

    // The read recovers: the repair must still be available.
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    nowSpy.mockReturnValue(start + 100 * (SELF_HEAL_COOLDOWN_MS + 1_000));
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  // The opposite booking for the opposite outcome: being rotated out is a
  // permanent answer, so it closes the budget instead of re-asking the guardian
  // for its state once a cooldown forever.
  it('closes the budget once it has established this device was rotated out', async () => {
    mockGetSignerDetails.mockResolvedValue({ commitment: '0xsomeotherdeviceshotkey' });
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-closed-budget', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      nowSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }

    expect(mockReRegister).not.toHaveBeenCalled();
    expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
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

  // Guardian Settings renders a "Last sync" row, and it used to read the store's
  // wallet-wide `lastSyncedAt` — which a healthy chain sync keeps refreshing
  // while the guardian is down, putting a seconds-old time beside the Offline
  // pill on the same screen. Only a COMPLETED guardian sync stamps this.
  describe('last-sync stamp', () => {
    it('stamps a completed sync and leaves it alone while syncs fail', async () => {
      const pk = 'stamp-pk';
      storeState.accounts = [guardianAccount(pk)] as never;
      const sync = jest.fn().mockResolvedValue(undefined);
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      expect(getGuardianLastSyncAt(pk)).toBeUndefined();

      jest.spyOn(Date, 'now').mockReturnValue(1_000);
      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toBe(1_000);

      // Every later failure — server down, and therefore the outage the pill
      // shows — must leave the stamp where the last success put it.
      jest.spyOn(Date, 'now').mockReturnValue(9_000);
      sync.mockRejectedValue(new Error('Failed to fetch'));
      await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
      expect(isGuardianSyncOutage(pk)).toBe(true);
      expect(getGuardianLastSyncAt(pk)).toBe(1_000);

      jest.spyOn(Date, 'now').mockRestore();
    });

    it('does not stamp on a 401 or a 429, which prove liveness but sync nothing', async () => {
      const pk = 'stamp-alive-only';
      storeState.accounts = [guardianAccount(pk)] as never;
      const sync = jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { __authRejection: true }));
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toBeUndefined();

      sync.mockRejectedValue(Object.assign(new Error('slow down'), { status: 429 }));
      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toBeUndefined();
    });

    it('keeps the stamp per account', async () => {
      storeState.accounts = [guardianAccount('stamp-a'), guardianAccount('stamp-b')] as never;
      mockGetOrCreateMultisigService.mockImplementation((pk: string) => ({
        sync: pk === 'stamp-a' ? jest.fn().mockResolvedValue(undefined) : jest.fn().mockRejectedValue(new Error('nope'))
      }));

      await runSyncs(1);

      expect(getGuardianLastSyncAt('stamp-a')).toEqual(expect.any(Number));
      expect(getGuardianLastSyncAt('stamp-b')).toBeUndefined();
    });

    it('notifies subscribers on each completed sync, so a mounted page can re-render', async () => {
      const pk = 'stamp-notify';
      storeState.accounts = [guardianAccount(pk)] as never;
      mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn().mockResolvedValue(undefined) });

      const listener = jest.fn();
      const unsubscribe = subscribeGuardianSyncOutage(listener);
      await runSyncs(2);
      unsubscribe();

      // One per sync — not two for the first (stand down the outage + stamp),
      // which would render the page twice for one event.
      expect(listener).toHaveBeenCalledTimes(2);
    });
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

  // Every signal in this module is a statement about one OPERATOR, and all of
  // them were keyed by account alone — so a rotation handed the new guardian the
  // old one's record. The stamp is the one the user sees: Guardian Settings reads
  // any stamp as "Online", so the outgoing operator's success made a brand-new
  // guardian that had never answered read as online.
  describe('a rotation drops the previous operator’s state', () => {
    const at = (publicKey: string, endpoint: string | undefined) => ({
      publicKey,
      type: WalletType.Guardian,
      hotPublicKey: 'hot',
      guardianEndpoint: endpoint
    });

    it('drops the old operator’s success stamp, so the new one is not reported Online untested', async () => {
      const pk = 'rotate-stamp';
      storeState.accounts = [at(pk, 'https://old.guardian.test')] as never;
      const sync = jest.fn().mockResolvedValue(undefined);
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toEqual(expect.any(Number));

      // Rotate, and make the new operator unreachable: nothing this tick can
      // substantiate a sync, so the row must read "never" rather than inheriting.
      storeState.accounts = [at(pk, 'https://new.guardian.test')] as never;
      sync.mockRejectedValue(new Error('Failed to fetch'));
      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toBeUndefined();
    });

    it('drops an armed outage and its count, so the new operator starts from zero', async () => {
      const pk = 'rotate-outage';
      storeState.accounts = [at(pk, 'https://old.guardian.test')] as never;
      const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
      expect(isGuardianSyncOutage(pk)).toBe(true);

      storeState.accounts = [at(pk, 'https://new.guardian.test')] as never;
      await runSyncs(1);
      // Armed flag gone AND the count with it: one failure against the new
      // operator must not re-arm what the old one's six earned.
      expect(isGuardianSyncOutage(pk)).toBe(false);

      await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD - 2);
      expect(isGuardianSyncOutage(pk)).toBe(false);
      await runSyncs(1);
      expect(isGuardianSyncOutage(pk)).toBe(true);
    });

    it('drops a 429 cooldown the previous operator asked for', async () => {
      const pk = 'rotate-429';
      storeState.accounts = [at(pk, 'https://old.guardian.test')] as never;
      const sync = jest.fn().mockRejectedValue(Object.assign(new Error('slow down'), { status: 429 }));
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      await runSyncs(1);
      mockGetOrCreateMultisigService.mockClear();
      // Still parked on the old operator's cooldown.
      await runSyncs(1);
      expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();

      storeState.accounts = [at(pk, 'https://new.guardian.test')] as never;
      sync.mockResolvedValue(undefined);
      await runSyncs(1);
      expect(mockGetOrCreateMultisigService).toHaveBeenCalled();
    });

    it('notifies subscribers when the rotation clears something they can see', async () => {
      const pk = 'rotate-notify';
      storeState.accounts = [at(pk, 'https://old.guardian.test')] as never;
      const sync = jest.fn().mockResolvedValue(undefined);
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });
      await runSyncs(1);

      const listener = jest.fn();
      const unsubscribe = subscribeGuardianSyncOutage(listener);
      storeState.accounts = [at(pk, 'https://new.guardian.test')] as never;
      sync.mockRejectedValue(new Error('Failed to fetch'));
      await runSyncs(1);
      unsubscribe();

      expect(listener).toHaveBeenCalled();
    });

    it('does not notify on the steady state, so the pill is not re-rendered every tick', async () => {
      const pk = 'rotate-quiet';
      storeState.accounts = [at(pk, 'https://same.guardian.test')] as never;
      mockGetOrCreateMultisigService.mockResolvedValue({
        // Below the outage threshold, so nothing observable changes on any tick.
        sync: jest.fn().mockRejectedValue(new Error('Failed to fetch'))
      });

      await runSyncs(1);
      const listener = jest.fn();
      const unsubscribe = subscribeGuardianSyncOutage(listener);
      await runSyncs(3);
      unsubscribe();

      expect(listener).not.toHaveBeenCalled();
    });

    it('treats losing the endpoint as a rotation too', async () => {
      const pk = 'rotate-cleared';
      storeState.accounts = [at(pk, 'https://old.guardian.test')] as never;
      const sync = jest.fn().mockResolvedValue(undefined);
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });
      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toEqual(expect.any(Number));

      storeState.accounts = [at(pk, undefined)] as never;
      sync.mockRejectedValue(new Error('Failed to fetch'));
      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toBeUndefined();
    });
  });
});

// Drift reconciliation used to sit inside the success block, after
// `service.sync()` — which made it unreachable in exactly the states it exists
// to repair. Building the service loads account state FROM the stored endpoint,
// so a wrong or stale endpoint is precisely what makes the call above it throw:
// the reconciler ran only when the pointer was already correct.
describe('syncGuardianAccounts — drift reconciliation runs regardless of the guardian round-trip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetGuardianSyncOutageForTest();
    storeState.accounts = [{ publicKey: 'drift-pk', type: WalletType.Guardian, hotPublicKey: 'hot' }] as never;
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
  });

  it('checks drift when the service cannot even be built from the stored endpoint', async () => {
    mockGetOrCreateMultisigService.mockRejectedValue(new Error('Failed to fetch'));

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();

    expect(storeState.checkGuardianDrift).toHaveBeenCalledWith('drift-pk');
  });

  it('checks drift when the guardian sync itself fails', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { __authRejection: true }))
    });

    await syncGuardianAccounts();

    expect(storeState.checkGuardianDrift).toHaveBeenCalledWith('drift-pk');
  });
});

// The recovery half of `registerFailed`: a rotation whose `update_guardian`
// committed but whose post-commit `/configure` did not land leaves the new
// operator holding no state for an account it IS the on-chain guardian of.
// Nothing is drifted, so the drift reconciler has nothing to fix, and every
// guardian-authenticated call fails — including the state load the 401 self-heal
// needs before it can re-register.
describe('syncGuardianAccounts — missing-registration self-heal', () => {
  const unknownAccountError = { code: 'account_not_found', message: 'no such account' };
  const endpoint = 'https://new.guardian.test';
  const account = {
    publicKey: 'unregistered-pk',
    type: WalletType.Guardian,
    hotPublicKey: 'hot',
    guardianEndpoint: endpoint
  };

  /** Drive enough ticks for the unknown-account verdict to count as persistent. */
  const runUntilPersistent = async () => {
    for (let i = 0; i < MISSING_REGISTRATION_PERSISTENCE_THRESHOLD; i++) await syncGuardianAccounts();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    __resetGuardianSyncOutageForTest();
    storeState.accounts = [account] as never;
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
    mockFinalizeDirectGuardianSwitch.mockResolvedValue(undefined);
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn().mockRejectedValue(unknownAccountError) });
    // Default happy state: the local account is post-rotation (it names the
    // operator's own guardian key) and this device is still its hot signer.
    mockGetAccount.mockResolvedValue({ __sdkAccount: true });
    mockGetGuardianCommitmentFromAccount.mockReturnValue('newguardiankey');
    mockCheckEndpointCommitment.mockResolvedValue('match');
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    mockCommitmentFromPublicKeyHex.mockResolvedValue('0xAABB');
  });

  // All four codes reach this branch: the operator uses them interchangeably for
  // "I cannot produce state for that account", and only `account_not_found` used
  // to be exercised — so the other three could have been dropped unnoticed.
  it.each(['account_not_found', 'state_not_found', 'account_data_unavailable', 'data_unavailable'])(
    'pushes a load-free registration once the %s verdict has persisted',
    async code => {
      mockGetOrCreateMultisigService.mockResolvedValue({
        sync: jest.fn().mockRejectedValue({ code, message: 'no state for that account' })
      });

      // `data_unavailable` is a server-side condition that can be transient, and
      // the repair rewrites the operator's authoritative copy of a private
      // account — so a single verdict must not be enough.
      for (let i = 0; i < MISSING_REGISTRATION_PERSISTENCE_THRESHOLD - 1; i++) await syncGuardianAccounts();
      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

      await syncGuardianAccounts();
      expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith('unregistered-pk', endpoint, zustandProvider);
      // The cached service was built against an operator that had no state; drop it
      // so the next tick builds one against the now-registered account.
      expect(mockClearGuardianServiceFor).toHaveBeenCalledWith('unregistered-pk');
    }
  );

  it('requires the verdicts to be consecutive — a 401 proves the operator knows the account', async () => {
    const sync = jest.fn().mockRejectedValue(unknownAccountError);
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await syncGuardianAccounts();
    await syncGuardianAccounts();
    sync.mockRejectedValue({ __authRejection: true, message: 'unauthorized' });
    await syncGuardianAccounts();

    sync.mockRejectedValue(unknownAccountError);
    for (let i = 0; i < MISSING_REGISTRATION_PERSISTENCE_THRESHOLD - 1; i++) await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);
  });

  it('does not register once this device is no longer the account\u2019s on-chain hot signer', async () => {
    // Rotated out to another device. `/configure` is account-wide, so pushing a
    // registration here would revoke the device that now owns the account.
    mockGetSignerDetails.mockResolvedValue({ commitment: '0xsomeotherdeviceshotkey' });

    await runUntilPersistent();
    await syncGuardianAccounts();

    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  // The guard above protects write AUTHORITY, so an unreadable commitment has to
  // refuse exactly like a mismatched one. Both reads used to be caught to
  // `undefined` and the comparison was gated on both being present, so a failure
  // on either side SKIPPED the check and fell through to the push — a rotated-out
  // device could then revoke the device that now owns the account, on the strength
  // of a read error.
  it('does not register when the on-chain hot-signer commitment cannot be read', async () => {
    mockGetSignerDetails.mockRejectedValue(new Error('signer slot unreadable'));

    await runUntilPersistent();
    await syncGuardianAccounts();

    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  it('does not register when this device\u2019s own hot-key commitment cannot be derived', async () => {
    mockCommitmentFromPublicKeyHex.mockRejectedValue(new Error('cannot derive commitment'));

    await runUntilPersistent();
    await syncGuardianAccounts();

    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  // F-059's rule: a REFUSED guard check stamps the backoff clock without spending
  // an attempt, so three transient read failures cannot burn the write budget the
  // recovery needs. The refusal above is on that same path, so once the reads
  // recover, the full budget is still there.
  it('spends no attempt on a refusal, so the push still lands once the reads recover', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mockGetSignerDetails.mockRejectedValue(new Error('signer slot unreadable'));

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

    // A refusal DID stamp the clock, so the same instant buys nothing…
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

    // …but the first backoff gap is the one an unspent budget gets, not a
    // doubled one, and the attempt is still available.
    nowSpy.mockReturnValue(1_000_000 + MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith('unregistered-pk', endpoint, zustandProvider);

    nowSpy.mockRestore();
  });

  // The state this device would POST becomes the operator's authoritative copy of
  // a PRIVATE account — nothing on chain carries it, and the drift reconciler
  // compares only the guardian KEY commitment, so a stale push is undetectable
  // afterwards. Register only when the operator confirms it holds the guardian
  // key the local state names.
  it.each(['mismatch', 'unreachable'])(
    'does not register when the operator answers %s for the guardian key the local state names',
    async verdict => {
      mockCheckEndpointCommitment.mockResolvedValue(verdict);

      await runUntilPersistent();
      await syncGuardianAccounts();

      expect(mockCheckEndpointCommitment).toHaveBeenCalledWith(endpoint, 'newguardiankey');
      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
      // A refusal stamps the same backoff clock as a push, so the probe behind it
      // does not run again on the next ~3s tick.
      expect(mockCheckEndpointCommitment).toHaveBeenCalledTimes(1);
    }
  );

  it('does not register when the local account names no guardian key at all', async () => {
    mockGetGuardianCommitmentFromAccount.mockReturnValue(undefined);

    await runUntilPersistent();

    expect(mockCheckEndpointCommitment).not.toHaveBeenCalled();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  it('does nothing when the local account is missing from the client', async () => {
    mockGetAccount.mockResolvedValue(null);

    await runUntilPersistent();

    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  // A failed push must not disarm the recovery: the successful sync that used to
  // be the only way to re-arm it is exactly what an unregistered account cannot
  // produce, so a lost race left the row `registerFailed` forever.
  it('retries a failed registration on a widening backoff, then stops at the cap', async () => {
    mockFinalizeDirectGuardianSwitch.mockRejectedValue(new Error('configure rejected'));
    const t0 = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);

    await expect(runUntilPersistent()).resolves.toBeUndefined();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(t0 + MISSING_REGISTRATION_BACKOFF_MS - 1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    const t1 = t0 + MISSING_REGISTRATION_BACKOFF_MS;
    nowSpy.mockReturnValue(t1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    // The gap doubles, so the second wait is twice the first.
    const t2 = t1 + 2 * MISSING_REGISTRATION_BACKOFF_MS;
    nowSpy.mockReturnValue(t2 - 1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(t2);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);

    // Capped: an operator that keeps refusing a registration it also says it
    // needs will not be resolved by further `/configure` calls.
    nowSpy.mockReturnValue(t2 + 100 * MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);

    nowSpy.mockRestore();
  });

  // The cooldown is measured from when an attempt SETTLED, not from when it
  // started. `finalizeDirectGuardianSwitch` carries eight 30s `/configure`
  // deadlines plus backoff, so an attempt can easily outlast its own gap — and
  // with a pre-attempt stamp, one that does is already "due" the instant it
  // returns. That spent the entire budget back-to-back, with no pause at all,
  // against an operator whose only fault was being slow.
  it('measures the gap from when the attempt finished, so a slow push still buys its cooldown', async () => {
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    // Each push takes four minutes — longer than both gaps in the schedule.
    const pushDurationMs = 4 * MISSING_REGISTRATION_BACKOFF_MS;
    mockFinalizeDirectGuardianSwitch.mockImplementation(async () => {
      now += pushDurationMs;
      throw new Error('configure rejected');
    });

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    // The next tick lands immediately after that four-minute push. Measured from
    // the START it would be overdue; measured from the finish it is not due yet.
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    now += MISSING_REGISTRATION_BACKOFF_MS;
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    // Same again for the doubled second gap.
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    now += 2 * MISSING_REGISTRATION_BACKOFF_MS;
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);

    nowSpy.mockRestore();
  });

  // A refusal that never reached the operator does not spend an attempt, but it
  // still has to stamp the clock from its own finish — the probe behind it is an
  // HTTP round trip, and an unstamped refusal re-runs it on every ~3s tick.
  it('stamps a refunded attempt from its finish too', async () => {
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockFinalizeDirectGuardianSwitch.mockImplementation(async () => {
      now += 4 * MISSING_REGISTRATION_BACKOFF_MS;
      throw new GuardianRegistrationPreflightError('account state read back incomplete');
    });

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    now += MISSING_REGISTRATION_BACKOFF_MS;
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  // The bounded budget exists because a `/configure` that throws may still have
  // landed. A failure raised BEFORE that call carries no such doubt, and the only
  // thing that refunds the budget — a successful registration — is precisely what
  // an incomplete local read prevents, so charging it would let three flaky reads
  // disable the repair for the rest of the session.
  it('does not spend the registration budget on failures that never reached the operator', async () => {
    mockFinalizeDirectGuardianSwitch.mockRejectedValue(
      new GuardianRegistrationPreflightError('account state read back incomplete')
    );
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    // Well past the cap a spent budget would have hit.
    for (let i = 0; i < MISSING_REGISTRATION_MAX_ATTEMPTS + 3; i++) {
      now += MISSING_REGISTRATION_BACKOFF_MS;
      await syncGuardianAccounts();
    }
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS + 4);

    // Still rate-limited, though — the refusal stamps the clock, so the 3s tick
    // behind it does not re-read every time.
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS + 4);

    // And once the read comes back complete, the repair still works.
    mockFinalizeDirectGuardianSwitch.mockResolvedValue(undefined);
    now += MISSING_REGISTRATION_BACKOFF_MS;
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS + 5);

    nowSpy.mockRestore();
  });

  // The budget is keyed by what the push would WRITE, so a second rotation in the
  // same session is not silently skipped by the first one's spent attempts.
  it('re-arms for a rotation to a different endpoint in the same session', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    // Same instant, so only the new key — not the backoff — can allow this push.
    storeState.accounts = [{ ...account, guardianEndpoint: 'https://second.guardian.test' }] as never;
    mockGetGuardianCommitmentFromAccount.mockReturnValue('secondguardiankey');
    await syncGuardianAccounts();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenNthCalledWith(
      2,
      'unregistered-pk',
      'https://second.guardian.test',
      zustandProvider
    );
    nowSpy.mockRestore();
  });

  it('re-arms when the same endpoint installs a new guardian key', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    mockGetGuardianCommitmentFromAccount.mockReturnValue('rotatedoperatorkey');
    await syncGuardianAccounts();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  // An operator that answers is not an outage, whatever it answers — arming the
  // banner here would tell the user to rotate away from an operator that is up.
  it('never arms the unreachable-guardian banner', async () => {
    for (let i = 0; i < GUARDIAN_SYNC_OUTAGE_THRESHOLD + 2; i++) await syncGuardianAccounts();

    expect(isGuardianSyncOutage('unregistered-pk')).toBe(false);
  });

  it('does nothing when the account has no stored endpoint to register against', async () => {
    storeState.accounts = [{ ...account, guardianEndpoint: undefined }] as never;

    await runUntilPersistent();

    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  it('a successful sync re-arms the budget, so a genuine later recurrence is repaired', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const sync = jest.fn().mockRejectedValue(unknownAccountError);
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    sync.mockResolvedValue(undefined);
    await syncGuardianAccounts();

    // Same instant and the same triple: only the successful sync's reset can let
    // this second push through.
    sync.mockRejectedValue(unknownAccountError);
    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });
});
