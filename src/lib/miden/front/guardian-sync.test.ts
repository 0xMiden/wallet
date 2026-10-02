/**
 * zustandProvider + syncGuardianAccounts — the default provider exposes the
 * store API, and the syncGuardianAccounts driver pulls from it, skips non-
 * Guardian accounts, and swallows per-account errors so one bad account
 * can't block the whole sync cycle.
 */

import { GuardianRegistrationPreflightError } from 'lib/miden/guardian/direct-switch';
import { WASM_LOCK_SYNC_WATCHDOG_MS, WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import {
  FUSED_SYNC_PROBE_INTERVAL_MS,
  MAX_CONSECUTIVE_WATCHDOG_EVICTIONS,
  monotonicNowMs
} from 'lib/miden/sync-backoff';
import { isExtension } from 'lib/platform';
import { WalletType } from 'screens/onboarding/types';

import { SELF_HEAL_AUTH_FAILURE_THRESHOLD, SELF_HEAL_COOLDOWN_MS, SELF_HEAL_MAX_ATTEMPTS } from './guardian-selfheal';
import {
  __resetGuardianSyncOutageForTest,
  getGuardianLastSyncAt,
  GUARDIAN_SYNC_OUTAGE_THRESHOLD,
  GUARDIAN_SYNC_STAMP_FRESH_MS,
  isGuardianSyncOutage,
  isGuardianUnrepairable,
  MISSING_REGISTRATION_BACKOFF_MS,
  MISSING_REGISTRATION_MAX_ATTEMPTS,
  MISSING_REGISTRATION_PERSISTENCE_THRESHOLD,
  subscribeGuardianSyncOutage,
  SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS,
  SYNC_RATE_LIMIT_MAX_COOLDOWN_MS,
  syncGuardianAccounts,
  zustandProvider
} from './guardian-sync';
import {
  clearSyncFuseForEndpointChange,
  guardianAdoptFuseKey,
  guardianSelfHealFuseKey,
  guardianSyncFuseKey,
  __resetSyncFuseStateForTests,
  isSyncFused,
  noteSyncParked,
  syncFuseUntilMs
} from './sync-fuse';

const storeState: {
  accounts: Array<{
    publicKey: string;
    type: WalletType;
    requiresHotKeyRotation?: boolean;
    hotPublicKey?: string;
    guardianEndpoint?: string;
  }>;
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
// the FIFO loop there), flipped per test. The mock is made inside the factory:
// `zustandProvider` calls `isExtension()` when its module loads, which is before
// a top-level `const` in this file is initialized.
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: jest.fn(() => true)
}));
const mockIsExtension = jest.mocked(isExtension);

const mockRequestSWTransactionProcessing = jest.fn();
jest.mock('lib/miden/activity', () => ({
  requestSWTransactionProcessing: () => mockRequestSWTransactionProcessing()
}));

// Cold-re-register self-heal dependencies. isGuardianAuthRejection is stubbed to
// treat an error tagged `__authRejection` as a 401 so tests can drive that path.
const mockReRegister = jest.fn();
// The self-heal pulls the guardian's own state before deciding whether to push.
const mockAdoptGuardianState = jest.fn();
const mockBuildColdMultisigService = jest.fn();
const mockMultisigInit = jest.fn();
jest.mock('lib/miden/guardian', () => {
  // The `__authRejection` tag is a convenience for the tests below, but the REAL
  // classifier is kept in the chain: it is the gate that decides whether this
  // device may POST `/configure`, and stubbing it outright meant no test in this
  // suite exercised it — it could have been inverted and everything stayed
  // green. Delegating means a real `{ status: 401 }` drives the path too, which
  // one test below relies on. (A direct table for the classifier itself lives in
  // lib/miden/guardian/index.test.ts.)
  const actual: {
    isGuardianAuthRejection: (err: unknown) => boolean;
    isGuardianReRegisterRefusal: (err: unknown) => boolean;
    GuardianReRegisterRefusedError: new (accountId: string, cause: unknown) => Error;
  } = jest.requireActual('lib/miden/guardian');
  return {
    isGuardianAuthRejection: (err: unknown) =>
      (err as { __authRejection?: boolean } | null)?.__authRejection === true || actual.isGuardianAuthRejection(err),
    isGuardianReRegisterRefusal: actual.isGuardianReRegisterRefusal,
    GuardianReRegisterRefusedError: actual.GuardianReRegisterRefusedError,
    MultisigService: {
      buildColdMultisigService: (...args: unknown[]) => mockBuildColdMultisigService(...args),
      init: (...args: unknown[]) => mockMultisigInit(...args)
    }
  };
});

// The "am I still this account's signer?" guard. `getSignerDetailsFromAccount`
// reads signer slot 0 (hot) off the on-chain account; `commitmentFromPublicKeyHex`
// turns the locally-stored hot PUBLIC KEY into the commitment that slot holds.
// `sameCommitment` is pure, so it runs for real.
// `getGuardianCommitmentFromAccount` reads a DIFFERENT slot — the guardian
// operator's key — which is how the missing-registration heal decides whether
// this device's account state describes the rotation it is about to register.
const mockGetSignerDetails = jest.fn();
const mockGetGuardianCommitmentFromAccount = jest.fn();
// The operator the sync actually binds: the per-account field when set, otherwise
// the legacy global key and then the network default. The rotation detector keys
// on THIS rather than on the raw field, so the default has to be a stable value
// here — a per-call one would look like a rotation on every tick.
const resolveEndpointDefault = async (account: { guardianEndpoint?: string }) =>
  account.guardianEndpoint ?? 'https://guardian.test';
const mockResolveGuardianEndpoint = jest.fn(resolveEndpointDefault);
// The pointer the account CHOSE: field, then the legacy global key, and NEVER the
// network default. The self-heal writes this device's private account state to it,
// so an account with no pointer must resolve to `undefined` and be refused.
const resolveChosenDefault = async (account: { guardianEndpoint?: string }) => account.guardianEndpoint;
const mockResolveChosenGuardianEndpoint = jest.fn(resolveChosenDefault);
jest.mock('lib/miden/guardian/account', () => ({
  getSignerDetailsFromAccount: (...args: unknown[]) => mockGetSignerDetails(...args),
  getGuardianCommitmentFromAccount: (...args: unknown[]) => mockGetGuardianCommitmentFromAccount(...args),
  // The fuse key carries the endpoint, so the loop resolves it per account per lap.
  resolveGuardianEndpoint: (account: { guardianEndpoint?: string }) => mockResolveGuardianEndpoint(account),
  resolveChosenGuardianEndpoint: (account: { guardianEndpoint?: string }) => mockResolveChosenGuardianEndpoint(account)
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

// The switch rows a landed reconcile flagged (#1233), covered on their own in
// transaction/switch-guardian-residual.test.ts.
const mockFindUnsavedSwitchRow = jest.fn(
  async (_accountPublicKey: string, _endpoint: string): Promise<unknown> => undefined
);
const mockClearLocalStateNotSaved = jest.fn(async (_accountPublicKey: string, _endpoint: string) => {});
const mockMarkSwitchDeltaPushed = jest.fn(async (_rowId: string) => {});
jest.mock('lib/miden/transaction/switch-guardian-residual', () => ({
  findUnsavedSwitchRow: (accountPublicKey: string, endpoint: string) =>
    mockFindUnsavedSwitchRow(accountPublicKey, endpoint),
  clearLocalStateNotSaved: (accountPublicKey: string, endpoint: string) =>
    mockClearLocalStateNotSaved(accountPublicKey, endpoint),
  markSwitchDeltaPushed: (rowId: string) => mockMarkSwitchDeltaPushed(rowId)
}));

// This device's Failed rotations (#1233), covered on their own in
// transaction/hot-key-rotation-residual.test.ts. Default: none.
const mockFindFailedHotKeyRotations = jest.fn(
  async (_accountPublicKey: string): Promise<{ id: string; newHotPublicKey: string }[]> => []
);
const mockMarkRotationCompleted = jest.fn(async (_rowId: string) => {});
jest.mock('lib/miden/transaction/hot-key-rotation-residual', () => ({
  findFailedHotKeyRotations: (accountPublicKey: string) => mockFindFailedHotKeyRotations(accountPublicKey),
  markRotationCompleted: (rowId: string) => mockMarkRotationCompleted(rowId)
}));

const mockGetAccount = jest.fn();
// Pass-through by default; a case that models a contended mutex advances the clock before the callback.
const mockWithWasmClientLock = jest.fn(async (fn: () => Promise<unknown>, _options?: unknown) => fn());
// A no-op by default; a case loses the hold by making it throw.
const mockAssertWasmHoldCurrent = jest.fn((_hold: unknown, _where: string) => {});
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({ getAccount: (...a: unknown[]) => mockGetAccount(...a) }),
  withWasmClientLock: (fn: () => Promise<unknown>, options?: unknown) => mockWithWasmClientLock(fn, options),
  // This lock hands out no hold, so every re-check sees `undefined`.
  assertWasmHoldCurrent: (hold: unknown, where: string) => mockAssertWasmHoldCurrent(hold, where)
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
    expect(storeState.signWord).toHaveBeenCalledWith('pub', '0xhex', undefined);
  });

  it('passes the recovery transaction ID to the signing store', async () => {
    await zustandProvider.signWord('pub', '0xhex', 'recovery-tx');
    expect(storeState.signWord).toHaveBeenCalledWith('pub', '0xhex', 'recovery-tx');
  });

  it('persistNewHotKey delegates to the store', async () => {
    // Optional on the interface; the assertion below fails if it's missing.
    await zustandProvider.persistNewHotKey?.('new-pub', 'new-ciphertext');
    expect(storeState.persistNewHotKey).toHaveBeenCalledWith('new-pub', 'new-ciphertext');
  });

  it('swapHotKey delegates to the store', async () => {
    await zustandProvider.swapHotKey?.('account-pub', 'new-hot-pub');
    expect(storeState.swapHotKey).toHaveBeenCalledWith('account-pub', 'new-hot-pub', undefined);
  });

  it('swapHotKey passes the expectation to the store (#1233)', async () => {
    await zustandProvider.swapHotKey?.('account-pub', 'new-hot-pub', 'old-hot-pub');
    expect(storeState.swapHotKey).toHaveBeenCalledWith('account-pub', 'new-hot-pub', 'old-hot-pub');
  });

  it('setGuardianEndpoint delegates to the store', () => {
    zustandProvider.setGuardianEndpoint?.('account-pub', 'https://guardian.example');
    expect(storeState.setGuardianEndpoint).toHaveBeenCalledWith('account-pub', 'https://guardian.example');
  });
});

