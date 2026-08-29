/**
 * zustandProvider + syncGuardianAccounts — the default provider exposes the
 * store API, and the syncGuardianAccounts driver pulls from it, skips non-
 * Guardian accounts, and swallows per-account errors so one bad account
 * can't block the whole sync cycle.
 */

import { GuardianRegistrationPreflightError } from 'lib/miden/guardian/direct-switch';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import {
  FUSED_SYNC_PROBE_INTERVAL_MS,
  MAX_CONSECUTIVE_WATCHDOG_EVICTIONS,
  monotonicNowMs
} from 'lib/miden/sync-backoff';
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
  PENDING_ROTATION_RECHECK_BACKOFF_MS,
  PENDING_ROTATION_RECHECK_MAX_ATTEMPTS,
  subscribeGuardianSyncOutage,
  SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS,
  SYNC_RATE_LIMIT_MAX_COOLDOWN_MS,
  syncGuardianAccounts,
  zustandProvider
} from './guardian-sync';
import {
  guardianDriftFuseKey,
  guardianSyncFuseKey,
  __resetSyncFuseStateForTests,
  isSyncFused,
  noteSyncWatchdogEviction,
  pendingRotationRecheckFuseKey,
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
  revertGuardianEndpointAfterDiscard: jest.Mock;
  checkGuardianDrift: jest.Mock;
  signTransaction: jest.Mock;
} = {
  accounts: [],
  getPublicKeyForCommitment: jest.fn(),
  signWord: jest.fn(),
  persistNewHotKey: jest.fn(),
  swapHotKey: jest.fn(),
  setGuardianEndpoint: jest.fn(),
  revertGuardianEndpointAfterDiscard: jest.fn(async () => 'reverted'),
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
// The W1 pending-rotation recheck: rows come from Dexie, verdicts from the
// node read. Default: no pending rotations, so every unrelated test skips it.
// `id` is the local Dexie uuid, `transactionId` the on-chain hash — two fields
// because they are two identifiers, and the recheck asks the node about the
// second while settling the row by the first.
const mockListUnconfirmedSwitchRows = jest.fn(
  async (..._a: unknown[]) =>
    [] as Array<{
      id: string;
      transactionId?: string;
      extraInputs?: { newGuardianEndpoint: string; previousGuardianEndpoint?: string };
    }>
);
const mockResolveUnconfirmedSwitch = jest.fn();
const mockStartBackgroundTransactionProcessing = jest.fn();
jest.mock('lib/miden/transaction', () => ({
  ensureGuardianProcedureThresholds: (...args: unknown[]) => mockEnsureGuardianProcedureThresholds(...args),
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBackgroundTransactionProcessing(...args),
  listUnconfirmedSwitchRows: (...args: unknown[]) => mockListUnconfirmedSwitchRows(...args),
  resolveUnconfirmedSwitch: (...args: unknown[]) => mockResolveUnconfirmedSwitch(...args)
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
// The pre-POST half of `reRegisterCurrentStateOnGuardian` — see the service mock in
// the self-heal suite's `beforeEach`.
const mockPreRegisterHold = jest.fn();
// The self-heal pulls the guardian's own state before deciding whether to push.
const mockAdoptGuardianState = jest.fn();
const mockBuildColdMultisigService = jest.fn();
jest.mock('lib/miden/guardian', () => {
  // The `__authRejection` tag is a convenience for the tests below, but the REAL
  // classifier is kept in the chain: it is the gate that decides whether this
  // device may POST `/configure`, and stubbing it outright meant no test in this
  // suite exercised it — it could have been inverted and everything stayed
  // green. Delegating means a real `{ status: 401 }` drives the path too, which
  // one test below relies on. (A direct table for the classifier itself lives in
  // lib/miden/guardian/index.test.ts.)
  const actual: { isGuardianAuthRejection: (err: unknown) => boolean } = jest.requireActual('lib/miden/guardian');
  return {
    isGuardianAuthRejection: (err: unknown) =>
      (err as { __authRejection?: boolean } | null)?.__authRejection === true || actual.isGuardianAuthRejection(err),
    MultisigService: {
      buildColdMultisigService: (...args: unknown[]) => mockBuildColdMultisigService(...args)
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
const mockReadDirectSwitchCommitState = jest.fn(async (..._a: unknown[]) => 'pending');
jest.mock('lib/miden/guardian/direct-switch', () => ({
  ...jest.requireActual('lib/miden/guardian/direct-switch'),
  finalizeDirectGuardianSwitch: (...args: unknown[]) => mockFinalizeDirectGuardianSwitch(...args),
  readDirectSwitchCommitState: (...args: unknown[]) => mockReadDirectSwitchCommitState(...args)
}));

const mockGetAccount = jest.fn();
// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({ getAccount: (...a: unknown[]) => mockGetAccount(...a) }),
  // The hold is handed to the callback and `assertWasmHoldCurrent` compares
  // against it for real, rather than being stubbed to a no-op — a stub would
  // make every post-await liveness guard in this module vacuously green, which
  // is precisely the property those guards exist to have tested. A test that
  // wants to simulate an eviction reassigns `currentWasmHold`.
  getCurrentWasmLockHold: () => currentWasmHold,
  assertWasmHoldCurrent: (hold: object | null, where: string) => {
    if (hold !== null && currentWasmHold === hold) return;
    throw new WasmClientPoisonedError('watchdog', new Error(`operation abandoned ${where}`));
  },
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
    currentWasmHold = {};
    return fn(currentWasmHold);
  }
}));

let currentWasmHold: object = {};

/**
 * One cursor driving BOTH clocks.
 *
 * The AttemptLedgers read the MONOTONIC clock (`monotonicNowMs` →
 * `performance.now`), the same one the 429 cooldown, the breaker and the sync
 * fuse read; other stamps in this module still read `Date.now()`. A test that
 * moved only `Date.now` was asserting a gap against a clock the budget gate
 * never consults — the ledger saw no time pass at all, so every cadence
 * assertion below would have been measuring the wrong thing.
 */
const useFakeClocks = (start: number) => {
  let now = start;
  const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  const perfSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance: (ms: number): void => {
      now += ms;
    },
    set: (at: number): void => {
      now = at;
    },
    restore: (): void => {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
    }
  };
};

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
    // The trailing `true` is `boundAtSyncCeiling`: this call is reached from the ~3 s
    // loop, so both holds behind it must arm at the sync ceiling rather than the
    // five-minute backstop.
    expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledWith(
      'guardian-heal',
      undefined,
      zustandProvider,
      true
    );
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
      .mockReturnValue(performance.now() + FUSED_SYNC_PROBE_INTERVAL_MS + 1_000);
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

    // …and past the 429's own rate-limit cooldown, which otherwise skips the next lap at
    // the cooldown gate and makes this test vacuous.
    let nowMs = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    nowMs += SYNC_RATE_LIMIT_MAX_COOLDOWN_MS + 1_000;

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
    mockBuildColdMultisigService.mockClear();
    mockReRegister.mockClear();
    mockGetAccount.mockClear();
    mockClearGuardianServiceFor.mockClear();
    mockAdoptGuardianState.mockClear();
    mockAdoptGuardianState.mockResolvedValue(undefined);
    mockPreRegisterHold.mockClear();
    mockPreRegisterHold.mockResolvedValue(undefined);
    mockBuildColdMultisigService.mockResolvedValue({
      // Mirrors the real method's two halves. `reRegisterCurrentStateOnGuardian` takes
      // an entire WASM hold — a `syncState()` and an account read — BEFORE it POSTs,
      // and only then fires `onBeforeRegister`. A mock that ignored the callback made
      // the caller's attempted/preflight split untestable in both directions: nothing
      // could charge the budget, and nothing could evict on the pre-POST side.
      // `mockPreRegisterHold` is that first half, so a test can reject from it to
      // stand in for an eviction during the local sync.
      reRegisterCurrentStateOnGuardian: async (onBeforeRegister?: () => void) => {
        await mockPreRegisterHold();
        onBeforeRegister?.();
        return mockReRegister();
      },
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
    const clock = useFakeClocks(5_000_000);
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
      clock.advance(4 * SELF_HEAL_COOLDOWN_MS);
    });

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i++) await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(1);

    // The next tick lands right after that long attempt. Measured from the start
    // it would be overdue; measured from the finish it is not due yet.
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(1);

    clock.advance(SELF_HEAL_COOLDOWN_MS);
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(2);

    clock.restore();
  });

  // F-137 called the spent budget "the sharp one": with it kept across a
  // rotation, the NEW operator's first 401 re-marks the account unrepairable on a
  // verdict the OLD operator earned, and the ledger refuses
  // forever because the attempt cap is already reached.
  it('gives the new operator its own re-register budget after a rotation', async () => {
    const clock = useFakeClocks(7_000_000);
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
      clock.advance(SELF_HEAL_COOLDOWN_MS);
      await syncGuardianAccounts();
    }
    expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);
    clock.advance(SELF_HEAL_COOLDOWN_MS);
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

    clock.restore();
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
    const clock = useFakeClocks(5_000_000);

    expect(isGuardianUnrepairable('acct-stuck')).toBe(false);
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      await syncGuardianAccounts();
      clock.advance(SELF_HEAL_COOLDOWN_MS);
    }

    expect(isGuardianUnrepairable('acct-stuck')).toBe(true);

    // And a sync that finally lands stands it back down.
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => undefined) });
    await syncGuardianAccounts();
    expect(isGuardianUnrepairable('acct-stuck')).toBe(false);

    clock.restore();
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

    const start = 6_000_000;
    const clock = useFakeClocks(start);
    // Enough refusals to blow a budget of SELF_HEAL_MAX_ATTEMPTS, each past the
    // cooldown so the decision gate itself is not what is holding them back.
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      clock.set(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }
    expect(mockReRegister).not.toHaveBeenCalled();

    // The read recovers: the repair must still be available.
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    clock.set(start + 100 * (SELF_HEAL_COOLDOWN_MS + 1_000));
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(1);
    clock.restore();
  });

  /**
   * WHICH SIDE OF THE POST an eviction lands on decides how it is booked, and
   * the two answers are opposite.
   *
   * Before the `/configure`, nothing was prepared and nothing can land, so
   * charging is the same mistake as charging a local read failure: the budget
   * is only reset by a successful sync, which the stale allowlist is what
   * prevents. After it, the call is ABANDONED rather than cancelled — the POST
   * may still arrive — so a refund would let the next tick prepare a second one.
   */
  it('refunds an eviction that landed before the /configure', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    // The stale-account read is the first hold the self-heal takes, well ahead
    // of any operator traffic.
    mockGetAccount.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    storeState.accounts = [
      { publicKey: 'acct-preflight-evict', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    const start = 7_000_000;
    const clock = useFakeClocks(start);
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      clock.set(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }
    expect(mockReRegister).not.toHaveBeenCalled();
    // Nothing about the OPERATOR was established, so the account must not be
    // presented as beyond automatic repair.
    expect(isGuardianUnrepairable('acct-preflight-evict')).toBe(false);

    // The client recovers: the repair is still available, budget unspent.
    mockGetAccount.mockResolvedValue({ __sdkAccount: true });
    clock.set(start + 100 * (SELF_HEAL_COOLDOWN_MS + 1_000));
    await syncGuardianAccounts();
    expect(mockReRegister).toHaveBeenCalledTimes(1);
    clock.restore();
  });

  it('charges an eviction that landed after the /configure was sent', async () => {
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    mockReRegister.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    storeState.accounts = [
      { publicKey: 'acct-post-evict', type: WalletType.Guardian, hotPublicKey: 'hot', coldPublicKey: 'cold' }
    ] as never;

    const start = 7_500_000;
    const clock = useFakeClocks(start);
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS + 2; i++) {
      clock.set(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }

    // Bounded: the abandoned POST may have landed, so the budget is spent
    // rather than re-prepared on every tick.
    expect(mockReRegister).toHaveBeenCalledTimes(SELF_HEAL_MAX_ATTEMPTS);
    clock.restore();
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

    const start = 6_500_000;
    const clock = useFakeClocks(start);
    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i++) {
      clock.set(start + i * (SELF_HEAL_COOLDOWN_MS + 1_000));
      await syncGuardianAccounts();
    }

    expect(mockReRegister).not.toHaveBeenCalled();
    expect(mockAdoptGuardianState).toHaveBeenCalledTimes(1);
    clock.restore();
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
    const now = performance.now();
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
    const now = performance.now();
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
    const now = performance.now();
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

  // The preflight hold inside `finalizeDirectGuardianSwitch` is reached from the
  // 3 s loop, so it takes the sync ceiling and a label rather than the five-minute
  // backstop reserved for writes a user is waiting on. Asserted alongside the
  // other arguments because the same function is ALSO called from the completion
  // path, which correctly passes nothing — the options are what distinguish the
  // timer-driven caller.
  const PREFLIGHT_LOCK_OPTIONS = { watchdogMs: 120_000, label: 'guardian-missing-registration' };

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
    mockResolveGuardianEndpoint.mockImplementation(resolveEndpointDefault);
    mockResolveChosenGuardianEndpoint.mockImplementation(resolveChosenDefault);
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
      expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith(
        'unregistered-pk',
        endpoint,
        zustandProvider,
        PREFLIGHT_LOCK_OPTIONS
      );
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
      PREFLIGHT_LOCK_OPTIONS
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
    const clock = useFakeClocks(1_000_000);
    mockGetSignerDetails.mockRejectedValue(new Error('signer slot unreadable'));

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

    // A refusal DID stamp the clock, so the same instant buys nothing…
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();

    // …but the first backoff gap is the one an unspent budget gets, not a
    // doubled one, and the attempt is still available.
    clock.set(1_000_000 + MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledWith(
      'unregistered-pk',
      endpoint,
      zustandProvider,
      PREFLIGHT_LOCK_OPTIONS
    );

    clock.restore();
  });

  /**
   * The snapshot hold is the one whose eviction the caller most needs to hear
   * about, and it had no way to say so: it sits outside the only `try` in the
   * function (which wraps the `/configure`), so poison threw straight out —
   * past the `Promise<boolean>` = "evicted" contract, and out of the account
   * loop's own `catch`, because a throw raised inside a `catch` is not caught by
   * its own `try`. The pass stopped by accident, the promise it rejected was
   * discarded by both callers, and the eviction was never booked.
   */
  describe('when the snapshot hold is evicted', () => {
    const secondAccount = { publicKey: 'other-pk', type: WalletType.Guardian, hotPublicKey: 'hot2' };

    beforeEach(() => {
      __resetSyncFuseStateForTests();
      storeState.accounts = [account, secondAccount] as never;
      mockGetAccount.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    });

    it('stops the pass instead of rejecting a promise nobody reads', async () => {
      // Two accounts and a persistent verdict on the first, so the loop would
      // otherwise carry on and take fresh holds on a client the mutex has
      // already handed to a successor.
      mockGetOrCreateMultisigService.mockClear();
      await runUntilPersistent();

      // Both accounts on every pass that did not reach the self-heal, and then
      // only the FIRST on the pass that did — the eviction breaks the loop
      // before the second account's round trip.
      expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(
        (MISSING_REGISTRATION_PERSISTENCE_THRESHOLD - 1) * 2 + 1
      );
      expect(mockGetOrCreateMultisigService).not.toHaveBeenCalledWith(
        expect.objectContaining({ publicKey: secondAccount.publicKey }),
        expect.anything()
      );
      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
    });

    it('books the eviction, which the loop-breaking caller cannot do for it', async () => {
      for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; pass += 1) {
        await runUntilPersistent();
      }

      expect(isSyncFused(guardianSyncFuseKey(account.publicKey, endpoint))).toBe(true);
    });

    // A read that merely FAILED is not an eviction: the client is fine, so the
    // pass carries on and the account is simply not repaired this tick.
    it('lets the pass continue when the read fails ordinarily', async () => {
      mockGetAccount.mockRejectedValue(new Error('storage read failed'));
      mockGetOrCreateMultisigService.mockClear();

      await runUntilPersistent();

      expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(MISSING_REGISTRATION_PERSISTENCE_THRESHOLD * 2);
      expect(mockFinalizeDirectGuardianSwitch).not.toHaveBeenCalled();
    });
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
    const clock = useFakeClocks(t0);

    await expect(runUntilPersistent()).resolves.toBeUndefined();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    clock.set(t0 + MISSING_REGISTRATION_BACKOFF_MS - 1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    const t1 = t0 + MISSING_REGISTRATION_BACKOFF_MS;
    clock.set(t1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    // The gap doubles, so the second wait is twice the first.
    const t2 = t1 + 2 * MISSING_REGISTRATION_BACKOFF_MS;
    clock.set(t2 - 1);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    clock.set(t2);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);

    // Capped: an operator that keeps refusing a registration it also says it
    // needs will not be resolved by further `/configure` calls.
    clock.set(t2 + 100 * MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);

    clock.restore();
  });

  // The cooldown is measured from when an attempt SETTLED, not from when it
  // started. `finalizeDirectGuardianSwitch` carries eight 30s `/configure`
  // deadlines plus backoff, so an attempt can easily outlast its own gap — and
  // with a pre-attempt stamp, one that does is already "due" the instant it
  // returns. That spent the entire budget back-to-back, with no pause at all,
  // against an operator whose only fault was being slow.
  it('measures the gap from when the attempt finished, so a slow push still buys its cooldown', async () => {
    const clock = useFakeClocks(1_000_000);
    // Each push takes four minutes — longer than both gaps in the schedule.
    const pushDurationMs = 4 * MISSING_REGISTRATION_BACKOFF_MS;
    mockFinalizeDirectGuardianSwitch.mockImplementation(async () => {
      clock.advance(pushDurationMs);
      throw new Error('configure rejected');
    });

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    // The next tick lands immediately after that four-minute push. Measured from
    // the START it would be overdue; measured from the finish it is not due yet.
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    clock.advance(MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    // Same again for the doubled second gap.
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    clock.advance(2 * MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS);

    clock.restore();
  });

  // A refusal that never reached the operator does not spend an attempt, but it
  // still has to stamp the clock from its own finish — the probe behind it is an
  // HTTP round trip, and an unstamped refusal re-runs it on every ~3s tick.
  it('stamps a refunded attempt from its finish too', async () => {
    const clock = useFakeClocks(1_000_000);
    mockFinalizeDirectGuardianSwitch.mockImplementation(async () => {
      clock.advance(4 * MISSING_REGISTRATION_BACKOFF_MS);
      throw new GuardianRegistrationPreflightError('account state read back incomplete');
    });

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    clock.advance(MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);

    clock.restore();
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
    const clock = useFakeClocks(1_000_000);

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    // Well past the cap a spent budget would have hit.
    for (let i = 0; i < MISSING_REGISTRATION_MAX_ATTEMPTS + 3; i++) {
      clock.advance(MISSING_REGISTRATION_BACKOFF_MS);
      await syncGuardianAccounts();
    }
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS + 4);

    // Still rate-limited, though — the refusal stamps the clock, so the 3s tick
    // behind it does not re-read every time.
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS + 4);

    // And once the read comes back complete, the repair still works.
    mockFinalizeDirectGuardianSwitch.mockResolvedValue(undefined);
    clock.advance(MISSING_REGISTRATION_BACKOFF_MS);
    await syncGuardianAccounts();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(MISSING_REGISTRATION_MAX_ATTEMPTS + 5);

    clock.restore();
  });

  // The budget is keyed by what the push would WRITE, so a second rotation in the
  // same session is not silently skipped by the first one's spent attempts.
  it('re-arms for a rotation to a different endpoint in the same session', async () => {
    const clock = useFakeClocks(1_000_000);

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
      PREFLIGHT_LOCK_OPTIONS
    );
    clock.restore();
  });

  // The threshold does not exist to establish that the account is unregistered —
  // it exists to rule out a TRANSIENT verdict, since `data_unavailable` is a
  // server-side condition that can blip. Verdicts inherited across a rotation
  // therefore let a single blip from the new operator authorize a `/configure`
  // that overwrites its authoritative copy of a private account's state, and the
  // guardian-key guard does not cover it: that proves WHO the operator is, not
  // that its answer persists.
  it('does not let verdicts earned by the previous operator authorize a push to the new one', async () => {
    const clock = useFakeClocks(1_000_000);

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
      PREFLIGHT_LOCK_OPTIONS
    );
    clock.restore();
  });

  it('re-arms when the same endpoint installs a new guardian key', async () => {
    const clock = useFakeClocks(1_000_000);

    await runUntilPersistent();
    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(1);

    mockGetGuardianCommitmentFromAccount.mockReturnValue('rotatedoperatorkey');
    await syncGuardianAccounts();

    expect(mockFinalizeDirectGuardianSwitch).toHaveBeenCalledTimes(2);
    clock.restore();
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
    const clock = useFakeClocks(1_000_000);
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
    clock.restore();
  });
});

