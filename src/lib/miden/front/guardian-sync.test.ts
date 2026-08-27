/**
 * zustandProvider + syncGuardianAccounts — the default provider exposes the
 * store API, and the syncGuardianAccounts driver pulls from it, skips non-
 * Guardian accounts, and swallows per-account errors so one bad account
 * can't block the whole sync cycle.
 */

import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import {
  FUSED_SYNC_PROBE_INTERVAL_MS,
  MAX_CONSECUTIVE_WATCHDOG_EVICTIONS,
  monotonicNowMs
} from 'lib/miden/sync-backoff';
import { WalletType } from 'screens/onboarding/types';

import { SELF_HEAL_AUTH_FAILURE_THRESHOLD } from './guardian-selfheal';
import {
  SYNC_RATE_LIMIT_FALLBACK_COOLDOWN_MS,
  SYNC_RATE_LIMIT_MAX_COOLDOWN_MS,
  syncGuardianAccounts,
  zustandProvider
} from './guardian-sync';
import { guardianSyncFuseKey, __resetSyncFuseStateForTests, isSyncFused, syncFuseUntilMs } from './sync-fuse';

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
  getSignerDetailsFromAccount: (...args: unknown[]) => mockGetSignerDetails(...args),
  // The fuse key carries the endpoint, so the loop resolves it per account per lap.
  resolveGuardianEndpoint: async (account: { guardianEndpoint?: string }) =>
    account.guardianEndpoint ?? 'https://guardian.test'
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