describe('syncGuardianAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetGuardianSyncOutageForTest();
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
    // The third argument bounds the account read at the sync ceiling for this caller and
    // this caller only — it is the one on a cadence (#777).
    expect(mockGetOrCreateMultisigService).toHaveBeenNthCalledWith(1, 'guardian-1', zustandProvider, true);
    expect(mockGetOrCreateMultisigService).toHaveBeenNthCalledWith(2, 'guardian-2', zustandProvider, true);
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

  it('runs the hardening self-heal again after the hot key rotates', async () => {
    // A rotation evicted before its own hardening leaves the repair to this check.
    storeState.accounts = [{ publicKey: 'guardian-heal', type: WalletType.Guardian, hotPublicKey: 'hot-heal' }];
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    await syncGuardianAccounts();
    await syncGuardianAccounts();
    expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledTimes(1);

    storeState.accounts[0]!.hotPublicKey = 'hot-rotated';
    await syncGuardianAccounts();

    expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledTimes(2);
    expect(mockEnsureGuardianProcedureThresholds).toHaveBeenLastCalledWith('guardian-heal', undefined, zustandProvider);
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

  it('feeds a watchdog eviction into the realm sync fuse, which the idle loop cannot see (#777)', async () => {
    // Guardian sync takes a hold on the SAME WASM client as the idle loop's
    // `syncState`, at the same two-minute ceiling, driven from the same tick — and its
    // failures are swallowed per-account, so with the fuse's ledger private to
    // `useSyncTrigger` these evictions were structurally invisible. Guardian is the
    // wallet's DEFAULT account type: an unresponsive guardian could park and poison
    // the client every two minutes forever, leaking one client per eviction, with the
    // fuse sitting at zero.
    __resetSyncFuseStateForTests();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    storeState.accounts = [{ publicKey: 'guardian-parked', type: WalletType.Guardian, hotPublicKey: 'hot-parked' }];
    const sync = jest.fn(async () => {
      throw new WasmClientPoisonedError('watchdog');
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
      await syncGuardianAccounts();
    }

    expect(sync).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
    // The fuse is lit, and the deadline it published is the one the idle loop reads.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('consecutive watchdog evictions of'));
    const until = syncFuseUntilMs(guardianSyncFuseKey('guardian-parked', 'https://guardian.test'));
    expect(until).not.toBeNull();
    expect(until! - monotonicNowMs()).toBeGreaterThan(FUSED_SYNC_PROBE_INTERVAL_MS / 2);

    // Falsifier: an ORDINARY guardian failure contributes nothing. Without the
    // eviction check this test would pass on any error at all.
    __resetSyncFuseStateForTests();
    sync.mockReset();
    sync.mockImplementation(async () => {
      throw new Error('guardian 500');
    });
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
      await syncGuardianAccounts();
    }
    expect(syncFuseUntilMs(guardianSyncFuseKey('guardian-parked', 'https://guardian.test'))).toBeNull();

    __resetSyncFuseStateForTests();
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('stops taking a hold for the account whose fuse is lit, and only that account (#777)', async () => {
    // The gate lives here rather than at the caller because there are TWO callers — the
    // mobile/desktop idle loop and the extension's post-`SyncRequest` trigger — and a
    // caller-side gate covered one of them while this function went on parking the
    // client for the other. Per account, because two guardian accounts are two
    // endpoints: throttling the parked one must not stop the healthy one.
    __resetSyncFuseStateForTests();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    storeState.accounts = [
      { publicKey: 'guardian-parked', type: WalletType.Guardian, hotPublicKey: 'hot-parked' },
      { publicKey: 'guardian-healthy', type: WalletType.Guardian, hotPublicKey: 'hot-healthy' }
    ];
    const parkedSync = jest.fn(async () => {
      throw new WasmClientPoisonedError('watchdog');
    });
    const healthySync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockImplementation(async (publicKey: string) => ({
      sync: publicKey === 'guardian-parked' ? parkedSync : healthySync
    }));

    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) await syncGuardianAccounts();
    expect(syncFuseUntilMs(guardianSyncFuseKey('guardian-parked', 'https://guardian.test'))).not.toBeNull();

    const parkedCallsWhenLit = parkedSync.mock.calls.length;
    const healthyCallsWhenLit = healthySync.mock.calls.length;
    await syncGuardianAccounts();

    // The parked account is skipped…
    expect(parkedSync).toHaveBeenCalledTimes(parkedCallsWhenLit);
    // …and the healthy sibling is not, which is what per-account keying buys. Without it
    // this assertion fails in one direction or the other whichever way the bug goes:
    // shared keys never light, a coarse gate stops both.
    expect(healthySync).toHaveBeenCalledTimes(healthyCallsWhenLit + 1);
    expect(syncFuseUntilMs(guardianSyncFuseKey('guardian-healthy', 'https://guardian.test'))).toBeNull();

    __resetSyncFuseStateForTests();
    jest.restoreAllMocks();
  });

  it('re-arms a LIT fuse on a 429, so the rate-limit cooldown cannot outrun it (#777)', async () => {
    // The other half of the 429 report. Once lit, the contract is one probe per 30 min
    // until one SUCCEEDS, and a 429 is not a success — but its own cooldown is 30–120s, so
    // without the re-arm a guardian answering every probe with a 429 pulls a fused account
    // straight back onto the ordinary cadence.
    __resetSyncFuseStateForTests();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    storeState.accounts = [{ publicKey: 'g429', type: WalletType.Guardian, hotPublicKey: 'hot1' }];
    const key = guardianSyncFuseKey('g429', 'https://guardian.test');
    const sync = jest.fn(async () => {
      throw new WasmClientPoisonedError('watchdog');
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) await syncGuardianAccounts();
    const armedAt = syncFuseUntilMs(key);
    expect(armedAt).not.toBeNull();

    // A distinct account id, because the 429 leaves a wall-clock rate-limit cooldown in
    // this module's per-account map that would skip a later test reusing the same key.
    // Serve out the fused window so the next lap gets through the gate, then answer 429.
    const monotonicSpy = jest
      .spyOn(performance, 'now')
      .mockReturnValue(Math.floor(performance.now()) + FUSED_SYNC_PROBE_INTERVAL_MS + 1_000);
    const rateLimited: Error & { status?: number } = new Error('429 Too Many Requests');
    rateLimited.status = 429;
    sync.mockImplementation(async () => {
      throw rateLimited;
    });
    await syncGuardianAccounts();

    // Still fused, and pushed out from now rather than left to expire.
    expect(isSyncFused(key)).toBe(true);
    expect(syncFuseUntilMs(key)!).toBeGreaterThan(armedAt!);
    monotonicSpy.mockRestore();

    __resetSyncFuseStateForTests();
    jest.restoreAllMocks();
  });

  it('does not carry a lit fuse across a guardian ENDPOINT change for the same account (#777)', async () => {
    // Every conclusion in the ledger is about one node. Repointing an account at a
    // different guardian makes the old conclusion meaningless, so the endpoint is part of
    // the key rather than something a clear-on-change hook has to remember.
    __resetSyncFuseStateForTests();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    storeState.accounts = [
      { publicKey: 'g1', type: WalletType.Guardian, hotPublicKey: 'hot1', guardianEndpoint: 'https://old.guardian' }
    ];
    const sync = jest.fn(async () => {
      throw new WasmClientPoisonedError('watchdog');
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) await syncGuardianAccounts();
    const callsWhenFused = sync.mock.calls.length;
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(callsWhenFused); // fused against the old endpoint

    // Same account, new guardian: it must be probed again immediately.
    storeState.accounts = [
      { publicKey: 'g1', type: WalletType.Guardian, hotPublicKey: 'hot1', guardianEndpoint: 'https://new.guardian' }
    ];
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(callsWhenFused + 1);

    __resetSyncFuseStateForTests();
    jest.restoreAllMocks();
  });

  it('keeps a lit fuse across a respelling of the same guardian endpoint (#777)', async () => {
    // The key is about the node, not the spelling: a host-case respelling of the
    // parked guardian must not buy it a fresh probe.
    __resetSyncFuseStateForTests();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const at = (guardianEndpoint: string) => [
      { publicKey: 'g-respelled-fuse', type: WalletType.Guardian, hotPublicKey: 'hot1', guardianEndpoint }
    ];
    storeState.accounts = at('https://Guardian.Example.com');
    const sync = jest.fn(async () => {
      throw new WasmClientPoisonedError('watchdog');
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) await syncGuardianAccounts();
    const callsWhenFused = sync.mock.calls.length;

    storeState.accounts = at('https://guardian.example.com');
    await syncGuardianAccounts();
    expect(sync).toHaveBeenCalledTimes(callsWhenFused);

    __resetSyncFuseStateForTests();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('reports a guardian 429 to the fuse like any other non-eviction failure (#777)', async () => {
    // The rate-limit branch `continue`s before the shared reporting block, so it used to
    // leave the ledger untouched. That is wrong in both directions: below the threshold a
    // 429 breaks the "consecutive evictions" chain and must withdraw the evidence, and
    // above it a 429 is not a success and must not let the 30–120s rate-limit cooldown
    // pull a fused account back onto a two-minute cadence.
    __resetSyncFuseStateForTests();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    storeState.accounts = [{ publicKey: 'g1', type: WalletType.Guardian, hotPublicKey: 'hot1' }];
    const key = guardianSyncFuseKey('g1', 'https://guardian.test');
    const rateLimited: Error & { status?: number; meta?: Record<string, unknown> } = new Error('429 Too Many Requests');
    rateLimited.status = 429;
    rateLimited.meta = { retry_after_secs: 0 };
    const sync = jest.fn(async () => {
      throw new WasmClientPoisonedError('watchdog');
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    // One short of the threshold…
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) await syncGuardianAccounts();
    expect(syncFuseUntilMs(key)).toBeNull();

    // …then a 429, which breaks the chain…
    sync.mockImplementationOnce(async () => {
      throw rateLimited;
    });
    await syncGuardianAccounts();

    // …and past the 429's own rate-limit cooldown (timed on performance.now), which otherwise
    // skips the next lap at the cooldown gate and makes this test vacuous.
    let nowMs = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    nowMs += SYNC_RATE_LIMIT_MAX_COOLDOWN_MS + 1_000;
    jest
      .spyOn(performance, 'now')
      .mockReturnValue(Math.floor(performance.now()) + SYNC_RATE_LIMIT_MAX_COOLDOWN_MS + 1_000);

    // …so the next eviction cannot be the fourth CONSECUTIVE one. Without the report the
    // chain was never broken and this lap lights the fuse.
    await syncGuardianAccounts();
    expect(syncFuseUntilMs(key)).toBeNull();

    __resetSyncFuseStateForTests();
    jest.restoreAllMocks();
  });

  it('withdraws the guardian fuse on that account\u2019s own success, so it is not a one-way door', async () => {
    // The fuse's only exit. Untested, a producer that only ever ADDS evidence fuses
    // permanently on the first four evictions of the install's life and the guardian
    // account never syncs again — a worse outcome than the freeze it replaced.
    __resetSyncFuseStateForTests();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    storeState.accounts = [{ publicKey: 'guardian-parked', type: WalletType.Guardian, hotPublicKey: 'hot-parked' }];
    let park = true;
    const sync = jest.fn(async () => {
      if (park) throw new WasmClientPoisonedError('watchdog');
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    // One eviction short of the threshold, then a success: the evidence is withdrawn, so
    // the next eviction starts from zero and cannot light the fuse on its own.
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) await syncGuardianAccounts();
    park = false;
    await syncGuardianAccounts();
    park = true;
    await syncGuardianAccounts();
    await syncGuardianAccounts();

    expect(syncFuseUntilMs(guardianSyncFuseKey('guardian-parked', 'https://guardian.test'))).toBeNull();

    __resetSyncFuseStateForTests();
    jest.restoreAllMocks();
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
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledWith('guardian-active', zustandProvider, true);
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
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledWith('guardian-active', zustandProvider, true);
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
    // Cases share account keys, and a lit heal fuse would gate a later case's heal (#1233).
    __resetSyncFuseStateForTests();
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
    // A re-register that resolves has passed its push start: the push is its only way to succeed.
    mockReRegister.mockImplementation(async (_options: unknown, onPushStart?: () => void) => {
      onPushStart?.();
    });
    // Default: this device IS still the account's on-chain hot signer.
    mockGetSignerDetails.mockClear();
    mockCommitmentFromPublicKeyHex.mockClear();
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    mockCommitmentFromPublicKeyHex.mockResolvedValue('0xAABB');
    // Default: no Failed rotation of this device's (#1233).
    mockFindFailedHotKeyRotations.mockReset();
    mockFindFailedHotKeyRotations.mockResolvedValue([]);
    mockMarkRotationCompleted.mockReset();
    mockMarkRotationCompleted.mockResolvedValue(undefined);
    storeState.swapHotKey.mockReset();
    storeState.swapHotKey.mockResolvedValue(undefined);
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

  it('builds its cold service and re-registers at the sync ceiling, labelled', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-heal-bounded', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();

    expect(mockBuildColdMultisigService).toHaveBeenCalledWith(
      { __sdkAccount: true },
      expect.objectContaining({ publicKey: 'acct-heal-bounded' }),
      expect.anything(),
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-self-heal-init' },
      expect.any(Function)
    );
    expect(mockReRegister).toHaveBeenCalledWith(
      {
        watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
        label: 'guardian-self-heal-reregister'
      },
      expect.any(Function)
    );
  });

  // Every other test in this describe tags its rejection with `__authRejection`.
  // This one throws the shape a real guardian sends, so the wiring from an actual
  // 401 through the real classifier to the `/configure` decision is pinned — the
  // tag cannot be the only reason this path is ever reached.
  it('reaches the self-heal from the shape a real guardian 401 has, not just the test tag', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      // The shape a real GuardianHttpError has: an Error carrying `status`, which
      // is what the production classifier duck-types on.
      sync: jest.fn(async () => {
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-real-401', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();

    expect(mockReRegister).toHaveBeenCalledTimes(1);
    // And it was classified as a 401 rather than as an outage: the server
    // answered, so the unreachable banner must stay down.
    expect(isGuardianSyncOutage('acct-real-401')).toBe(false);
  });

  // The 401 twin of the missing-registration cooldown test. A cold `/configure`
  // carries its own retry deadlines and can outlast SELF_HEAL_COOLDOWN_MS, so the
  // stamp has to come from when the attempt SETTLED. Under a frozen clock the
  // start-stamp and the settle-stamp are indistinguishable, which is why this
  // advances time from INSIDE the re-register.
  it('measures the self-heal cooldown from when the re-register finished', async () => {
    let now = 5_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-slow-heal', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    // Each re-register takes four times the cooldown it is supposed to buy.
    mockReRegister.mockImplementation(async () => {
      now += 4 * SELF_HEAL_COOLDOWN_MS;
    });

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(1);

    // The next tick lands right after that long attempt. Measured from the start
    // it would be overdue; measured from the finish it is not due yet.
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(1);

    now += SELF_HEAL_COOLDOWN_MS;
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
    perfSpy.mockRestore();
  });

  it('re-registers again after its cooldown when the wall clock steps back (#1233)', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    const account = {
      publicKey: 'acct-heal-clock-back',
      type: WalletType.Guardian,
      hotPublicKey: 'hot',
      coldPublicKey: 'cold'
    };
    storeState.accounts = [account];
    const t0 = 1_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const p0 = Math.floor(performance.now());
    const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(p0);
    try {
      for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();
      expect(mockReRegister).toHaveBeenCalledTimes(1);

      dateSpy.mockReturnValue(t0 - 60 * 60_000);
      perfSpy.mockReturnValue(p0 + SELF_HEAL_COOLDOWN_MS + 1);
      await syncGuardianAccounts();
      expect(mockReRegister).toHaveBeenCalledTimes(2);
    } finally {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
    }
  });

  // F-137 called the spent budget "the sharp one": with it kept across a
  // rotation, the NEW operator's first 401 re-marks the account unrepairable on a
  // verdict the OLD operator earned, and `decideColdReRegisterSelfHeal` refuses
  // forever because the attempt cap is already reached.
  it('gives the new operator its own re-register budget after a rotation', async () => {
    let now = 7_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    const account = {
      publicKey: 'acct-rotate-budget',
      type: WalletType.Guardian,
      hotPublicKey: 'hot',
      coldPublicKey: 'cold',
      guardianEndpoint: 'https://old.guardian.test'
    };
    storeState.accounts = [account] as never;

    // Spend the whole budget against the old operator.
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();
    while (mockReRegister.mock.calls.length < SELF_HEAL_MAX_ATTEMPTS) {
      now += SELF_HEAL_COOLDOWN_MS;
      await syncGuardianAccounts();
    }
    expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);
    now += SELF_HEAL_COOLDOWN_MS;
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);
    expect(isGuardianUnrepairable('acct-rotate-budget')).toBe(true);

    // Rotate. The verdict that condemned the account was the old operator's.
    storeState.accounts = [{ ...account, guardianEndpoint: 'https://new.guardian.test' }] as never;
    await syncGuardianAccounts();
    expect(isGuardianUnrepairable('acct-rotate-budget')).toBe(false);

    // And the new operator gets the full budget, starting from its own streak.
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD - 1; i++) await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS + 1);

    nowSpy.mockRestore();
    perfSpy.mockRestore();
  });

  // The rotation test's twin: a respelling the wallet treats as the same Guardian
  // is not a rotation, so it keeps the stamp and the 401 streak. The first pass
  // succeeds so there is a stamp to lose; the respelled pass fails, so it cannot
  // re-earn one.
  it('keeps the sync stamp and the 401 streak across a respelling of the same operator', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const pk = 'acct-respelled';
    const at = (guardianEndpoint: string) =>
      [
        { publicKey: pk, type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold', guardianEndpoint }
      ] as never;
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
    const sync = jest.fn().mockResolvedValue(undefined);
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });
    storeState.accounts = at('https://Guardian.Example.com');

    await syncGuardianAccounts();
    sync.mockRejectedValue(authError);
    await syncGuardianAccounts();

    storeState.accounts = at('https://guardian.example.com');
    await syncGuardianAccounts();

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(`${pk} now points at`));
    expect(getGuardianLastSyncAt(pk)).toEqual(expect.any(Number));
    // The streak is 2, so the next 401 reaches the threshold (3) and re-registers;
    // a reset at the respelling would leave it one short.
    expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
    await syncGuardianAccounts();
    expect(mockBuildColdMultisigService).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
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
    mockReRegister.mockImplementation(async (_options: unknown, onPushStart?: () => void) => {
      onPushStart?.();
      throw new Error('configure rejected');
    });
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
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);

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
    perfSpy.mockRestore();
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
    const perfSpy = jest.spyOn(performance, 'now');
    // Enough refusals to blow a budget of SELF_HEAL_MAX_ATTEMPTS, each past the
    // cooldown so the decision gate itself is not what is holding them back.
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      nowSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      perfSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }
    expect(mockReRegister).not.toHaveBeenCalled();

    // The read recovers: the repair must still be available.
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    nowSpy.mockReturnValue(start + 100 * (SELF_HEAL_COOLDOWN_MS + 1_000));
    perfSpy.mockReturnValue(start + 100 * (SELF_HEAL_COOLDOWN_MS + 1_000));
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
    perfSpy.mockRestore();
  });

  // #1233: the re-register's chain guard refuses before any `/configure`, so a refusal is booked
  // like a read failure: no attempt spent, and the repair is still there once local catches up.
  it('does not spend the bounded budget on a push the chain guard refused (#1233)', async () => {
    const { GuardianReRegisterRefusedError } = jest.requireActual('lib/miden/guardian');
    mockReRegister.mockRejectedValue(
      new GuardianReRegisterRefusedError(
        'acct-refused',
        new Error('Local account commitment does not match on-chain commitment')
      )
    );
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-refused', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');
    const perfSpy = jest.spyOn(performance, 'now');
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      nowSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      perfSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }
    const refusedPushes = mockReRegister.mock.calls.length;

    // The local copy caught up with the chain: the repair is still available.
    mockReRegister.mockResolvedValue(undefined);
    nowSpy.mockReturnValue(start + 100 * (SELF_HEAL_COOLDOWN_MS + 1_000));
    perfSpy.mockReturnValue(start + 100 * (SELF_HEAL_COOLDOWN_MS + 1_000));
    await syncGuardianAccounts();

    expect(mockReRegister).toHaveBeenCalledTimes(refusedPushes + 1);
    nowSpy.mockRestore();
    perfSpy.mockRestore();
  });

  // A rejection before the push start (a watchdog eviction of the read hold, a failed sync, a missing account)
  // wrote nothing to the guardian, so it spends no attempt either.
  it('does not spend the bounded budget on a re-register whose read failed before the push (#1233)', async () => {
    mockReRegister.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-reregister-unread', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    let now = 5_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      await syncGuardianAccounts();
      now += SELF_HEAL_COOLDOWN_MS;
    }

    expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS + 1);
    expect(isGuardianUnrepairable('acct-reregister-unread')).toBe(false);
    nowSpy.mockRestore();
    perfSpy.mockRestore();
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
    const perfSpy = jest.spyOn(performance, 'now');
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      nowSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      perfSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }

    expect(mockReRegister).not.toHaveBeenCalled();
    expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
    perfSpy.mockRestore();
  });

  // #1233: the heal's holds report to a per-account heal fuse, which gates the heal. Not the account's
  // sync key: the 401 arm books that lap's 401 on it and withdraws unlit evidence within the lap.
  const runHealLaps = async (publicKey: string) => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey, type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    let now = 6_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
    // Seven laps are due for a heal: every lap from the threshold on, a cooldown apart.
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + MAX_CONSECUTIVE_WATCHDOG_EVICTIONS + 2; i++) {
      await syncGuardianAccounts();
      now += SELF_HEAL_COOLDOWN_MS;
    }
    nowSpy.mockRestore();
    perfSpy.mockRestore();
  };

  it("stops re-registering once watchdog evictions of the heal's holds light its own fuse (#1233)", async () => {
    mockReRegister.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await runHealLaps('acct-heal-fused');

    expect(mockReRegister).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
    expect(isSyncFused(guardianSelfHealFuseKey('acct-heal-fused', 'https://guardian.test'))).toBe(true);
    expect(isSyncFused(guardianSyncFuseKey('acct-heal-fused', 'https://guardian.test'))).toBe(false);
    expect(isGuardianUnrepairable('acct-heal-fused')).toBe(false);
  });

  it("books a watchdog eviction of the heal's adopt on the same fuse (#1233)", async () => {
    mockAdoptGuardianState.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await runHealLaps('acct-heal-adopt-fused');

    expect(mockAdoptGuardianState).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
    expect(mockReRegister).not.toHaveBeenCalled();
    expect(isSyncFused(guardianSelfHealFuseKey('acct-heal-adopt-fused', 'https://guardian.test'))).toBe(true);
  });

  it("withdraws the heal's eviction evidence when a heal lap gets through (#1233)", async () => {
    mockReRegister.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) {
      mockReRegister.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));
    }
    mockReRegister.mockImplementationOnce(
      async (_options: unknown, onPushStart?: (signerCommitments: readonly string[]) => void) => {
        onPushStart?.([]);
      }
    );

    await runHealLaps('acct-heal-recovered');

    // Every due lap still heals.
    expect(mockReRegister).toHaveBeenCalledTimes(7);
    expect(isSyncFused(guardianSelfHealFuseKey('acct-heal-recovered', 'https://guardian.test'))).toBe(false);
  });

  it('holds every read of the cold heal at the sync ceiling, labelled (#1233)', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey: 'acct-heal-labelled', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD - 1; i++) await syncGuardianAccounts();
    mockWithWasmClientLock.mockClear();

    await syncGuardianAccounts();

    expect(mockReRegister).toHaveBeenCalledTimes(1);
    const labelOf = (options: unknown): unknown =>
      typeof options === 'object' && options !== null && 'label' in options ? options.label : undefined;
    const labels = mockWithWasmClientLock.mock.calls.map(([, options]) => labelOf(options));
    expect(labels).not.toContain(undefined);
    // The stale read, the account read and the chain-signer read.
    expect(labels.filter(label => label === 'guardian-self-heal-read')).toHaveLength(3);
  });

  // #1233: this device's own rotation landed after its row failed, so slot 0 names the rotation's new
  // key rather than the device's current one. Only the chain-verified signer set the re-register
  // pushes is evidence enough to swap.
  const arrangeOwnRotation = (publicKey: string) => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    storeState.accounts = [
      { publicKey, type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;
    mockGetSignerDetails.mockResolvedValue({ commitment: '0xbeef' });
    mockCommitmentFromPublicKeyHex.mockImplementation(async (publicKeyHex: string) =>
      publicKeyHex === 'new-hot-pub' ? '0xbeef' : '0xAABB'
    );
    mockFindFailedHotKeyRotations.mockResolvedValue([{ id: 'row-rot', newHotPublicKey: 'new-hot-pub' }]);
  };
  const pushStartWith =
    (signers: readonly string[]) =>
    async (_options: unknown, onPushStart?: (signerCommitments: readonly string[]) => void) => {
      onPushStart?.(signers);
    };
  const runPastCooldowns = async (laps: number) => {
    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');
    const perfSpy = jest.spyOn(performance, 'now');
    for (let i = 0; i < laps; i++) {
      nowSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      perfSpy.mockReturnValue(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }
    nowSpy.mockRestore();
    perfSpy.mockRestore();
  };
  // The vault's check, against the record the store holds when the swap lands, refused in the shape
  // deserializeError gives it on the extension.
  const swapAsTheVault = () =>
    storeState.swapHotKey.mockImplementation(
      async (accountPublicKey: string, _newHotPubKey: string, expectedHotPubKey?: string | null) => {
        const current = storeState.accounts.find(stored => stored.publicKey === accountPublicKey);
        if (expectedHotPubKey !== undefined && (current?.hotPublicKey ?? null) !== expectedHotPubKey) {
          throw Object.assign(new Error('The account hot key changed'), { code: 'HOT_KEY_CHANGED' });
        }
      }
    );

  it("finishes this device's own rotation once the chain-verified signer set names its key (#1233)", async () => {
    arrangeOwnRotation('acct-own-rotation');
    mockReRegister.mockImplementation(pushStartWith(['0xbeef', '0xc01d']));

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();

    expect(mockReRegister).toHaveBeenCalledTimes(1);
    expect(storeState.swapHotKey).toHaveBeenCalledWith('acct-own-rotation', 'new-hot-pub', 'hot');
    const swappedAt = storeState.swapHotKey.mock.invocationCallOrder[0]!;
    expect(swappedAt).toBeGreaterThan(mockReRegister.mock.invocationCallOrder[0]!);
    expect(mockMarkRotationCompleted).toHaveBeenCalledWith('row-rot');
    // The 401 arm evicts the service every lap; the finish evicts it again once the key is swapped.
    expect(mockClearGuardianServiceFor).toHaveBeenLastCalledWith('acct-own-rotation');
    expect(Math.max(...mockClearGuardianServiceFor.mock.invocationCallOrder)).toBeGreaterThan(swappedAt);
    expect(isGuardianUnrepairable('acct-own-rotation')).toBe(false);
  });

  it("keeps the budget open while the chain does not confirm this device's rotation (#1233)", async () => {
    const { GuardianReRegisterRefusedError } = jest.requireActual('lib/miden/guardian');
    arrangeOwnRotation('acct-own-unconfirmed');
    mockReRegister.mockRejectedValue(
      new GuardianReRegisterRefusedError(
        'acct-own-unconfirmed',
        new Error('Local account commitment does not match on-chain commitment')
      )
    );

    await runPastCooldowns(SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS);

    expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS + 1);
    expect(storeState.swapHotKey).not.toHaveBeenCalled();
    expect(mockMarkRotationCompleted).not.toHaveBeenCalled();
    expect(isGuardianUnrepairable('acct-own-unconfirmed')).toBe(false);
  });

  it("does not swap when the chain-verified signer set lacks the rotation's key (#1233)", async () => {
    arrangeOwnRotation('acct-own-unverified');
    mockReRegister.mockImplementation(pushStartWith(['0xAABB', '0xc01d']));

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();

    expect(mockReRegister).toHaveBeenCalledTimes(1);
    expect(storeState.swapHotKey).not.toHaveBeenCalled();
    expect(mockMarkRotationCompleted).not.toHaveBeenCalled();
  });

  it("does not close the budget when this device's rotation rows cannot be read (#1233)", async () => {
    arrangeOwnRotation('acct-own-unread');
    mockFindFailedHotKeyRotations.mockRejectedValue(new Error('the transactions table is closed'));

    await runPastCooldowns(SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS);

    expect(mockReRegister).not.toHaveBeenCalled();
    expect(mockAdoptGuardianState).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS + 1);
    expect(isGuardianUnrepairable('acct-own-unread')).toBe(false);
  });

  // The shape deserializeError gives the refusal on the extension: a plain error carrying the code.
  it('closes the budget when the vault refuses the swap (#1233)', async () => {
    arrangeOwnRotation('acct-own-unswappable');
    mockReRegister.mockImplementation(pushStartWith(['0xbeef', '0xc01d']));
    storeState.swapHotKey.mockRejectedValueOnce(
      Object.assign(new Error('The new hot key is not stored in this wallet'), { code: 'HOT_KEY_NOT_STORED' })
    );

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();

    expect(mockReRegister).toHaveBeenCalledTimes(1);
    expect(storeState.swapHotKey).toHaveBeenCalledTimes(1);
    expect(mockMarkRotationCompleted).not.toHaveBeenCalled();
    expect(isGuardianUnrepairable('acct-own-unswappable')).toBe(true);
  });

  // A locked vault, an intercom or a storage failure: the push ran, so it is booked as one, and the
  // next due heal re-verifies before it swaps.
  it('keeps the budget open and swaps on a later heal when the swap fails transiently (#1233)', async () => {
    arrangeOwnRotation('acct-own-locked');
    mockReRegister.mockImplementation(pushStartWith(['0xbeef', '0xc01d']));
    storeState.swapHotKey.mockRejectedValueOnce(new Error('Wallet is locked'));

    await runPastCooldowns(SELF_HEAL_AUTH_FAILURE_THRESHOLD + 1);

    expect(mockReRegister).toHaveBeenCalledTimes(2);
    expect(storeState.swapHotKey).toHaveBeenCalledTimes(2);
    expect(mockMarkRotationCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkRotationCompleted).toHaveBeenCalledWith('row-rot');
    expect(isGuardianUnrepairable('acct-own-locked')).toBe(false);
  });

  // The user's own rotation completed while the push ran: the heal swaps only from the record it read
  // at the start of its lap, so the vault refuses and the newer key stays (#1233).
  it("does not finish its own rotation when the account's hot key moved during the push, and keeps the budget open (#1233)", async () => {
    arrangeOwnRotation('acct-own-moved');
    swapAsTheVault();
    let pushes = 0;
    mockReRegister.mockImplementation(
      async (_options: unknown, onPushStart?: (signerCommitments: readonly string[]) => void) => {
        pushes += 1;
        if (pushes < SELF_HEAL_MAX_ATTEMPTS) {
          onPushStart?.(['0xAABB', '0xc01d']);
          return;
        }
        onPushStart?.(['0xbeef', '0xc01d']);
        storeState.accounts = [
          {
            publicKey: 'acct-own-moved',
            type: WalletType.Guardian,
            hotPublicKey: 'retry-hot-pub',
            coldPublicKey: 'cold'
          }
        ] as never;
      }
    );

    await runPastCooldowns(SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS - 1);

    expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);
    expect(storeState.swapHotKey).toHaveBeenCalledTimes(1);
    expect(storeState.swapHotKey).toHaveBeenCalledWith('acct-own-moved', 'new-hot-pub', 'hot');
    expect(mockMarkRotationCompleted).not.toHaveBeenCalled();
    // Two attempts booked, not three.
    expect(isGuardianUnrepairable('acct-own-moved')).toBe(false);
  });

  // #1233: a post-recovery or migrated account has no hot key, so the sync loop filters it out and it
  // never 401s into the heal; its own trigger finishes its landed rotation.
  describe('a rotation-pending account', () => {
    const pendingAccount = {
      publicKey: 'acct-activation',
      type: WalletType.Guardian,
      coldPublicKey: 'cold',
      requiresHotKeyRotation: true
    };

    beforeEach(() => {
      __resetGuardianSyncOutageForTest();
      mockGetOrCreateMultisigService.mockClear();
      mockGetSignerDetails.mockResolvedValue({ commitment: '0xbeef' });
      mockCommitmentFromPublicKeyHex.mockImplementation(async (publicKeyHex: string) =>
        publicKeyHex === 'new-hot-pub' ? '0xbeef' : '0xAABB'
      );
      mockFindFailedHotKeyRotations.mockResolvedValue([{ id: 'row-act', newHotPublicKey: 'new-hot-pub' }]);
      mockReRegister.mockImplementation(pushStartWith(['0xbeef', '0xc01d']));
    });

    // First, so the cases after it run on the account whose heal fuse it lit.
    it('skips a pending activation whose heal fuse is lit (#1233)', async () => {
      storeState.accounts = [pendingAccount] as never;
      noteSyncParked(guardianSelfHealFuseKey('acct-activation', 'https://guardian.test'));

      await syncGuardianAccounts();

      expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
    });

    it("finishes a rotation-pending account's own rotation without a hot key or a 401 (#1233)", async () => {
      storeState.accounts = [pendingAccount] as never;

      await syncGuardianAccounts();

      expect(mockBuildColdMultisigService).toHaveBeenCalledWith(
        { __sdkAccount: true },
        expect.objectContaining({ publicKey: 'acct-activation' }),
        expect.anything(),
        { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-self-heal-init' },
        expect.any(Function)
      );
      expect(mockReRegister).toHaveBeenCalledTimes(1);
      expect(storeState.swapHotKey).toHaveBeenCalledWith('acct-activation', 'new-hot-pub', null);
      expect(mockMarkRotationCompleted).toHaveBeenCalledWith('row-act');
      expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
    });

    // Keyed on the flag, not a missing hot key: a record naming its cold key as hot still syncs
    // healthily, so no 401 ever reaches the heal.
    it("finishes a rotation-pending account's own rotation when its record names the cold key as hot (#1233)", async () => {
      storeState.accounts = [{ ...pendingAccount, hotPublicKey: 'cold' }] as never;
      mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => undefined) });

      await syncGuardianAccounts();

      expect(storeState.swapHotKey).toHaveBeenCalledWith('acct-activation', 'new-hot-pub', 'cold');
      expect(mockMarkRotationCompleted).toHaveBeenCalledWith('row-act');
    });

    it('does not finish a keyless activation whose account gained a key during the push (#1233)', async () => {
      storeState.accounts = [pendingAccount] as never;
      swapAsTheVault();
      mockReRegister.mockImplementationOnce(
        async (_options: unknown, onPushStart?: (signerCommitments: readonly string[]) => void) => {
          onPushStart?.(['0xbeef', '0xc01d']);
          storeState.accounts = [
            { ...pendingAccount, hotPublicKey: 'retry-hot-pub', requiresHotKeyRotation: false }
          ] as never;
        }
      );

      await syncGuardianAccounts();

      expect(storeState.swapHotKey).toHaveBeenCalledWith('acct-activation', 'new-hot-pub', null);
      expect(mockMarkRotationCompleted).not.toHaveBeenCalled();
    });

    it('backs off a pending activation the chain has not confirmed (#1233)', async () => {
      const { GuardianReRegisterRefusedError } = jest.requireActual('lib/miden/guardian');
      storeState.accounts = [pendingAccount] as never;
      mockReRegister.mockRejectedValue(
        new GuardianReRegisterRefusedError(
          'acct-activation',
          new Error('Local account commitment does not match on-chain commitment')
        )
      );
      const t0 = Date.now();
      const nowSpy = jest.spyOn(Date, 'now');
      const perfSpy = jest.spyOn(performance, 'now');

      // Due 1 and then 2 cooldowns after each run, so the third lap is not due.
      for (const cooldowns of [0, 1, 2, 3]) {
        nowSpy.mockReturnValue(t0 + cooldowns * SELF_HEAL_COOLDOWN_MS);
        perfSpy.mockReturnValue(t0 + cooldowns * SELF_HEAL_COOLDOWN_MS);
        await syncGuardianAccounts();
      }
      nowSpy.mockRestore();
      perfSpy.mockRestore();

      expect(mockReRegister).toHaveBeenCalledTimes(3);
      expect(storeState.swapHotKey).not.toHaveBeenCalled();
    });

    it('retries a pending activation after its cooldown when the wall clock steps back (#1233)', async () => {
      storeState.accounts = [pendingAccount];
      mockReRegister.mockRejectedValue(new Error('configure rejected'));
      const t0 = 1_000_000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const p0 = Math.floor(performance.now());
      const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(p0);
      try {
        await syncGuardianAccounts();
        expect(mockReRegister).toHaveBeenCalledTimes(1);

        dateSpy.mockReturnValue(t0 - 60 * 60_000);
        perfSpy.mockReturnValue(p0 + SELF_HEAL_COOLDOWN_MS + 1);
        await syncGuardianAccounts();
        expect(mockReRegister).toHaveBeenCalledTimes(2);
      } finally {
        dateSpy.mockRestore();
        perfSpy.mockRestore();
      }
    });

    it('costs nothing for a pending account with no Failed rotation of its own (#1233)', async () => {
      storeState.accounts = [pendingAccount] as never;
      mockFindFailedHotKeyRotations.mockResolvedValue([]);

      await syncGuardianAccounts();

      expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
      expect(mockGetAccount).not.toHaveBeenCalled();
    });

    // Nothing of its own to finish and no 401 asking for a repair, so the finisher must not push.
    it('does not re-register a pending account whose slot 0 is its own recorded key (#1233)', async () => {
      storeState.accounts = [{ ...pendingAccount, hotPublicKey: 'cold' }] as never;
      mockGetSignerDetails.mockResolvedValue({ commitment: '0xAABB' });
      mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => undefined) });

      await syncGuardianAccounts();

      expect(mockBuildColdMultisigService).toHaveBeenCalledTimes(1);
      expect(mockReRegister).not.toHaveBeenCalled();
      expect(storeState.swapHotKey).not.toHaveBeenCalled();
    });

    // Each clock from its own base at the same offsets, as in a live realm, so a cooldown stamped on
    // one clock and compared on the other is an epoch off rather than invisible.
    // Integer performance.now bases keep base + offset exact, so a step of exactly one cooldown compares equal.
    const clockBases = () => ({ t0: Date.now(), p0: Math.floor(performance.now()) });
    const lapsAt = async ({ t0, p0 }: { t0: number; p0: number }, offsets: number[]) => {
      const nowSpy = jest.spyOn(Date, 'now');
      const perfSpy = jest.spyOn(performance, 'now');
      for (const offset of offsets) {
        nowSpy.mockReturnValue(t0 + offset);
        perfSpy.mockReturnValue(p0 + offset);
        await syncGuardianAccounts();
      }
      nowSpy.mockRestore();
      perfSpy.mockRestore();
    };

    it('checks a pending account with no Failed rotation at most once per cooldown, counting no attempt (#1233)', async () => {
      storeState.accounts = [pendingAccount] as never;
      mockFindFailedHotKeyRotations.mockResolvedValue([]);
      const clocks = clockBases();

      await lapsAt(clocks, [0, 3_000, SELF_HEAL_COOLDOWN_MS]);
      expect(mockFindFailedHotKeyRotations).toHaveBeenCalledTimes(2);

      mockFindFailedHotKeyRotations.mockResolvedValue([{ id: 'row-act', newHotPublicKey: 'new-hot-pub' }]);
      await lapsAt(clocks, [2 * SELF_HEAL_COOLDOWN_MS]);
      expect(mockBuildColdMultisigService).toHaveBeenCalledTimes(1);
    });

    it('counts a cooldown exactly from a fractional clock reading (#1233)', async () => {
      storeState.accounts = [pendingAccount];
      mockFindFailedHotKeyRotations.mockResolvedValue([]);
      const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(1234.002);
      const clocks = clockBases();
      perfSpy.mockRestore();

      await lapsAt(clocks, [0, 3_000, SELF_HEAL_COOLDOWN_MS]);
      expect(mockFindFailedHotKeyRotations).toHaveBeenCalledTimes(2);

      mockFindFailedHotKeyRotations.mockResolvedValue([{ id: 'row-act', newHotPublicKey: 'new-hot-pub' }]);
      await lapsAt(clocks, [2 * SELF_HEAL_COOLDOWN_MS]);
      expect(mockBuildColdMultisigService).toHaveBeenCalledTimes(1);
    });

    it('checks a pending account whose heal fuse is lit at most once per cooldown (#1233)', async () => {
      storeState.accounts = [pendingAccount] as never;
      const clocks = clockBases();
      const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(clocks.p0);
      noteSyncParked(guardianSelfHealFuseKey('acct-activation', 'https://guardian.test'));
      perfSpy.mockRestore();

      await lapsAt(clocks, [0, 3_000]);

      expect(mockFindFailedHotKeyRotations).toHaveBeenCalledTimes(1);
      expect(mockBuildColdMultisigService).not.toHaveBeenCalled();
    });

    it('stops re-running a heal the vault refused permanently until the Failed rotations change (#1233)', async () => {
      storeState.accounts = [pendingAccount] as never;
      storeState.swapHotKey.mockRejectedValue(
        Object.assign(new Error('The new hot key is not stored in this wallet'), { code: 'HOT_KEY_NOT_STORED' })
      );
      const clocks = clockBases();

      await lapsAt(clocks, [0, SELF_HEAL_COOLDOWN_MS, 3 * SELF_HEAL_COOLDOWN_MS]);
      expect(mockReRegister).toHaveBeenCalledTimes(1);
      expect(storeState.swapHotKey).toHaveBeenCalledTimes(1);

      mockFindFailedHotKeyRotations.mockResolvedValue([
        { id: 'row-act', newHotPublicKey: 'new-hot-pub' },
        { id: 'row-act-2', newHotPublicKey: 'new-hot-pub' }
      ]);
      await lapsAt(clocks, [5 * SELF_HEAL_COOLDOWN_MS]);
      expect(mockReRegister).toHaveBeenCalledTimes(2);
    });

    // Past the finisher's widest backoff by a margin, so a fractional performance.now() base cannot round a
    // gap to just under it.
    const dueLap = (lap: number) => lap * (FUSED_SYNC_PROBE_INTERVAL_MS + 1_000);
    const dueLaps = (first: number, count: number) => Array.from({ length: count }, (_, lap) => dueLap(first + lap));

    it('stops pushing for a rotation whose swap keeps failing once the push budget is spent (#1233)', async () => {
      storeState.accounts = [pendingAccount];
      storeState.swapHotKey.mockRejectedValue(new Error('Wallet is locked'));
      const clocks = clockBases();

      await lapsAt(clocks, dueLaps(0, SELF_HEAL_MAX_ATTEMPTS + 2));

      expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);
      expect(storeState.swapHotKey).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);
      expect(mockMarkRotationCompleted).not.toHaveBeenCalled();
    });

    it('reopens the push budget for a new Failed rotation (#1233)', async () => {
      storeState.accounts = [pendingAccount];
      storeState.swapHotKey.mockRejectedValue(new Error('Wallet is locked'));
      const clocks = clockBases();
      await lapsAt(clocks, dueLaps(0, SELF_HEAL_MAX_ATTEMPTS + 1));
      const spent = mockReRegister.mock.calls.length;

      mockFindFailedHotKeyRotations.mockResolvedValue([
        { id: 'row-act', newHotPublicKey: 'new-hot-pub' },
        { id: 'row-act-2', newHotPublicKey: 'new-hot-pub' }
      ]);
      await lapsAt(clocks, dueLaps(SELF_HEAL_MAX_ATTEMPTS + 1, 1));
      expect(mockReRegister).toHaveBeenCalledTimes(spent + 1);

      await lapsAt(clocks, dueLaps(SELF_HEAL_MAX_ATTEMPTS + 2, SELF_HEAL_MAX_ATTEMPTS - 1));
      expect(mockReRegister).toHaveBeenCalledTimes(spent + SELF_HEAL_MAX_ATTEMPTS);
    });

    it('reopens the push budget on a different guardian (#1233)', async () => {
      storeState.accounts = [pendingAccount];
      storeState.swapHotKey.mockRejectedValue(new Error('Wallet is locked'));
      const clocks = clockBases();
      try {
        await lapsAt(clocks, dueLaps(0, SELF_HEAL_MAX_ATTEMPTS + 1));
        expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);

        mockResolveGuardianEndpoint.mockResolvedValue('https://other.guardian.test');
        await lapsAt(clocks, dueLaps(SELF_HEAL_MAX_ATTEMPTS + 1, 1));
        expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS + 1);
      } finally {
        mockResolveGuardianEndpoint.mockImplementation(resolveEndpointDefault);
      }
    });

    it('reopens the push budget when the account returns to a guardian it already spent on (#1233)', async () => {
      storeState.accounts = [pendingAccount];
      storeState.swapHotKey.mockRejectedValue(new Error('Wallet is locked'));
      const clocks = clockBases();
      try {
        await lapsAt(clocks, dueLaps(0, SELF_HEAL_MAX_ATTEMPTS + 1));
        expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);

        mockResolveGuardianEndpoint.mockResolvedValue('https://other.guardian.test');
        await lapsAt(clocks, dueLaps(SELF_HEAL_MAX_ATTEMPTS + 1, 1));
        expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS + 1);

        mockResolveGuardianEndpoint.mockResolvedValue('https://guardian.test');
        await lapsAt(clocks, dueLaps(SELF_HEAL_MAX_ATTEMPTS + 2, 1));
        expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS + 2);
      } finally {
        mockResolveGuardianEndpoint.mockImplementation(resolveEndpointDefault);
      }
    });

    it('reopens the push budget after a return when the other guardian never reached the heal (#1233)', async () => {
      storeState.accounts = [pendingAccount];
      storeState.swapHotKey.mockRejectedValue(new Error('Wallet is locked'));
      const clocks = clockBases();
      try {
        await lapsAt(clocks, dueLaps(0, SELF_HEAL_MAX_ATTEMPTS + 1));
        expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);

        // Lit on the other guardian's lap's own clock, so that lap stops at the fused exit.
        const otherLap = dueLap(SELF_HEAL_MAX_ATTEMPTS + 1);
        const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(clocks.p0 + otherLap);
        noteSyncParked(guardianSelfHealFuseKey('acct-activation', 'https://other.guardian.test'));
        perfSpy.mockRestore();
        mockResolveGuardianEndpoint.mockResolvedValue('https://other.guardian.test');
        await lapsAt(clocks, [otherLap]);
        expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);

        mockResolveGuardianEndpoint.mockResolvedValue('https://guardian.test');
        await lapsAt(clocks, dueLaps(SELF_HEAL_MAX_ATTEMPTS + 2, 1));
        expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS + 1);
      } finally {
        mockResolveGuardianEndpoint.mockImplementation(resolveEndpointDefault);
      }
    });

    it('keeps a permanent refusal closed on a different guardian (#1233)', async () => {
      storeState.accounts = [pendingAccount];
      storeState.swapHotKey.mockRejectedValue(
        Object.assign(new Error('The new hot key is not stored in this wallet'), { code: 'HOT_KEY_NOT_STORED' })
      );
      const clocks = clockBases();
      try {
        await lapsAt(clocks, dueLaps(0, 1));
        expect(mockReRegister).toHaveBeenCalledTimes(1);

        mockResolveGuardianEndpoint.mockResolvedValue('https://other.guardian.test');
        await lapsAt(clocks, dueLaps(1, SELF_HEAL_MAX_ATTEMPTS));
        expect(mockReRegister).toHaveBeenCalledTimes(1);
      } finally {
        mockResolveGuardianEndpoint.mockImplementation(resolveEndpointDefault);
      }
    });

    it('checks a pending account whose rows cannot be read at most once per cooldown (#1233)', async () => {
      storeState.accounts = [pendingAccount] as never;
      mockFindFailedHotKeyRotations.mockRejectedValue(new Error('rows unreadable'));
      const clocks = clockBases();

      await lapsAt(clocks, [0, 3_000]);
      expect(mockFindFailedHotKeyRotations).toHaveBeenCalledTimes(1);

      await lapsAt(clocks, [SELF_HEAL_COOLDOWN_MS]);
      expect(mockFindFailedHotKeyRotations).toHaveBeenCalledTimes(2);
    });
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

    // The cooldown is a monotonic deadline (a backward wall-clock correction must not
    // extend it), so the clock this drives is performance.now.
    const now = Math.floor(performance.now());
    const nowSpy = jest.spyOn(performance, 'now');
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

    // The cooldown is a monotonic deadline (a backward wall-clock correction must not
    // extend it), so the clock this drives is performance.now.
    const now = Math.floor(performance.now());
    const nowSpy = jest.spyOn(performance, 'now');
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

  // The success stamp's lifetime has to OUTLAST the longest cooldown this same
  // module can impose on itself, or the pill flaps across a cooldown the wallet
  // chose. A hand-picked 90s sat above the 30s fallback floor and BELOW the 120s
  // ceiling, so one 429 carrying a large Retry-After was enough: park for 120s,
  // stamp expires at 90s, Settings reads Online → Checking → Online with nothing
  // actually wrong. Asserted as an ORDERING between the two constants, which is
  // the property, rather than against either number.
  it('keeps the success stamp fresh across the longest cooldown it can impose', () => {
    expect(GUARDIAN_SYNC_STAMP_FRESH_MS).toBeGreaterThan(SYNC_RATE_LIMIT_MAX_COOLDOWN_MS);
  });

  it('never self-heals on a 429 — it is not an auth failure', async () => {
    const sync = jest.fn(async () => {
      throw rateLimited(1);
    });
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });
    storeState.accounts = [
      { publicKey: 'acct-429-noheal', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    // The cooldown is a monotonic deadline (a backward wall-clock correction must not
    // extend it), so the clock this drives is performance.now.
    const now = Math.floor(performance.now());
    const nowSpy = jest.spyOn(performance, 'now');
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
    // `clearAllMocks` keeps implementations, so a test that overrides the
    // resolver would otherwise decide every operator identity after it.
    mockResolveGuardianEndpoint.mockImplementation(resolveEndpointDefault);
    mockResolveChosenGuardianEndpoint.mockImplementation(resolveChosenDefault);
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

  // The module's invariant is "the server ANSWERED, so it is alive, so the
  // outage stands down", and it is implemented at three sites. Only the 401 one
  // above was pinned: deleting either of the two below left all 87 tests green,
  // because the test that looked like it covered the unknown-account arm
  // asserted `isGuardianSyncOutage(...) === false` on a fixture that never
  // increments the counter in the first place — false either way. The
  // regression that misses is a banner telling the user to rotate away from an
  // operator that is demonstrably up and merely rate-limiting them.
  it('a 429 proves the server is up — it clears an armed outage', async () => {
    const pk = 'outage-429';
    storeState.accounts = [guardianAccount(pk)] as never;
    const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
    expect(isGuardianSyncOutage(pk)).toBe(true);

    sync.mockRejectedValue({ status: 429, meta: {} });
    await runSyncs(1);
    expect(isGuardianSyncOutage(pk)).toBe(false);
  });

  it('an unknown-account verdict proves the server is up — it clears an armed outage', async () => {
    const pk = 'outage-unknown-account';
    storeState.accounts = [guardianAccount(pk)] as never;
    const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
    expect(isGuardianSyncOutage(pk)).toBe(true);

    sync.mockRejectedValue({ code: 'account_not_found', message: 'no such account' });
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

    // The two tests above each arrange ONE piece of state, which is exactly why
    // they both passed while the reset dropped only the first thing it hit: its
    // three deletions were chained with `||`, so a rotation away from an operator
    // that had earned an outage — the primary path this feature exists for, since
    // the banner is what sends the user to rotate — kept that operator's success
    // stamp. This arranges both at once, which is the real sequence.
    it('drops the stamp even when the outage flag was armed first', async () => {
      const pk = 'rotate-stamp-and-outage';
      storeState.accounts = [at(pk, 'https://old.guardian.test')] as never;
      const sync = jest.fn().mockResolvedValue(undefined);
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toEqual(expect.any(Number));

      sync.mockRejectedValue(new Error('Failed to fetch'));
      await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
      expect(isGuardianSyncOutage(pk)).toBe(true);
      // Still stamped: an outage does not retract a sync that really happened.
      expect(getGuardianLastSyncAt(pk)).toEqual(expect.any(Number));

      storeState.accounts = [at(pk, 'https://new.guardian.test')] as never;
      await runSyncs(1);

      expect(isGuardianSyncOutage(pk)).toBe(false);
      // The one the short-circuit skipped: without it Guardian Settings reads a
      // fresh stamp and renders a never-contacted operator "Online".
      expect(getGuardianLastSyncAt(pk)).toBeUndefined();
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

    // The operator the sync talks to is whatever `resolveGuardianEndpoint`
    // returns, so the detector has to key on THAT and not on the raw field.
    // Keying on the field was wrong in both directions.
    it('does not fire on the unlock-time backfill, which stamps the endpoint already in use', async () => {
      const pk = 'rotate-backfill';
      // No per-account endpoint: this account resolves through the fallback.
      storeState.accounts = [at(pk, undefined)] as never;
      const sync = jest.fn().mockResolvedValue(undefined);
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      await runSyncs(1);
      const stamped = getGuardianLastSyncAt(pk);
      expect(stamped).toEqual(expect.any(Number));

      // The backfill writes the value the account was ALREADY resolving to.
      // Nothing about the operator changed, so nothing may be dropped — keying on
      // the raw field saw `'' !== 'https://…'`, called it a rotation, and threw
      // away a valid sync stamp (flipping the pill Online → Checking) along with
      // the 401 streak and the self-heal budget.
      //
      // The tick behind the backfill FAILS, so a dropped stamp cannot be masked
      // by the same tick re-earning one: only the absence of a reset preserves it.
      storeState.accounts = [at(pk, 'https://guardian.test')] as never;
      sync.mockRejectedValue(new Error('Failed to fetch'));
      await runSyncs(1);

      expect(getGuardianLastSyncAt(pk)).toBe(stamped);
    });

    it('fires when the resolved default moves under an account with no endpoint of its own', async () => {
      const pk = 'rotate-default';
      storeState.accounts = [at(pk, undefined)] as never;
      const sync = jest.fn().mockResolvedValue(undefined);
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      await runSyncs(1);
      expect(getGuardianLastSyncAt(pk)).toEqual(expect.any(Number));

      // A dev-settings endpoint override mutates the override cache in this realm
      // with no reload, so the effective default changes on the very next tick
      // while the account's own field stays `undefined`. Keying on the field, this
      // was the F-137 defect itself surviving its own fix: no reset fired and the
      // previous operator's entire verdict set carried over to one never contacted.
      mockResolveGuardianEndpoint.mockResolvedValue('https://override.guardian.test');
      sync.mockRejectedValue(new Error('Failed to fetch'));
      await runSyncs(1);

      expect(getGuardianLastSyncAt(pk)).toBeUndefined();
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

    // Everything a pass decides comes from one snapshot of the account list, and
    // `service.sync()` is a guardian request with no client-side deadline. A
    // rotation committing while that request is open makes the result a
    // statement about an operator the account no longer points at — and a
    // SUCCESS would stamp it, reporting the new guardian as Online because the
    // old one answered.
    it('does not record a result that a rotation landed during', async () => {
      const pk = 'rotate-midflight';
      storeState.accounts = [at(pk, 'https://old.guardian.test')] as never;

      let releaseSync = (): void => {};
      const syncGate = new Promise<void>(resolve => {
        releaseSync = resolve;
      });
      mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(() => syncGate) });

      try {
        const pass = syncGuardianAccounts();

        // The user rotates while the request above is still open.
        storeState.accounts = [at(pk, 'https://new.guardian.test')] as never;
        releaseSync();
        await pass;

        // The old operator's success is not the new operator's.
        expect(getGuardianLastSyncAt(pk)).toBeUndefined();
      } finally {
        releaseSync();
      }
    });

    it('records a result when the account was only respelled while the request was open', async () => {
      const pk = 'respell-midflight';
      storeState.accounts = [at(pk, 'https://Guardian.Example.com')] as never;

      let releaseSync = (): void => {};
      const syncGate = new Promise<void>(resolve => {
        releaseSync = resolve;
      });
      mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(() => syncGate) });

      try {
        const pass = syncGuardianAccounts();

        // Host case only: the operator the pass talked to is still the current one.
        storeState.accounts = [at(pk, 'https://guardian.example.com')] as never;
        releaseSync();
        await pass;

        expect(getGuardianLastSyncAt(pk)).toEqual(expect.any(Number));
      } finally {
        releaseSync();
      }
    });

    it('does not let a failure a rotation landed during arm the banner against the new operator', async () => {
      const pk = 'rotate-midflight-fail';
      storeState.accounts = [at(pk, 'https://old.guardian.test')] as never;
      const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
      mockGetOrCreateMultisigService.mockResolvedValue({ sync });

      // One short of arming, all against the old operator.
      await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD - 1);
      expect(isGuardianSyncOutage(pk)).toBe(false);

      let releaseSync = (): void => {};
      const syncGate = new Promise<void>((_, reject) => {
        releaseSync = () => reject(new Error('Failed to fetch'));
      });
      sync.mockImplementation(() => syncGate);

      try {
        const pass = syncGuardianAccounts();
        storeState.accounts = [at(pk, 'https://new.guardian.test')] as never;
        releaseSync();
        await pass;

        // The failure that would have been the sixth belongs to the operator the
        // account has left, so it must not arm the prompt telling the user to
        // rotate away from the one it just arrived at.
        expect(isGuardianSyncOutage(pk)).toBe(false);
      } finally {
        releaseSync();
      }
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

  it('kicks transaction processing once when an armed outage stands down (#779)', async () => {
    const pk = 'outage-kick';
    storeState.accounts = [guardianAccount(pk)] as never;
    const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
    expect(mockRequestSWTransactionProcessing).not.toHaveBeenCalled();

    sync.mockResolvedValue(undefined);
    await runSyncs(2);
    expect(mockRequestSWTransactionProcessing).toHaveBeenCalledTimes(1);
  });

  it('kicks processing when a 401 stands an armed outage down (#779)', async () => {
    const pk = 'outage-kick-401';
    storeState.accounts = [guardianAccount(pk)] as never;
    const sync = jest.fn().mockRejectedValue(new Error('Failed to fetch'));
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await runSyncs(GUARDIAN_SYNC_OUTAGE_THRESHOLD);
    sync.mockRejectedValue(Object.assign(new Error('nope'), { __authRejection: true }));
    await runSyncs(1);
    expect(mockRequestSWTransactionProcessing).toHaveBeenCalledTimes(1);
  });

  it('does not kick processing for a success with no armed outage (#779)', async () => {
    const pk = 'no-outage-no-kick';
    storeState.accounts = [guardianAccount(pk)] as never;
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn().mockResolvedValue(undefined) });

    await runSyncs(2);
    expect(mockRequestSWTransactionProcessing).not.toHaveBeenCalled();
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
    // Every case shares this account and endpoint, so one that lights the heal fuse would gate the rest.
    __resetSyncFuseStateForTests();
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
    mockResolveGuardianEndpoint.mockImplementation(resolveEndpointDefault);
    mockResolveChosenGuardianEndpoint.mockImplementation(resolveChosenDefault);
    mockFindUnsavedSwitchRow.mockResolvedValue(undefined);
    mockMultisigInit.mockReset();
    mockAssertWasmHoldCurrent.mockReset();
  });

  // #1233: the heal's holds report to the account's heal fuse, which gates the heal.
  it('stops pushing once watchdog evictions of its register hold light the heal fuse (#1233)', async () => {
    mockFinalizeDirectGuardianSwitch.mockRejectedValue(
      new GuardianRegistrationPreflightError('Could not prepare the guardian registration: evicted', {
        cause: new WasmClientPoisonedError('watchdog')
      })
    );
    let now = 8_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);

    await runUntilPersistent();
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS + 2; i++) {
      now += MISSING_REGISTRATION_BACKOFF_MS;
      await syncGuardianAccounts();
    }
    nowSpy.mockRestore();
    perfSpy.mockRestore();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
    expect(isSyncFused(guardianSelfHealFuseKey('unregistered-pk', 'https://new.guardian.test'))).toBe(true);
  });

  it('books evictions of its snapshot read on the heal fuse and keeps the pass alive (#1233)', async () => {
    mockGetAccount.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await runUntilPersistent();
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS + 1; i++) {
      await expect(syncGuardianAccounts()).resolves.toBeUndefined();
    }

    // The snapshot is this arm's only account read, and a lit fuse skips the heal.
    expect(mockGetAccount).toHaveBeenCalledTimes(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
    expect(isSyncFused(guardianSelfHealFuseKey('unregistered-pk', 'https://new.guardian.test'))).toBe(true);
    expect(mockWithWasmClientLock).toHaveBeenCalledWith(expect.any(Function), {
      watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
      label: 'guardian-self-heal-read'
    });
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  // The account handle is borrowed from the client, so a read of it after a lost hold is a double borrow.
  it('stops the snapshot at a hold lost during its account read (#1233)', async () => {
    const where = 'missing-registration snapshot: after the account read';
    mockAssertWasmHoldCurrent.mockImplementation((_hold: unknown, at: string) => {
      if (at === where) throw new WasmClientPoisonedError('watchdog');
    });

    await expect(runUntilPersistent()).resolves.toBeUndefined();

    expect(mockAssertWasmHoldCurrent).toHaveBeenCalledWith(undefined, where);
    expect(mockGetGuardianCommitmentFromAccount).not.toHaveBeenCalled();
    expect(mockGetSignerDetails).not.toHaveBeenCalled();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  // One eviction short of the fuse, then a register that is not an eviction, then evictions again:
  // the fuse stays unlit only if that register withdrew the evidence.
  it.each([
    ['resolves', () => mockFinalizeDirectGuardianSwitch.mockResolvedValueOnce(undefined)],
    ['rejects', () => mockFinalizeDirectGuardianSwitch.mockRejectedValueOnce(new Error('configure rejected'))]
  ])(
    "a register that gets through or fails without an eviction withdraws the heal fuse's evidence (%s) (#1233)",
    async (_label, variant) => {
      const evicted = () =>
        new GuardianRegistrationPreflightError('Could not prepare the guardian registration: evicted', {
          cause: new WasmClientPoisonedError('watchdog')
        });
      mockFinalizeDirectGuardianSwitch.mockRejectedValue(evicted());
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) {
        mockFinalizeDirectGuardianSwitch.mockRejectedValueOnce(evicted());
      }
      variant();
      let now = 8_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);

      await runUntilPersistent();
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS + 2; i++) {
        now += MISSING_REGISTRATION_BACKOFF_MS;
        await syncGuardianAccounts();
      }
      nowSpy.mockRestore();
      perfSpy.mockRestore();

      expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2 * MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1);
      expect(isSyncFused(guardianSelfHealFuseKey('unregistered-pk', 'https://new.guardian.test'))).toBe(false);
    }
  );

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
      expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith('unregistered-pk', endpoint, zustandProvider, {
        watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
        label: 'guardian-self-heal-register'
      });
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

  // The pointer the account CHOSE, which is neither the raw field nor the fully
  // resolved value. A pre-per-account-endpoint account on a custom operator has an
  // EMPTY field and the legacy global key as its only pointer — the unlock backfill
  // leaves the field empty rather than stamping a guess — so reading the field
  // refused the repair for exactly the population this arm serves, and refused it
  // BEFORE the unrepairable mark, leaving the account in the "Checking forever"
  // state that mark exists to name.
  it('repairs a legacy account that points at its operator through the global key', async () => {
    storeState.accounts = [{ ...account, guardianEndpoint: undefined }] as never;
    mockResolveChosenGuardianEndpoint.mockResolvedValue(endpoint);

    await runUntilPersistent();
    await syncGuardianAccounts();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);
    // Against the operator that answered, not `undefined`.
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith(
      account.publicKey,
      endpoint,
      expect.anything(),
      expect.anything()
    );
  });

  // An unreadable pointer gets the SAME refusal as no pointer at all. This call
  // POSTs the device's serialized private account state, so "we could not read
  // which operator the account chose" is the one condition under which it must
  // not guess — and the resolver deliberately propagates that failure rather than
  // flattening it into the `undefined` that means "chose nothing".
  it('does not register when the account\u2019s guardian pointer cannot be read', async () => {
    mockResolveChosenGuardianEndpoint.mockRejectedValue(new Error('storage unavailable'));

    await runUntilPersistent();
    await syncGuardianAccounts();

    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
  });

  // ...and the read failure must not escape into the sync loop, which iterates
  // every account: one account's storage hiccup would otherwise abort the tick
  // for all of them.
  //
  // Driven through `resolveGuardianEndpoint`, NOT `resolveChosenGuardianEndpoint`.
  // The loop's own resolution at the top of each iteration is the call that
  // escapes — it sits outside the per-account try — and the two are separate
  // mocks here, so rejecting only the self-heal's resolver leaves the escaping
  // path healthy and the test green either way. It also needs a SECOND account:
  // with one, "the pass resolved" and "the remaining accounts were served" are
  // the same assertion, and any abort is invisible.
  it('keeps syncing the remaining accounts when one account\u2019s pointer read throws', async () => {
    const healthy = {
      publicKey: 'healthy-pk',
      type: WalletType.Guardian,
      hotPublicKey: 'hot',
      guardianEndpoint: endpoint
    };
    storeState.accounts = [account, healthy] as never;
    mockResolveGuardianEndpoint.mockImplementation(async (acc: { guardianEndpoint?: string; publicKey?: string }) => {
      if (acc.publicKey === account.publicKey) throw new Error('storage unavailable');
      return endpoint;
    });
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();

    // The account AFTER the failing one still got its tick.
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledWith('healthy-pk', zustandProvider, true);
    expect(sync).toHaveBeenCalled();
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
    const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(1_000_000);
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
    perfSpy.mockReturnValue(1_000_000 + MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith(
      'unregistered-pk',
      endpoint,
      zustandProvider,
      expect.anything()
    );

    nowSpy.mockRestore();
    perfSpy.mockRestore();
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
    const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(t0);

    await expect(runUntilPersistent()).resolves.toBeUndefined();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(t0 + MISSING_REGISTRATION_BACKOFF_MS - 1);
    perfSpy.mockReturnValue(t0 + MISSING_REGISTRATION_BACKOFF_MS - 1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    const t1 = t0 + MISSING_REGISTRATION_BACKOFF_MS;
    nowSpy.mockReturnValue(t1);
    perfSpy.mockReturnValue(t1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    // The gap doubles, so the second wait is twice the first.
    const t2 = t1 + 2 * MISSING_REGISTRATION_BACKOFF_MS;
    nowSpy.mockReturnValue(t2 - 1);
    perfSpy.mockReturnValue(t2 - 1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(t2);
    perfSpy.mockReturnValue(t2);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);

    // Capped: an operator that keeps refusing a registration it also says it
    // needs will not be resolved by further `/configure` calls.
    nowSpy.mockReturnValue(t2 + 100 * MISSING_REGISTRATION_BACKOFF_MS);
    perfSpy.mockReturnValue(t2 + 100 * MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);

    nowSpy.mockRestore();
    perfSpy.mockRestore();
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
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
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
    perfSpy.mockRestore();
  });

  // A refusal that never reached the operator does not spend an attempt, but it
  // still has to stamp the clock from its own finish — the probe behind it is an
  // HTTP round trip, and an unstamped refusal re-runs it on every ~3s tick.
  it('stamps a refunded attempt from its finish too', async () => {
    let now = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
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
    perfSpy.mockRestore();
  });

  it('retries a missing registration after its backoff when the wall clock steps back (#1233)', async () => {
    mockFinalizeDirectGuardianSwitch.mockRejectedValue(new Error('configure rejected'));
    const t0 = 1_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const p0 = Math.floor(performance.now());
    const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(p0);
    try {
      await runUntilPersistent();
      expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

      dateSpy.mockReturnValue(t0 - 60 * 60_000);
      perfSpy.mockReturnValue(p0 + MISSING_REGISTRATION_BACKOFF_MS + 1);
      await syncGuardianAccounts();
      expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);
    } finally {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
    }
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
    const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);

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
    perfSpy.mockRestore();
  });

  // The budget is keyed by what the push would WRITE, so a second rotation in the
  // same session is not silently skipped by the first one's spent attempts.
  it('re-arms for a rotation to a different endpoint in the same session', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    // Same instant throughout, so only the new key — never the backoff — can
    // allow the second push.
    storeState.accounts = [{ ...account, guardianEndpoint: 'https://second.guardian.test' }] as never;
    mockGetGuardianCommitmentFromAccount.mockReturnValue('secondguardiankey');
    // The rotation resets the persistence counter, so the new operator has to
    // produce the verdicts itself before its state is overwritten.
    await runUntilPersistent();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenNthCalledWith(
      2,
      'unregistered-pk',
      'https://second.guardian.test',
      zustandProvider,
      expect.anything()
    );
    nowSpy.mockRestore();
  });

  it('does not re-arm for a respelling of the same endpoint', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    storeState.accounts = [{ ...account, guardianEndpoint: 'https://Guardian.Example.com' }] as never;

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    // Same instant, same operator, same guardian key: only a spelling-keyed budget
    // could allow a second push. Enough passes to reach persistence even if the
    // respelling were taken for a rotation, which would otherwise mask the key.
    storeState.accounts = [{ ...account, guardianEndpoint: 'https://guardian.example.com' }] as never;
    await runUntilPersistent();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  // The threshold does not exist to establish that the account is unregistered —
  // it exists to rule out a TRANSIENT verdict, since `data_unavailable` is a
  // server-side condition that can blip. Verdicts inherited across a rotation
  // therefore let a single blip from the new operator authorize a `/configure`
  // that overwrites its authoritative copy of a private account's state, and the
  // guardian-key guard does not cover it: that proves WHO the operator is, not
  // that its answer persists.
  it('does not let verdicts earned by the previous operator authorize a push to the new one', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    // Two verdicts short of the threshold from the outgoing operator.
    for (let i = 0; i < MISSING_REGISTRATION_PERSISTENCE_THRESHOLD - 1; i++) await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

    storeState.accounts = [{ ...account, guardianEndpoint: 'https://second.guardian.test' }] as never;
    mockGetGuardianCommitmentFromAccount.mockReturnValue('secondguardiankey');

    // One blip from the new operator must not be enough.
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

    // It earns the push on its own verdicts, at the same instant — so it is the
    // counter being re-earned, not a cooldown elapsing.
    for (let i = 0; i < MISSING_REGISTRATION_PERSISTENCE_THRESHOLD - 1; i++) await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith(
      'unregistered-pk',
      'https://second.guardian.test',
      zustandProvider,
      expect.anything()
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

  it('clears the unsaved-switch flag once a registration lands (#1233)', async () => {
    await runUntilPersistent();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);
    expect(mockClearLocalStateNotSaved).toHaveBeenCalledWith('unregistered-pk', endpoint);
    expect(mockMultisigInit).not.toHaveBeenCalled();
  });

  // The flag is only the receipt's warning; failing to clear it must not turn a landed registration
  // into a failed attempt.
  it('still books the registration as landed when clearing the unsaved-switch flag fails (#1233)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    mockClearLocalStateNotSaved.mockRejectedValueOnce(new Error('Dexie closed'));

    await runUntilPersistent();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not clear the unsaved-switch flag for unregistered-pk'),
      expect.any(Error)
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('registered unregistered-pk on'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('could not register'), expect.anything());
    warnSpy.mockRestore();
  });

  // #1233: a landed switch whose apply failed leaves this device's copy naming the OLD guardian.
  describe('a switch whose local state was not saved', () => {
    const previousEndpoint = 'https://old.guardian.test';
    let adopted = false;

    beforeEach(() => {
      adopted = false;
      __resetSyncFuseStateForTests();
      mockFindUnsavedSwitchRow.mockResolvedValue({
        id: 'switch-row',
        previousGuardianEndpoint: previousEndpoint,
        switchedDirectly: false
      });
      mockAdoptGuardianState.mockReset();
      mockAdoptGuardianState.mockImplementation(async () => {
        adopted = true;
      });
      mockMultisigInit.mockResolvedValue({ adoptGuardianStateOnce: mockAdoptGuardianState });
      // The local copy names the OLD guardian until the adopt imports the post-switch state.
      mockGetGuardianCommitmentFromAccount.mockImplementation(() => (adopted ? 'newguardiankey' : 'oldguardiankey'));
      mockCheckEndpointCommitment.mockImplementation(async (_endpoint: string, key: string) =>
        key === 'newguardiankey' ? 'match' : 'mismatch'
      );
    });

    // Init and the adopt time their own hold inside their lock callback and report it through onHeld
    // (guardian/index.test.ts pins that); these stand-ins keep the same contract over the suite's lock.
    const heldUnderLock = <T>(onHeld: unknown, work: () => Promise<T>): Promise<T> =>
      mockWithWasmClientLock(async () => {
        const heldFrom = monotonicNowMs();
        try {
          return await work();
        } finally {
          (onHeld as ((ms: number) => void) | undefined)?.(monotonicNowMs() - heldFrom);
        }
      }) as Promise<T>;

    it('adopts the post-switch state from the previous guardian, then registers it and clears the flag', async () => {
      await runUntilPersistent();

      expect(mockMultisigInit).toHaveBeenCalledWith(
        { __sdkAccount: true },
        '0xhot',
        '0xaabb',
        zustandProvider.signWord,
        previousEndpoint,
        { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'guardian-adopt-init' },
        expect.any(Function)
      );
      expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
      expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith(
        'unregistered-pk',
        endpoint,
        zustandProvider,
        expect.anything()
      );
      expect(mockClearLocalStateNotSaved).toHaveBeenCalledWith('unregistered-pk', endpoint);
    });

    it('books a push after an adopt on the guardian key it writes (#1233)', async () => {
      mockFinalizeDirectGuardianSwitch.mockRejectedValue(new Error('configure rejected'));
      const t0 = 1_000_000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const p0 = Math.floor(performance.now());
      const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(p0);
      const lapAt = async (offset: number) => {
        dateSpy.mockReturnValue(t0 + offset);
        perfSpy.mockReturnValue(p0 + offset);
        await syncGuardianAccounts();
      };
      try {
        await runUntilPersistent();
        expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
        expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

        await lapAt(3_000);
        expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

        let offset = MISSING_REGISTRATION_BACKOFF_MS + 1;
        await lapAt(offset);
        expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

        for (const backoffs of [2, 4, 8]) {
          offset += backoffs * MISSING_REGISTRATION_BACKOFF_MS + 1;
          await lapAt(offset);
        }
        expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);
        expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
      } finally {
        dateSpy.mockRestore();
        perfSpy.mockRestore();
      }
    });

    it('does not adopt for an account with no such row', async () => {
      mockFindUnsavedSwitchRow.mockResolvedValue(undefined);

      await runUntilPersistent();

      expect(mockMultisigInit).not.toHaveBeenCalled();
      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
    });

    it('does not register while the adopted state still names another guardian', async () => {
      // The previous guardian has not canonicalized the switch yet: the adopt imports nothing.
      mockAdoptGuardianState.mockImplementation(async () => {});

      await runUntilPersistent();

      expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
      expect(mockClearLocalStateNotSaved).not.toHaveBeenCalled();
    });

    it('refuses without registering when the previous guardian cannot be reached', async () => {
      mockMultisigInit.mockRejectedValue(new Error('Failed to fetch'));

      await runUntilPersistent();

      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
    });

    // The direct path fled that operator: it never received the switch delta, and an init against it
    // can hold the realm's WASM lock until the watchdog.
    it('never contacts the previous guardian for a switch that took the direct path', async () => {
      mockFindUnsavedSwitchRow.mockResolvedValue({
        id: 'switch-row',
        previousGuardianEndpoint: previousEndpoint,
        switchedDirectly: true
      });

      await runUntilPersistent();

      expect(mockFindUnsavedSwitchRow).toHaveBeenCalledWith('unregistered-pk', endpoint);
      expect(mockMultisigInit).not.toHaveBeenCalled();
      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
    });

    it('stops contacting a previous guardian that held the lock to the watchdog until the fuse interval passes', async () => {
      const t0 = 1_000_000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const p0 = Math.floor(performance.now());
      const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(p0);
      mockMultisigInit.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

      await runUntilPersistent();
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);
      expect(isSyncFused(guardianAdoptFuseKey('unregistered-pk', previousEndpoint))).toBe(true);

      // The heal is due again and runs (a second key check), but does not reach that operator.
      dateSpy.mockReturnValue(t0 + MISSING_REGISTRATION_BACKOFF_MS);
      perfSpy.mockReturnValue(p0 + MISSING_REGISTRATION_BACKOFF_MS);
      await syncGuardianAccounts();
      expect(mockCheckEndpointCommitment).toHaveBeenCalledTimes(2);
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);

      // Once the interval has passed it tries again, and an operator that answers completes the repair.
      mockMultisigInit.mockResolvedValue({ adoptGuardianStateOnce: mockAdoptGuardianState });
      dateSpy.mockReturnValue(t0 + FUSED_SYNC_PROBE_INTERVAL_MS + MISSING_REGISTRATION_BACKOFF_MS);
      perfSpy.mockReturnValue(p0 + FUSED_SYNC_PROBE_INTERVAL_MS);
      await syncGuardianAccounts();
      expect(mockMultisigInit).toHaveBeenCalledTimes(2);
      expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith(
        'unregistered-pk',
        endpoint,
        zustandProvider,
        expect.anything()
      );

      dateSpy.mockRestore();
      perfSpy.mockRestore();
    });

    // A gateway that turns the silence into a 504 before the watchdog (stock HAProxy: 50 s) holds the
    // adopt's lock that long; the refusal window is measured from before the adopt, so unpaused it would
    // hold the lock 50 s of every 60 s.
    it('stops contacting a previous guardian whose adopt failed slowly', async () => {
      const t0 = 1_000_000;
      let now = t0;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
      mockAdoptGuardianState.mockImplementation((onHeld: unknown) =>
        heldUnderLock(onHeld, async () => {
          now += 50_000;
          throw new Error('504 Gateway Timeout');
        })
      );

      await runUntilPersistent();
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);

      now = t0 + MISSING_REGISTRATION_BACKOFF_MS;
      await syncGuardianAccounts();
      expect(mockCheckEndpointCommitment).toHaveBeenCalledTimes(2);
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);

      dateSpy.mockRestore();
      perfSpy.mockRestore();
    });

    it('retries a previous guardian whose adopt failed fast on the usual cadence', async () => {
      let now = 1_000_000;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
      mockAdoptGuardianState.mockImplementation((onHeld: unknown) =>
        heldUnderLock(onHeld, async () => {
          now += 9_000;
          throw new Error('Failed to fetch');
        })
      );

      await runUntilPersistent();
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);

      now += MISSING_REGISTRATION_BACKOFF_MS;
      await syncGuardianAccounts();
      expect(mockMultisigInit).toHaveBeenCalledTimes(2);

      dateSpy.mockRestore();
      perfSpy.mockRestore();
    });

    // Init reaches the same operator under its own hold, so a 504 there holds the lock as long.
    it('stops contacting a previous guardian whose init failed slowly', async () => {
      const t0 = 1_000_000;
      let now = t0;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
      mockMultisigInit.mockImplementation((...args: unknown[]) =>
        heldUnderLock(args[6], async () => {
          now += 50_000;
          throw new Error('504 Gateway Timeout');
        })
      );

      await runUntilPersistent();
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);
      expect(isSyncFused(guardianAdoptFuseKey('unregistered-pk', previousEndpoint))).toBe(true);

      now = t0 + MISSING_REGISTRATION_BACKOFF_MS;
      await syncGuardianAccounts();
      expect(mockCheckEndpointCommitment).toHaveBeenCalledTimes(2);
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);

      dateSpy.mockRestore();
      perfSpy.mockRestore();
    });

    it('counts the init and the adopt together toward a park', async () => {
      const t0 = 1_000_000;
      let now = t0;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
      const previous = { adoptGuardianStateOnce: mockAdoptGuardianState };
      mockMultisigInit.mockImplementation((...args: unknown[]) =>
        heldUnderLock(args[6], async () => {
          now += 6_000;
          return previous;
        })
      );
      // Not yet canonicalized: the adopt imports nothing.
      mockAdoptGuardianState.mockImplementation((onHeld: unknown) =>
        heldUnderLock(onHeld, async () => {
          now += 6_000;
        })
      );

      await runUntilPersistent();
      expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
      expect(isSyncFused(guardianAdoptFuseKey('unregistered-pk', previousEndpoint))).toBe(true);
      const checks = mockCheckEndpointCommitment.mock.calls.length;

      now = t0 + MISSING_REGISTRATION_BACKOFF_MS;
      await syncGuardianAccounts();
      expect(mockCheckEndpointCommitment).toHaveBeenCalledTimes(checks + 1);
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);

      dateSpy.mockRestore();
      perfSpy.mockRestore();
    });

    // Waiting behind another holder is not the operator's time: a lap whose holds were quick is no park.
    it('does not count time queued for the lock toward a park', async () => {
      let now = 1_000_000;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
      mockWithWasmClientLock.mockImplementation(async (fn: () => Promise<unknown>) => {
        now += 11_000;
        return fn();
      });
      const previous = { adoptGuardianStateOnce: mockAdoptGuardianState };
      mockMultisigInit.mockImplementation((...args: unknown[]) => heldUnderLock(args[6], async () => previous));
      mockAdoptGuardianState.mockImplementation((onHeld: unknown) => heldUnderLock(onHeld, async () => {}));

      try {
        await runUntilPersistent();
        expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
        expect(isSyncFused(guardianAdoptFuseKey('unregistered-pk', previousEndpoint))).toBe(false);

        now += MISSING_REGISTRATION_BACKOFF_MS;
        await syncGuardianAccounts();
        expect(mockMultisigInit).toHaveBeenCalledTimes(2);
      } finally {
        mockWithWasmClientLock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
        dateSpy.mockRestore();
        perfSpy.mockRestore();
      }
    });

    describe('whose delta the landed push did not deliver', () => {
      // The service's real bounded push over the mocked `pushSwitchDelta`, so its budget and its verdicts
      // are the ones production uses.
      const realPushSwitchDeltaBounded: (proposalId: string) => Promise<'pushed' | 'silent' | 'refused'> =
        jest.requireActual('lib/miden/guardian').MultisigService.prototype.pushSwitchDeltaBounded;
      const mockPushSwitchDelta = jest.fn(async (_proposalId: string) => {});

      beforeEach(() => {
        mockPushSwitchDelta.mockReset();
        mockPushSwitchDelta.mockImplementation(async () => {});
        mockFindUnsavedSwitchRow.mockResolvedValue({
          id: 'switch-row',
          previousGuardianEndpoint: previousEndpoint,
          switchedDirectly: false,
          switchProposalId: 'prop',
          switchDeltaPushed: false
        });
        const previous = {
          pushSwitchDelta: mockPushSwitchDelta,
          pushSwitchDeltaBounded: (proposalId: string) => realPushSwitchDeltaBounded.call(previous, proposalId),
          adoptGuardianStateOnce: mockAdoptGuardianState
        };
        mockMultisigInit.mockResolvedValue(previous);
      });

      it('re-pushes the switch delta before adopting when the first push failed', async () => {
        await runUntilPersistent();

        expect(mockPushSwitchDelta).toHaveBeenCalledWith('prop');
        expect(mockPushSwitchDelta.mock.invocationCallOrder[0]!).toBeLessThan(
          mockAdoptGuardianState.mock.invocationCallOrder[0]!
        );
        expect(mockMarkSwitchDeltaPushed).toHaveBeenCalledWith('switch-row');
        expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith(
          'unregistered-pk',
          endpoint,
          zustandProvider,
          expect.anything()
        );
      });

      it('skips the adopt when the re-push times out', async () => {
        mockPushSwitchDelta.mockImplementation(() => new Promise<void>(() => {}));
        for (let i = 0; i < MISSING_REGISTRATION_PERSISTENCE_THRESHOLD - 1; i++) await syncGuardianAccounts();
        jest.useFakeTimers({ doNotFake: ['Date', 'performance'] });
        try {
          const lap = syncGuardianAccounts();
          await jest.advanceTimersByTimeAsync(30_000);
          await lap;
        } finally {
          jest.useRealTimers();
        }

        expect(mockPushSwitchDelta).toHaveBeenCalledWith('prop');
        expect(mockAdoptGuardianState).not.toHaveBeenCalled();
        expect(mockMarkSwitchDeltaPushed).not.toHaveBeenCalled();
        expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
        // A silent guardian would park the next lap's adopt, so the lap is booked as a park.
        expect(isSyncFused(guardianAdoptFuseKey('unregistered-pk', previousEndpoint))).toBe(true);
      });

      it('never re-pushes a delta the landed push delivered', async () => {
        mockFindUnsavedSwitchRow.mockResolvedValue({
          id: 'switch-row',
          previousGuardianEndpoint: previousEndpoint,
          switchedDirectly: false,
          switchProposalId: 'prop',
          switchDeltaPushed: true
        });

        await runUntilPersistent();

        expect(mockPushSwitchDelta).not.toHaveBeenCalled();
        expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
      });

      // A fast refusal took no hold, so it costs one lap and lights nothing; the adopt's own hold is timed.
      it('adopts without pausing when the previous guardian answers the re-push with a fast 503', async () => {
        let now = 1_000_000;
        const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
        const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
        mockPushSwitchDelta.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { status: 503 }));
        // Not yet canonicalized: the adopt imports nothing, so the next due lap tries again.
        mockAdoptGuardianState.mockImplementation(async () => {});

        await runUntilPersistent();
        expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
        expect(isSyncFused(guardianAdoptFuseKey('unregistered-pk', previousEndpoint))).toBe(false);

        now += MISSING_REGISTRATION_BACKOFF_MS;
        await syncGuardianAccounts();
        expect(mockMultisigInit).toHaveBeenCalledTimes(2);

        dateSpy.mockRestore();
        perfSpy.mockRestore();
      });

      // The re-push runs outside any lock, so its wait is no park: only the holds that reach the operator are timed.
      it('books a slow re-push followed by a quick adopt as a lap that did not park', async () => {
        let now = 1_000_000;
        const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
        const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
        mockPushSwitchDelta.mockImplementation(async () => {
          now += 12_000;
        });

        await runUntilPersistent();

        expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
        expect(isSyncFused(guardianAdoptFuseKey('unregistered-pk', previousEndpoint))).toBe(false);

        dateSpy.mockRestore();
        perfSpy.mockRestore();
      });
    });

    it('an endpoint change lifts the pause on a previous guardian', async () => {
      const t0 = 1_000_000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const p0 = Math.floor(performance.now());
      const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(p0);
      mockMultisigInit.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

      await runUntilPersistent();
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);

      clearSyncFuseForEndpointChange();
      dateSpy.mockReturnValue(t0 + MISSING_REGISTRATION_BACKOFF_MS);
      perfSpy.mockReturnValue(p0 + MISSING_REGISTRATION_BACKOFF_MS);
      await syncGuardianAccounts();
      expect(mockMultisigInit).toHaveBeenCalledTimes(2);

      dateSpy.mockRestore();
      perfSpy.mockRestore();
    });

    // The pause is one-shot, as it was before the ledger kept it: a lap whose adopt holds the lock
    // briefly is booked a success whatever the copy reads, so the next due lap reaches the operator.
    it('pauses a previous guardian once, and a quick adopt after the pause lifts it while the copy stays pre-switch', async () => {
      const t0 = 1_000_000;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const p0 = Math.floor(performance.now());
      const perfSpy = jest.spyOn(performance, 'now').mockReturnValue(p0);
      mockMultisigInit.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));
      // Never canonicalized: the adopt imports nothing, so the copy keeps naming the old guardian.
      mockAdoptGuardianState.mockImplementation(async () => {});

      await runUntilPersistent();
      expect(mockMultisigInit).toHaveBeenCalledTimes(1);

      dateSpy.mockReturnValue(t0 + FUSED_SYNC_PROBE_INTERVAL_MS + MISSING_REGISTRATION_BACKOFF_MS);
      perfSpy.mockReturnValue(p0 + FUSED_SYNC_PROBE_INTERVAL_MS);
      await syncGuardianAccounts();
      expect(mockMultisigInit).toHaveBeenCalledTimes(2);
      expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

      dateSpy.mockReturnValue(t0 + FUSED_SYNC_PROBE_INTERVAL_MS + 2 * MISSING_REGISTRATION_BACKOFF_MS);
      perfSpy.mockReturnValue(p0 + FUSED_SYNC_PROBE_INTERVAL_MS + MISSING_REGISTRATION_BACKOFF_MS);
      await syncGuardianAccounts();
      expect(mockMultisigInit).toHaveBeenCalledTimes(3);

      dateSpy.mockRestore();
      perfSpy.mockRestore();
    });
  });
});