describe('syncGuardianAccounts — pending-rotation recheck (the W1 exit)', () => {
  const account = { publicKey: 'pending-pk', type: WalletType.Guardian, hotPublicKey: 'hot' };

  beforeEach(() => {
    __resetGuardianSyncOutageForTest();
    storeState.accounts = [account] as never;
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => undefined) });
    mockListUnconfirmedSwitchRows.mockReset();
    // The row id and the on-chain hash are DIFFERENT strings here on purpose.
    // While the fixture conflated them, a loop that asked the node about the
    // Dexie uuid was indistinguishable from one that asked about the hash — and
    // that is the bug the fixture hid: `getTransactionCommitState` matches
    // `tx.id().toHex()`, so a row id can only ever answer 'not-found'.
    mockListUnconfirmedSwitchRows.mockResolvedValue([{ id: 'row-w1', transactionId: '0xtxw1' }]);
    mockResolveUnconfirmedSwitch.mockReset();
    mockResolveUnconfirmedSwitch.mockResolvedValue({});
    mockReadDirectSwitchCommitState.mockReset();
    storeState.revertGuardianEndpointAfterDiscard.mockReset();
    storeState.revertGuardianEndpointAfterDiscard.mockResolvedValue('reverted');
  });

  it('upgrades the row once the chain confirms the rotation', async () => {
    mockReadDirectSwitchCommitState.mockResolvedValue('committed');

    await syncGuardianAccounts();

    // The node is asked about the HASH…
    expect(mockReadDirectSwitchCommitState).toHaveBeenCalledWith(
      '0xtxw1',
      expect.objectContaining({ label: 'pending-rotation-recheck' })
    );
    // …and the local row is settled by its own id.
    expect(mockResolveUnconfirmedSwitch).toHaveBeenCalledWith('row-w1', true);
  });

  it('demotes the row once the chain reports the rotation discarded', async () => {
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      {
        id: 'row-w1',
        transactionId: '0xtxw1',
        extraInputs: {
          newGuardianEndpoint: 'https://new.guardian.test',
          previousGuardianEndpoint: 'https://old.guardian.test'
        }
      }
    ]);

    await syncGuardianAccounts();

    expect(mockResolveUnconfirmedSwitch).toHaveBeenCalledWith('row-w1', false);
  });

  // A row written before the completion started stamping the previous endpoint.
  // Demoting it spends the one irreversible settle on a state whose only repair
  // is the rollback this row cannot supply — and drift cannot substitute, since
  // its baseline and the chain agree (both still the old operator) so it never
  // reads the endpoint the account is actually bound to. The account would be
  // left naming an operator with no authority and looking healthy everywhere.
  it('refuses to demote a discarded rotation it has no rollback target for', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      { id: 'row-legacy', transactionId: '0xtxlegacy', extraInputs: { newGuardianEndpoint: 'https://new.test' } }
    ]);

    await syncGuardianAccounts();

    expect(mockResolveUnconfirmedSwitch).not.toHaveBeenCalled();
    expect(storeState.revertGuardianEndpointAfterDiscard).not.toHaveBeenCalled();
    // Closed rather than charged — no later tick can grow a field the completion
    // did not write — so the prompt is up on the next pass, not in 30 minutes.
    await syncGuardianAccounts();
    expect(isGuardianUnrepairable('pending-pk')).toBe(true);
  });

  // `'stale'` is not only the lost-CAS race: the rollback also answers it when
  // the operator could not be reached to prove the mismatch, which for a
  // rotation discarded to a dead endpoint is the answer on EVERY pass. Left
  // unsettled, the retry never ends and the budget never spends, so the prompt
  // that is this exit's only other way out is unreachable.
  it('charges a rollback that keeps answering stale, so exhaustion surfaces it', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      {
        id: 'row-w1',
        transactionId: '0xtxw1',
        extraInputs: {
          newGuardianEndpoint: 'https://new.guardian.test',
          previousGuardianEndpoint: 'https://old.guardian.test'
        }
      }
    ]);
    storeState.revertGuardianEndpointAfterDiscard.mockResolvedValue('stale');
    const clock = useFakeClocks(11_000_000);

    for (let pass = 0; pass <= PENDING_ROTATION_RECHECK_MAX_ATTEMPTS; pass += 1) {
      await syncGuardianAccounts();
      clock.advance(PENDING_ROTATION_RECHECK_BACKOFF_MS);
    }

    expect(mockResolveUnconfirmedSwitch).not.toHaveBeenCalled();
    expect(isGuardianUnrepairable('pending-pk')).toBe(true);
    clock.restore();
  });

  // Completion pointed the vault at the new operator before it knew the commit
  // was unconfirmed, so a discarded rotation leaves the account naming an
  // operator with NO on-chain authority — and the drift reconciler cannot see it
  // (its cached baseline and the chain agree, both still naming the old one).
  // Demoting the row without this leaves the account quietly unusable.
  it('points the account back at the previous operator when the node discards the rotation', async () => {
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      {
        id: 'row-w1',
        transactionId: '0xtxw1',
        extraInputs: {
          newGuardianEndpoint: 'https://new.guardian.test',
          previousGuardianEndpoint: 'https://old.guardian.test'
        }
      }
    ]);

    await syncGuardianAccounts();

    // Conditional, not a force write: the rollback names the endpoint it expects
    // to still be bound, so a rotation that landed since cannot be undone.
    expect(storeState.revertGuardianEndpointAfterDiscard).toHaveBeenCalledWith(
      'pending-pk',
      'https://new.guardian.test',
      'https://old.guardian.test'
    );
  });

  // The demote is the point of no return — a demoted row answers 'failed' and
  // leaves the unconfirmed list, so a rollback attempted after it has nothing
  // left to re-derive from. The vault write has to come first.
  it('rolls the binding back BEFORE it demotes the row', async () => {
    const order: string[] = [];
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      {
        id: 'row-w1',
        transactionId: '0xtxw1',
        extraInputs: {
          newGuardianEndpoint: 'https://new.guardian.test',
          previousGuardianEndpoint: 'https://old.guardian.test'
        }
      }
    ]);
    storeState.revertGuardianEndpointAfterDiscard.mockImplementation(async () => {
      order.push('revert');
      return 'reverted';
    });
    mockResolveUnconfirmedSwitch.mockImplementation(async () => {
      order.push('demote');
      return {};
    });

    await syncGuardianAccounts();

    expect(order).toEqual(['revert', 'demote']);
  });

  // A rotation that legitimately landed while the discarded one was being
  // rechecked moves the binding out from under the rollback. Demoting the row
  // anyway would leave the newer, correct endpoint intact but lose the retry;
  // leaving it pending re-derives against the new state next pass.
  it('leaves the row pending when the binding moved under the rollback', async () => {
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      {
        id: 'row-w1',
        transactionId: '0xtxw1',
        extraInputs: {
          newGuardianEndpoint: 'https://new.guardian.test',
          previousGuardianEndpoint: 'https://old.guardian.test'
        }
      }
    ]);
    storeState.revertGuardianEndpointAfterDiscard.mockResolvedValue('stale');

    await syncGuardianAccounts();

    expect(mockResolveUnconfirmedSwitch).not.toHaveBeenCalled();
  });

  // Nothing to roll back: something authoritative already moved the binding off
  // this rotation's target, so the row is all that is left to settle.
  it('still demotes the row when the rollback is superseded', async () => {
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      {
        id: 'row-w1',
        transactionId: '0xtxw1',
        extraInputs: {
          newGuardianEndpoint: 'https://new.guardian.test',
          previousGuardianEndpoint: 'https://old.guardian.test'
        }
      }
    ]);
    storeState.revertGuardianEndpointAfterDiscard.mockResolvedValue('superseded');

    await syncGuardianAccounts();

    expect(mockResolveUnconfirmedSwitch).toHaveBeenCalledWith('row-w1', false);
  });

  // A row whose hash was never captured can never be asked about: the stamp
  // happens once, in the completion that already ran. Spending 30 minutes of
  // rechecks to reach a conclusion available now is the shape F-001 produced.
  it('closes the recheck immediately for a row with no captured transaction id', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockListUnconfirmedSwitchRows.mockResolvedValue([{ id: 'row-nohash' }]);
    mockReadDirectSwitchCommitState.mockResolvedValue('committed');

    await syncGuardianAccounts();

    expect(mockReadDirectSwitchCommitState).not.toHaveBeenCalled();
    expect(mockResolveUnconfirmedSwitch).not.toHaveBeenCalled();
    // Closed, not merely skipped: the state is surfaced for manual recovery.
    await syncGuardianAccounts();
    expect(isGuardianUnrepairable('pending-pk')).toBe(true);
  });

  it('a non-verdict spends one bounded recheck and re-asks on the flat cadence', async () => {
    const clock = useFakeClocks(9_000_000);
    mockReadDirectSwitchCommitState.mockResolvedValue('pending');

    await syncGuardianAccounts();
    expect(mockReadDirectSwitchCommitState).toHaveBeenCalledTimes(1);

    // Inside the gap: no second read, and no resolution invented.
    await syncGuardianAccounts();
    expect(mockReadDirectSwitchCommitState).toHaveBeenCalledTimes(1);
    expect(mockResolveUnconfirmedSwitch).not.toHaveBeenCalled();

    clock.advance(PENDING_ROTATION_RECHECK_BACKOFF_MS);
    await syncGuardianAccounts();
    expect(mockReadDirectSwitchCommitState).toHaveBeenCalledTimes(2);
    clock.restore();
  });

  it('a read failure is refunded, not charged — the budget is spent on answers, not on outages', async () => {
    const clock = useFakeClocks(9_500_000);
    mockReadDirectSwitchCommitState.mockRejectedValue(new Error('node unreachable'));

    for (let i = 0; i < PENDING_ROTATION_RECHECK_MAX_ATTEMPTS + 3; i++) {
      await syncGuardianAccounts();
      clock.advance(PENDING_ROTATION_RECHECK_BACKOFF_MS);
    }
    // Still asking (refunds never spend the budget), and never unrepairable.
    expect(mockReadDirectSwitchCommitState.mock.calls.length).toBeGreaterThan(PENDING_ROTATION_RECHECK_MAX_ATTEMPTS);
    expect(isGuardianUnrepairable('pending-pk')).toBe(false);
    clock.restore();
  });

  it('a spent budget surfaces through the unrepairable prompt instead of going silent', async () => {
    const clock = useFakeClocks(10_000_000);
    mockReadDirectSwitchCommitState.mockResolvedValue('not-found');

    for (let i = 0; i < PENDING_ROTATION_RECHECK_MAX_ATTEMPTS; i++) {
      await syncGuardianAccounts();
      clock.advance(PENDING_ROTATION_RECHECK_BACKOFF_MS);
    }
    expect(mockReadDirectSwitchCommitState).toHaveBeenCalledTimes(PENDING_ROTATION_RECHECK_MAX_ATTEMPTS);

    await syncGuardianAccounts();
    expect(mockReadDirectSwitchCommitState).toHaveBeenCalledTimes(PENDING_ROTATION_RECHECK_MAX_ATTEMPTS);
    expect(isGuardianUnrepairable('pending-pk')).toBe(true);
    clock.restore();
  });
});

/**
 * The eviction seam.
 *
 * An evicted operation is ABANDONED, NOT CANCELLED: the mutex is handed to a
 * successor the instant the watchdog fires, while the abandoned call is still
 * inside WASM holding a borrow. So every hold this pass would take next is a
 * second borrow of somebody else's client, and the rule is that the whole pass
 * stops — not just the arm that noticed.
 *
 * Every one of these guards was previously deletable with the suite still green:
 * nothing threw `WasmClientPoisonedError` from any of the four calls that can
 * actually produce one, so the breaks were unexercised. Each test below deletes
 * one guard's reason for existing and asserts the pass notices.
 */
describe('syncGuardianAccounts — a WASM eviction stops the whole pass', () => {
  const first = { publicKey: 'evict-pk-1', type: WalletType.Guardian, hotPublicKey: 'hot-1' };
  const second = { publicKey: 'evict-pk-2', type: WalletType.Guardian, hotPublicKey: 'hot-2' };

  beforeEach(() => {
    __resetGuardianSyncOutageForTest();
    // The fuse ledger is realm-scoped and these tests deliberately park it, so
    // without this each test inherits the previous one's evidence — and a test
    // asserting that a key is NOT lit then reads a sibling's park as its own.
    __resetSyncFuseStateForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    storeState.accounts = [first, second] as never;
    storeState.checkGuardianDrift.mockReset();
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
    mockGetOrCreateMultisigService.mockReset();
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => undefined) });
    mockListUnconfirmedSwitchRows.mockReset();
    mockListUnconfirmedSwitchRows.mockResolvedValue([]);
    mockResolveUnconfirmedSwitch.mockReset();
    mockResolveUnconfirmedSwitch.mockResolvedValue({});
    mockReadDirectSwitchCommitState.mockReset();
    storeState.revertGuardianEndpointAfterDiscard.mockReset();
  });

  // The recheck's own row loop. Row two must never be read: the abandoned call
  // from row one still holds a borrow of the client row two would take.
  it('stops reading rows after the node read is evicted', async () => {
    storeState.accounts = [first] as never;
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      { id: 'row-a', transactionId: '0xa' },
      { id: 'row-b', transactionId: '0xb' }
    ]);
    mockReadDirectSwitchCommitState.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));

    await syncGuardianAccounts();

    expect(mockReadDirectSwitchCommitState).toHaveBeenCalledTimes(1);
  });

  // …and the account loop. Breaking only the row loop left drift, the guardian
  // round trip and the self-heal still to run on the same abandoned client.
  it('does not touch the next account after the recheck is evicted', async () => {
    mockListUnconfirmedSwitchRows.mockResolvedValue([{ id: 'row-a', transactionId: '0xa' }]);
    mockReadDirectSwitchCommitState.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await syncGuardianAccounts();

    expect(storeState.checkGuardianDrift).not.toHaveBeenCalled();
    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
  });

  // The rollback takes a hold of ITS OWN, so its eviction arrives in a different
  // catch from the node read's — one that first shipped without classifying it.
  it('stops the pass when the endpoint rollback is evicted', async () => {
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      {
        id: 'row-a',
        transactionId: '0xa',
        extraInputs: { newGuardianEndpoint: 'https://new.test', previousGuardianEndpoint: 'https://old.test' }
      }
    ]);
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    storeState.revertGuardianEndpointAfterDiscard.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await syncGuardianAccounts();

    expect(storeState.checkGuardianDrift).not.toHaveBeenCalled();
    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
  });

  // The node read SUCCEEDED before the rollback evicted, so `probeSucceeded` was
  // set — and booking that success would withdraw the very fuse evidence the
  // eviction just created, on the key that is supposed to stop us re-parking.
  it('does not book a fuse success for a pass whose rollback evicted', async () => {
    storeState.accounts = [first] as never;
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      {
        id: 'row-a',
        transactionId: '0xa',
        extraInputs: { newGuardianEndpoint: 'https://new.test', previousGuardianEndpoint: 'https://old.test' }
      }
    ]);
    mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
    storeState.revertGuardianEndpointAfterDiscard.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; pass += 1) {
      __resetGuardianSyncOutageForTest();
      await syncGuardianAccounts();
    }

    expect(isSyncFused(pendingRotationRecheckFuseKey(first.publicKey))).toBe(true);
  });

  // Drift's catch is deliberately swallowing — a drift failure must not break
  // the loop — which is exactly why an eviction had to be pulled back out of it.
  it('does not touch the next account after drift is evicted', async () => {
    storeState.checkGuardianDrift.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await syncGuardianAccounts();

    expect(storeState.checkGuardianDrift).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
  });

  // THE GUARDIAN ROUND TRIP ITSELF. `service.sync()` builds its service under a
  // frontend hold at the sync ceiling, so this arm is as real as the other three
  // — and it was the last one that went on to the next account regardless.
  it('does not touch the next account after the guardian round trip is evicted', async () => {
    mockGetOrCreateMultisigService.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(1);
  });

  /**
   * Every break must ALSO book its evidence.
   *
   * Three of the four breaks jump out of the loop from a point above (or inside
   * the catch and before) the fuse feed at the bottom, so the report cannot be
   * left to it — and for two of them the value the feed would have classified is
   * not the poison at all but the operator's own 401/unknown-account response,
   * which reads as a NON-eviction failure and therefore ZEROES the count. That is
   * strictly worse than silence: the arms most likely to park were the ones
   * erasing the evidence.
   */
  describe('and books the eviction against the account fuse', () => {
    const fuseKeyFor = (pk: string) => guardianSyncFuseKey(pk, 'https://guardian.test');

    const parkUntilFused = async (arm: () => void) => {
      storeState.accounts = [first] as never;
      arm();
      for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; pass += 1) {
        __resetGuardianSyncOutageForTest();
        await syncGuardianAccounts();
      }
    };

    // Drift books against a key OF ITS OWN, not the account's guardian key, and
    // the split is what keeps the account reachable. Drift talks to the NODE
    // while the guardian round trip talks to the OPERATOR, so a parked node and
    // a parked operator are two independent facts — and shared, the one that
    // succeeds withdraws the other's evidence within the same lap.
    it('when drift evicts, against the drift key', async () => {
      await parkUntilFused(() =>
        storeState.checkGuardianDrift.mockRejectedValue(new WasmClientPoisonedError('watchdog'))
      );

      expect(isSyncFused(guardianDriftFuseKey(first.publicKey))).toBe(true);
    });

    // The starvation this key exists to end: drift ran UNCONDITIONALLY and broke
    // the account loop on eviction, so with drift parked, every account after the
    // first never synced again for the life of the realm — a permanent outage
    // produced by the eviction handling rather than by the operator.
    it('lets the rest of the pass run once drift itself is fused', async () => {
      await parkUntilFused(() =>
        storeState.checkGuardianDrift.mockRejectedValue(new WasmClientPoisonedError('watchdog'))
      );
      storeState.checkGuardianDrift.mockClear();
      mockGetOrCreateMultisigService.mockClear();

      await syncGuardianAccounts();

      // Drift is SKIPPED rather than retried-and-evicted, so nothing breaks the
      // loop and the operator is reached again. Without the fuse this account
      // re-parked the client every three seconds and never got past drift.
      expect(storeState.checkGuardianDrift).not.toHaveBeenCalled();
      expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(1);
    });

    // The starvation this key exists to end, stated as the property that matters:
    // an account BEHIND a permanently-evicting drift is eventually reached. Drift
    // ran unconditionally and broke the loop, so account two never synced again
    // for the life of the realm — an outage produced by the eviction handling
    // rather than by any operator. The keys are per account, so the recovery is
    // sequential (each account's drift accumulates its own evidence), which is
    // the same rule that keeps a healthy sibling from erasing a parked one's.
    it('eventually reaches an account queued behind a permanently-evicting drift', async () => {
      storeState.accounts = [first, second] as never;
      storeState.checkGuardianDrift.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

      for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS * 2; pass += 1) {
        __resetGuardianSyncOutageForTest();
        await syncGuardianAccounts();
      }
      mockGetOrCreateMultisigService.mockClear();
      await syncGuardianAccounts();

      expect(isSyncFused(guardianDriftFuseKey(second.publicKey))).toBe(true);
      expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(2);
    });

    // The guardian round trip still books against the ACCOUNT key, so a healthy
    // node with a parked operator fuses the account without touching drift.
    it('keeps the two keys independent', async () => {
      await parkUntilFused(() =>
        mockGetOrCreateMultisigService.mockRejectedValue(new WasmClientPoisonedError('watchdog'))
      );

      expect(isSyncFused(fuseKeyFor(first.publicKey))).toBe(true);
      expect(isSyncFused(guardianDriftFuseKey(first.publicKey))).toBe(false);
    });

    it('when the guardian round trip evicts', async () => {
      await parkUntilFused(() =>
        mockGetOrCreateMultisigService.mockRejectedValue(new WasmClientPoisonedError('watchdog'))
      );

      expect(isSyncFused(fuseKeyFor(first.publicKey))).toBe(true);
    });
  });
});

/**
 * The invariants a mutation probe showed were NOT under test.
 *
 * Seven of this module's eviction and fuse guards were deleted at once — the two
 * post-await `assertWasmHoldCurrent` calls, drift's success booking, the
 * evicted-probe suppression on the recheck's success arm, the read arm's
 * non-eviction split, the exhausted-row preference, and the outer catch's poison
 * report — and all 606 suites / 10,080 tests still passed. A guard nothing can
 * fail is documentation, not a guard, so each test here removes exactly one of
 * those reasons-to-exist and asserts the pass notices.
 *
 * The shapes that made them survivable are worth naming, because they are the
 * traps a future test in this area will fall into as well:
 *
 *  - The liveness guards need an eviction DURING a hold, not before it. Nothing
 *    reassigned `currentWasmHold` from inside a mocked WASM call, so every
 *    post-await re-check compared a hold against itself and passed.
 *  - The fuse arms need a REALM-ERROR poison. Every existing eviction test uses
 *    `'watchdog'`, which trips the first arm of the recheck's three-way booking
 *    and hides both of the others.
 */
describe('syncGuardianAccounts — guards a mutation probe found unexercised', () => {
  const only = { publicKey: 'mut-pk-1', type: WalletType.Guardian, hotPublicKey: 'hot-1', coldPublicKey: 'cold-1' };
  const other = { publicKey: 'mut-pk-2', type: WalletType.Guardian, hotPublicKey: 'hot-2', coldPublicKey: 'cold-2' };
  const authError = { __authRejection: true, message: '401 session expired' };

  beforeEach(() => {
    __resetGuardianSyncOutageForTest();
    __resetSyncFuseStateForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    storeState.accounts = [only, other] as never;
    storeState.checkGuardianDrift.mockReset();
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
    storeState.revertGuardianEndpointAfterDiscard.mockReset();
    mockGetOrCreateMultisigService.mockReset();
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => undefined) });
    mockListUnconfirmedSwitchRows.mockReset();
    mockListUnconfirmedSwitchRows.mockResolvedValue([]);
    mockResolveUnconfirmedSwitch.mockReset();
    mockResolveUnconfirmedSwitch.mockResolvedValue({});
    mockReadDirectSwitchCommitState.mockReset();
    mockEnsureGuardianProcedureThresholds.mockReset();
    mockEnsureGuardianProcedureThresholds.mockResolvedValue(undefined);
    mockGetAccount.mockReset();
    mockGetAccount.mockResolvedValue({ __sdkAccount: true });
    mockGetSignerDetails.mockReset();
    mockGetSignerDetails.mockResolvedValue({ commitment: 'aabb' });
    mockCommitmentFromPublicKeyHex.mockReset();
    mockCommitmentFromPublicKeyHex.mockResolvedValue('0xAABB');
    mockPreRegisterHold.mockReset();
    mockPreRegisterHold.mockResolvedValue(undefined);
    mockReRegister.mockReset();
    mockReRegister.mockResolvedValue(undefined);
    mockAdoptGuardianState.mockReset();
    mockAdoptGuardianState.mockResolvedValue(undefined);
    mockBuildColdMultisigService.mockReset();
    mockBuildColdMultisigService.mockResolvedValue({
      reRegisterCurrentStateOnGuardian: async (onBeforeRegister?: () => void) => {
        await mockPreRegisterHold();
        onBeforeRegister?.();
        return mockReRegister();
      },
      adoptGuardianStateOnce: mockAdoptGuardianState
    });
  });

  /**
   * An eviction that lands INSIDE a hold, between the account read and the reads
   * derived from it. The mocked `withWasmClientLock` installs a fresh hold object
   * and hands it to the callback; reassigning `currentWasmHold` from inside a
   * mocked WASM call is therefore exactly what the watchdog does when it gives
   * the mutex to a successor — and it is the one thing no existing test did, which
   * is why both post-await guards were deletable.
   */
  const stealTheHoldOnCall = (call: number) => {
    let seen = 0;
    mockGetAccount.mockImplementation(async () => {
      seen += 1;
      if (seen === call) currentWasmHold = {};
      return { __sdkAccount: true };
    });
  };

  // The cold re-register's snapshot hold. `getSignerDetailsFromAccount` reads the
  // signer set off the SAME `Account` handle the line above returned, and that
  // handle is a borrow of the client's RefCell rather than a snapshot — so with
  // the mutex already handed on, reading it is the double borrow. The guard also
  // has to be the thing that reports: the inner read swallows its own error, so
  // without it the double borrow landed as "could not read the hot signer" and
  // the heal refused quietly.
  it('stops the cold re-register when the client is evicted after its account read', async () => {
    storeState.accounts = [only, other] as never;
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    // Call 1 is the stale-account read, call 2 the snapshot hold this guard sits in.
    stealTheHoldOnCall(2);

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD; i += 1) {
      await syncGuardianAccounts();
    }

    // Never reached the operator: the guard threw before the signer comparison, so
    // the heal is an eviction rather than a refusal — and the pass stops, leaving
    // the second account untouched rather than taking a fresh hold under the
    // abandoned call.
    expect(mockReRegister).not.toHaveBeenCalled();
    expect(mockBuildColdMultisigService).toHaveBeenCalledTimes(1);
  });

  // An eviction on the PREFLIGHT side of the `/configure` must refund. The flag
  // used to be set before the call, so it also covered everything
  // `reRegisterCurrentStateOnGuardian` does before it POSTs — an entire hold whose
  // first act is a `syncState()`, the likeliest park on the path. A refund is not a
  // nicety: this budget is only refilled by a successful sync, which is precisely
  // what a parked client prevents, and three local failures would otherwise
  // condemn a healthy operator as unrepairable.
  it('refunds the self-heal budget when the eviction lands before the /configure', async () => {
    storeState.accounts = [only] as never;
    mockGetOrCreateMultisigService.mockResolvedValue({
      sync: jest.fn(async () => {
        throw authError;
      })
    });
    mockPreRegisterHold.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    for (let i = 0; i < SELF_HEAL_AUTH_FAILURE_THRESHOLD + SELF_HEAL_MAX_ATTEMPTS; i += 1) {
      __resetGuardianSyncOutageForTest();
      await syncGuardianAccounts();
    }

    // The POST never went out, so nothing was charged and nothing is condemned.
    expect(mockReRegister).not.toHaveBeenCalled();
    expect(isGuardianUnrepairable(only.publicKey)).toBe(false);
  });

  // Drift's success is the ONLY thing that clears its fuse. Deleted, a drift probe
  // that recovered stayed fused for the full window, and since drift is the
  // repair for a rotation that lost its endpoint write, that is the reconciler
  // being silenced by its own throttle.
  it('clears the drift fuse when drift finally succeeds', async () => {
    storeState.accounts = [only] as never;
    storeState.checkGuardianDrift.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; pass += 1) {
      __resetGuardianSyncOutageForTest();
      await syncGuardianAccounts();
    }
    expect(isSyncFused(guardianDriftFuseKey(only.publicKey))).toBe(true);

    // A user gesture buys one probe through the fuse; that probe now succeeds.
    __resetSyncFuseStateForTests();
    storeState.checkGuardianDrift.mockReset();
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
    await syncGuardianAccounts();
    // Re-park once. With the success booked, the evidence was withdrawn, so one
    // eviction is nowhere near the threshold. Without it, the count survived and
    // this single eviction re-lights the fuse.
    storeState.checkGuardianDrift.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; pass += 1) {
      __resetGuardianSyncOutageForTest();
      await syncGuardianAccounts();
    }

    expect(isSyncFused(guardianDriftFuseKey(only.publicKey))).toBe(false);
  });

  /**
   * The recheck's three-way booking, driven by a REALM-ERROR poison.
   *
   * Both surviving mutants here needed the same key: a poison whose reason is not
   * `'watchdog'`. `isSyncWatchdogEviction` is false for a realm error — its client
   * is replaced in milliseconds, so it is no evidence that the node parked us — so
   * the first arm does not fire, and only then do the other two matter.
   */
  describe('the recheck booking under a realm-error eviction', () => {
    const discardedRow = {
      id: 'row-a',
      transactionId: '0xa',
      extraInputs: { newGuardianEndpoint: 'https://new.test', previousGuardianEndpoint: 'https://old.test' }
    };

    beforeEach(() => {
      storeState.accounts = [only] as never;
      mockListUnconfirmedSwitchRows.mockResolvedValue([discardedRow]);
      // The node read SUCCEEDS — so `probeSucceeded` is set — and the ROLLBACK,
      // which takes a hold of its own, is what evicts.
      mockReadDirectSwitchCommitState.mockResolvedValue('discarded');
      storeState.revertGuardianEndpointAfterDiscard.mockRejectedValue(new WasmClientPoisonedError('realm-error'));
    });

    /**
     * The fuse has to be LIT BUT LAPSED, not merely lit.
     *
     * The recheck's first act is `if (isSyncFused(key)) return` — so a freshly
     * armed fuse makes the whole probe a no-op and every assertion below passes
     * without the code under test ever running. Letting the window elapse is what
     * puts the probe on the allowed lap: `isSyncFused` is false, so it runs, while
     * `fusedUntilMs` is still non-null, so a re-arm is observable as a deadline
     * strictly later than the old one.
     */
    const armLapsedFuse = (clock: { advance: (ms: number) => void }) => {
      const key = pendingRotationRecheckFuseKey(only.publicKey);
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i += 1) noteSyncWatchdogEviction(key);
      const armedAt = Number(syncFuseUntilMs(key));
      clock.advance(FUSED_SYNC_PROBE_INTERVAL_MS + 1);
      expect(isSyncFused(key)).toBe(false);
      return { key, armedAt };
    };

    // A probe that evicted did not succeed, whatever any single row managed. With
    // the suppression gone, the success arm fires on `probeSucceeded` alone and
    // WITHDRAWS the accumulated evidence — `syncFuseUntilMs` goes null — which is
    // the one outcome no failing probe may produce.
    it('does not book a success for a probe that evicted', async () => {
      const clock = useFakeClocks(3_000_000);
      const { key } = armLapsedFuse(clock);

      await syncGuardianAccounts();

      expect(syncFuseUntilMs(key)).not.toBeNull();
      clock.restore();
    });

    // And it books the NON-eviction failure instead, which is what re-arms the
    // deadline. Reported by neither arm, the aggregation fell through all three and
    // booked nothing at all — so "one probe per 30 min until one SUCCEEDS" stopped
    // holding for the one probe that had just failed.
    it('re-arms a lapsed fuse on the realm-error poison rather than booking nothing', async () => {
      const clock = useFakeClocks(3_000_000);
      const { key, armedAt } = armLapsedFuse(clock);

      await syncGuardianAccounts();

      // A strictly LATER deadline is the observable difference between "re-armed"
      // and "left alone". Booking nothing at all — the state the missing arm left
      // this in — leaves the lapsed deadline in place, so the next lap probes again
      // immediately.
      expect(Number(syncFuseUntilMs(key))).toBeGreaterThan(armedAt);
      expect(isSyncFused(key)).toBe(true);
      clock.restore();
    });
  });

  // The recheck's OUTERMOST catch. Everything inside it runs before any of the two
  // inner trys exist — the dynamic import and the row list — and a poison there
  // has to reach the caller for the same reason the inner breaks do.
  it('stops the pass when the recheck fails out of its outer catch with poison', async () => {
    mockListUnconfirmedSwitchRows.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await syncGuardianAccounts();

    // Reported as an eviction, so the account loop breaks before drift's hold.
    // Reported as `false`, drift ran and took a fresh hold under the abandoned call.
    expect(storeState.checkGuardianDrift).not.toHaveBeenCalled();
    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
  });

  // And it BOOKS the eviction on the way out. Breaking without booking is the
  // half-fix: the pass stops this lap, and the next lap ~3s later re-parks against
  // the same node because nothing accumulated toward the threshold that stretches
  // the cadence. This assertion is what the break alone cannot make.
  it('books the outer catch poison on the account s own recheck fuse', async () => {
    const key = pendingRotationRecheckFuseKey(only.publicKey);
    mockListUnconfirmedSwitchRows.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i += 1) await syncGuardianAccounts();

    // The threshold reached from nothing but outer-catch evictions.
    expect(isSyncFused(key)).toBe(true);
  });

  /**
   * The hardening self-heal's eviction, which reached NONE of this.
   *
   * `ensureGuardianProcedureThresholds` ended in a blanket catch returning
   * `undefined`, so it never rejected: the poison `.catch` on the call was dead
   * code, the pass carried on to the next account taking fresh holds, and — worst
   * — the guardian success had already been booked before the hardening ran, so a
   * lap that demonstrably evicted was recorded as a clean probe and the fuse stood
   * exonerated for the very park it exists to record.
   */
  describe('when the hardening self-heal is evicted', () => {
    beforeEach(() => {
      storeState.accounts = [only, other] as never;
      mockEnsureGuardianProcedureThresholds.mockRejectedValue(new WasmClientPoisonedError('watchdog'));
    });

    it('stops the pass instead of syncing the next account', async () => {
      await syncGuardianAccounts();

      expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledTimes(1);
      expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(1);
    });

    it('books the eviction rather than a success on the account fuse', async () => {
      storeState.accounts = [only] as never;
      const key = guardianSyncFuseKey(only.publicKey, 'https://guardian.test');

      for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; pass += 1) {
        __resetGuardianSyncOutageForTest();
        await syncGuardianAccounts();
      }

      // The round trip itself succeeded every lap, so with the success booked
      // before the hardening the count was zeroed as fast as it accumulated and
      // this key could never light.
      expect(isSyncFused(key)).toBe(true);
    });

    it('withdraws the once-per-session mark so a later tick retries the hardening', async () => {
      storeState.accounts = [only] as never;

      await syncGuardianAccounts();
      mockEnsureGuardianProcedureThresholds.mockReset();
      mockEnsureGuardianProcedureThresholds.mockResolvedValue(undefined);
      await syncGuardianAccounts();

      // An eviction never reached a verdict, so leaving the mark would strand a
      // migrated account at threshold-1 for the rest of the session — the exact
      // state this self-heal exists to repair.
      expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledTimes(1);
    });
  });

  // The recheck fuse key carries the ACCOUNT for the same reason the guardian and
  // drift keys do. As a bare literal it aggregated per call and this function is
  // called per account, so a healthy account's success erased what a parked
  // account had accumulated, on every lap — the threshold unreachable, exactly the
  // defeat-by-ordering that splitting this ledger was written to end.
  it('keeps one account s recheck evidence out of another s reach', async () => {
    storeState.accounts = [only, other] as never;
    mockListUnconfirmedSwitchRows.mockImplementation(async (pk: unknown) =>
      pk === only.publicKey ? [{ id: 'row-a', transactionId: '0xa' }] : []
    );
    // The parked account's node read evicts; the healthy account has no rows at
    // all, which is the shape that books a success on a shared key.
    mockReadDirectSwitchCommitState.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    for (let pass = 0; pass < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; pass += 1) {
      __resetGuardianSyncOutageForTest();
      await syncGuardianAccounts();
    }

    expect(isSyncFused(pendingRotationRecheckFuseKey(only.publicKey))).toBe(true);
    expect(isSyncFused(pendingRotationRecheckFuseKey(other.publicKey))).toBe(false);
  });

  // A retired pass must not settle rows. The recheck was the one arm with no
  // generation check at all, and it writes more durable state than any other: it
  // demotes transaction rows, rolls the account's guardian endpoint back, and
  // spends per-row budgets.
  it('stops settling rows once the pass is retired', async () => {
    storeState.accounts = [only] as never;
    mockListUnconfirmedSwitchRows.mockResolvedValue([
      { id: 'row-a', transactionId: '0xa' },
      { id: 'row-b', transactionId: '0xb' }
    ]);
    mockReadDirectSwitchCommitState.mockImplementation(async () => {
      // A reset landing mid-loop, which is what an endpoint change or a lock
      // recovery does to a pass already in flight — it bumps the generation.
      __resetGuardianSyncOutageForTest();
      return 'committed';
    });

    await syncGuardianAccounts();

    // Row one's write is the one already in hand; row two must not be settled by a
    // pass whose state has been cleared out from under it.
    expect(mockResolveUnconfirmedSwitch).not.toHaveBeenCalled();
  });
});
