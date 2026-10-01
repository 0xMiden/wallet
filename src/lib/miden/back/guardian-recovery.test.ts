import { GuardianHttpClient, GuardianHttpError } from '@openzeppelin/guardian-client';

import {
  clearGuardianNoteRecoveryProgress,
  fetchGuardianNoteRecoveryProgress,
  type GuardianNoteRecoveryProgress,
  reportGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';
import { readGuardianHistoryGeneration } from 'lib/miden/guardian/history-storage';
import { canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { getAllUncompletedTransactions } from 'lib/miden/transaction/get';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import {
  MAX_HISTORY_ENTRIES_PER_SOURCE,
  recoverGuardianHistory,
  terminalGuardianHistoryGeneration
} from './guardian-history-recovery';
import { maybeStartGuardianRecovery, recoverPendingNotes, releaseGuardianRecoveriesOnLock } from './guardian-recovery';
import { midenClientProxy } from './miden-client-proxy';
import { OperationAbortedError } from './offscreen-codec';
import { accountsUpdated, store } from './store';
import { doSync } from './sync-manager';
import { GUARDIAN_HISTORY_VERSION, historyCheckpointId } from '../guardian/history';
import { GuardianHistoryFeeUnavailableError } from '../guardian/history-errors';

// The orchestrator's own decisions are what these tests are about — the gating,
// the queue and the terminal flag write — so every source it drives is stubbed.
jest.mock('lib/miden/transaction/get', () => ({ getAllUncompletedTransactions: jest.fn() }));
jest.mock('./sync-manager', () => ({ doSync: jest.fn() }));
jest.mock('./miden-client-proxy', () => ({
  midenClientProxy: {
    getAccount: jest.fn(),
    drainPrivateNoteTransport: jest.fn(),
    importRecoveryNoteBytes: jest.fn(),
    resolveRecoveryScanRange: jest.fn(),
    recoverPublicNotesRange: jest.fn(),
    decodeGuardianHistory: jest.fn(),
    getGuardianResultCommitment: jest.fn()
  }
}));
// The node a terminal fee answer came from; only the cases that run the real history pass read it.
let mockFeeScope = 'rpc-a|testnet';
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  cacheScope: () => mockFeeScope
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (fn: () => unknown) => fn()
}));
jest.mock('lib/miden/guardian/account', () => ({
  getSignerDetailsFromAccount: jest.fn().mockResolvedValue({ commitment: 'commitment' }),
  resolveGuardianEndpoint: jest.fn().mockResolvedValue('https://guardian.test')
}));
jest.mock('lib/miden/guardian/native-http', () => ({ registerGuardianOrigin: jest.fn() }));
jest.mock('lib/miden/guardian/signer', () => ({ WalletSigner: jest.fn() }));
jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: jest.fn().mockImplementation(() => ({
    setSigner: jest.fn(),
    getDeltaProposals: jest.fn().mockResolvedValue([]),
    getState: jest.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' })
  })),
  GuardianHttpError: class extends Error {
    code: string | null;
    constructor(
      public status: number,
      public statusText: string,
      public body: string
    ) {
      super(body);
      this.code = body === 'account_not_found' ? body : null;
    }
  }
}));
// Only the case that runs the real history pass reads this list.
jest.mock('lib/miden-chain/constants', () => {
  const actual = jest.requireActual('lib/miden-chain/constants');
  return {
    ...actual,
    MIDEN_GUARDIAN_ENDPOINTS: new Map(
      Object.values(actual.MIDEN_NETWORK_NAME).map(network => [
        network,
        ['https://builtin.test', 'https://guardian.test']
      ])
    )
  };
});
jest.mock('lib/guardian-note-recovery-progress', () => ({
  reportGuardianNoteRecoveryProgress: jest.fn(),
  clearGuardianNoteRecoveryProgress: jest.fn(),
  fetchGuardianNoteRecoveryProgress: jest.fn()
}));
jest.mock('./store', () => ({
  store: { getState: jest.fn() },
  accountsUpdated: jest.fn()
}));
jest.mock('lib/miden/guardian/history-storage', () => ({
  ...jest.requireActual('lib/miden/guardian/history-storage'),
  readGuardianHistoryGeneration: jest.fn()
}));
jest.mock('./guardian-history-recovery', () => ({
  ...jest.requireActual('./guardian-history-recovery'),
  terminalGuardianHistoryGeneration: jest.fn().mockResolvedValue(null),
  recoverGuardianHistory: jest
    .fn()
    .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 })
}));

const mockUncompleted = jest.mocked(getAllUncompletedTransactions);
const mockGetState = jest.mocked(store.getState);
const mockAccountsUpdated = jest.mocked(accountsUpdated);
const mockClearProgress = jest.mocked(clearGuardianNoteRecoveryProgress);
const mockFetchProgress = jest.mocked(fetchGuardianNoteRecoveryProgress);
const mockReportProgress = jest.mocked(reportGuardianNoteRecoveryProgress);
const mockProxy = jest.mocked(midenClientProxy);
const mockDoSync = jest.mocked(doSync);
const mockReadGeneration = jest.mocked(readGuardianHistoryGeneration);

/** `createdAt` from the mocked Guardian `getState`, in unix seconds. */
const GUARDIAN_CREATED_AT_SECONDS = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000);

/** The block ranges the backfill actually asked for, in order. */
function backfillRanges() {
  return mockProxy.recoverPublicNotesRange.mock.calls.map(call => call.slice(1));
}

/** Watermarks the progress card was told about, in order. */
function reportedWatermarks() {
  return mockReportProgress.mock.calls.map(([progress]) => progress.syncedToBlock).filter(block => block !== undefined);
}

/**
 * Makes the Guardian offer one consume proposal carrying `count` notes.
 *
 * Re-applied with 0 before every test: this replaces the module mock's own
 * implementation, which `jest.clearAllMocks` does not restore.
 */
function guardianOffersProposalNotes(count: number, metadataVersion = 2) {
  jest.mocked(GuardianHttpClient).mockImplementation(
    () =>
      ({
        setSigner: jest.fn(),
        getState: jest.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' }),
        getDeltaProposals: jest.fn().mockResolvedValue([
          {
            deltaPayload: {
              metadata: {
                proposalType: 'consume_notes',
                consumeNotesMetadataVersion: metadataVersion,
                // 'AQID' decodes to [1, 2, 3] — `b64ToU8` is the real one here.
                consumeNotesNotes: Array.from({ length: count }, () => 'AQID')
              }
            }
          }
        ])
      }) as never
  );
}

/** Makes the Guardian offer `count` note-less consume proposals. */
function guardianOffersProposalCount(count: number) {
  jest.mocked(GuardianHttpClient).mockImplementation(
    () =>
      ({
        setSigner: jest.fn(),
        getState: jest.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' }),
        getDeltaProposals: jest.fn().mockResolvedValue(
          Array.from({ length: count }, () => ({
            deltaPayload: {
              metadata: { proposalType: 'consume_notes', consumeNotesMetadataVersion: 2, consumeNotesNotes: [] }
            }
          }))
        )
      }) as never
  );
}

// `reservations` and the queue are module state, so each test gets a fresh
// account id rather than a fresh module.
let accountSeq = 0;

function pendingAccount(overrides: Partial<WalletAccount> = {}): WalletAccount {
  accountSeq++;
  return {
    publicKey: `account-${accountSeq}`,
    name: `Account ${accountSeq}`,
    isPublic: false,
    type: WalletType.Guardian,
    hdIndex: 0,
    authScheme: 'ecdsa',
    guardianNoteRecoveryPending: true,
    ...overrides
  };
}

let setPendingFlag: jest.Mock;

function unlocked() {
  mockGetState.mockReturnValue({ vault: { setGuardianNoteRecoveryPending: setPendingFlag } } as never);
}

function locked() {
  mockGetState.mockReturnValue({ vault: null } as never);
}

/**
 * Lets the detached run (queued, then several awaits deep) reach its end. The
 * budget covers the longest run here — 20 proposal batches, each several awaits
 * deep — since every source is a resolved mock.
 */
async function drainDetachedRun() {
  for (let i = 0; i < 500; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(terminalGuardianHistoryGeneration).mockResolvedValue(null);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  setPendingFlag = jest.fn().mockResolvedValue([]);
  guardianOffersProposalNotes(0);
  unlocked();
  mockUncompleted.mockResolvedValue([]);
  mockFetchProgress.mockResolvedValue(null);
  mockReadGeneration.mockResolvedValue('gen-1');
  mockFeeScope = 'rpc-a|testnet';
  mockProxy.getAccount.mockResolvedValue({} as never);
  mockProxy.drainPrivateNoteTransport.mockResolvedValue(undefined as never);
  mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 0 } as never);
  mockProxy.recoverPublicNotesRange.mockResolvedValue({ imported: 0, failures: 0 } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('maybeStartGuardianRecovery gating', () => {
  it('does not start recovery for an account without the pending marker', async () => {
    await expect(maybeStartGuardianRecovery(pendingAccount({ guardianNoteRecoveryPending: false }))).resolves.toBe(
      false
    );
    expect(mockProxy.drainPrivateNoteTransport).not.toHaveBeenCalled();
  });

  it('waits for the mandatory hot-key rotation to land', async () => {
    await expect(maybeStartGuardianRecovery(pendingAccount({ requiresHotKeyRotation: true }))).resolves.toBe(false);
    expect(mockProxy.drainPrivateNoteTransport).not.toHaveBeenCalled();
  });

  it('defers while any account has a transaction in flight, and stays startable after', async () => {
    const account = pendingAccount();
    mockUncompleted.mockResolvedValue([{ id: 'tx-1' }] as never);

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);

    // The reservation must have been released, or the provider's poll could
    // never start this account again for the rest of the backend's life.
    mockUncompleted.mockResolvedValue([]);
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('releases the reservation when the eligibility query itself rejects', async () => {
    const account = pendingAccount();
    mockUncompleted.mockRejectedValueOnce(new Error('dexie is gone'));

    await expect(maybeStartGuardianRecovery(account)).rejects.toThrow('dexie is gone');

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('starts an account only once, even when two provider instances ask at the same time', async () => {
    const account = pendingAccount();

    const [first, second] = await Promise.all([
      maybeStartGuardianRecovery(account),
      maybeStartGuardianRecovery(account)
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
});

describe('detached recovery run', () => {
  it('clears the pending flag and broadcasts once every source succeeded', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
    expect(mockAccountsUpdated).toHaveBeenCalledTimes(1);
    expect(mockClearProgress).toHaveBeenCalledWith(account.publicKey);
    expect(mockClearProgress).toHaveBeenCalledTimes(2);
    expect(mockClearProgress.mock.invocationCallOrder[1]).toBeGreaterThan(setPendingFlag.mock.invocationCallOrder[0]!);
  });

  it('leaves the flag and the progress record to the new wallet when the history generation moves', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockReadGeneration.mockResolvedValueOnce('gen-1').mockResolvedValue('gen-2');

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    // Only the notes pass's own finally; the clear that follows a flag write is skipped.
    expect(mockClearProgress).toHaveBeenCalledTimes(1);
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('keeps the flag set and reports a partial history when a history source fails', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockResolvedValueOnce({
      deferred: false,
      sourceFailures: 1,
      restored: 2,
      deferredSources: 0
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(reportGuardianNoteRecoveryProgress).toHaveBeenCalledWith({
      accountId: account.publicKey,
      step: 'history-partial',
      restored: 2,
      sourcesClean: true,
      historyGeneration: 'gen-1'
    });
  });

  it('keeps the flag set and reports a partial history when a history source is deferred', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockResolvedValueOnce({
      deferred: false,
      sourceFailures: 0,
      restored: 2,
      deferredSources: 1
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(reportGuardianNoteRecoveryProgress).toHaveBeenCalledWith({
      accountId: account.publicKey,
      step: 'history-partial',
      restored: 2,
      sourcesClean: true,
      historyGeneration: 'gen-1'
    });
  });

  it('keeps the flag set when the Guardian client cannot be built', async () => {
    const account = pendingAccount({ coldPublicKey: undefined });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockClearProgress).toHaveBeenCalledWith(account.publicKey);
  });

  // Hot-key-only import: no cold key exists (and no seed to re-derive one),
  // so note recovery authenticates with the hot key — the same key the
  // everyday proposal flow already signs guardian requests with.
  it('falls back to the hot signer for an account with no cold key', async () => {
    const { WalletSigner } = jest.requireMock('lib/miden/guardian/signer') as { WalletSigner: jest.Mock };
    const { getSignerDetailsFromAccount } = jest.requireMock('lib/miden/guardian/account') as {
      getSignerDetailsFromAccount: jest.Mock;
    };
    const account = pendingAccount({ coldPublicKey: undefined, hotPublicKey: 'hotpub' });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    // The commitment is read from the HOT signer slot, and the signer binds
    // to the hot public key.
    expect(getSignerDetailsFromAccount).toHaveBeenCalledWith(expect.anything(), false);
    expect(WalletSigner).toHaveBeenCalledWith('0xhotpub', '0xcommitment', expect.any(Function));
    // The run completes like the cold-signed one does.
    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
  });

  it('still prefers the cold signer when the account has a cold key', async () => {
    const { WalletSigner } = jest.requireMock('lib/miden/guardian/signer') as { WalletSigner: jest.Mock };
    const { getSignerDetailsFromAccount } = jest.requireMock('lib/miden/guardian/account') as {
      getSignerDetailsFromAccount: jest.Mock;
    };
    const account = pendingAccount({ coldPublicKey: '0xcold', hotPublicKey: 'hotpub' });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(getSignerDetailsFromAccount).toHaveBeenCalledWith(expect.anything(), true);
    expect(WalletSigner).toHaveBeenCalledWith('0xcold', '0xcommitment', expect.any(Function));
  });

  // The setup reads the account through the offscreen realm, so a deadline kill
  // there is ordinary traffic. Counting it as a failed source would strand the
  // account for the rest of this backend's lifetime over nothing.
  it('treats a realm teardown during the Guardian client setup as a deferral', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.getAccount.mockRejectedValue(new OperationAbortedError('op-1', 'deadline'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    // Re-offerable straight away rather than waiting for the next backend start.
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('treats an evicted Guardian client setup as a deferral, not a source failure (F-054)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.getAccount.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await expect(recoverPendingNotes(account, 'gen-1')).resolves.toMatchObject({ deferred: true, sourceFailures: 0 });
  });

  // Re-offered at once, an op that parks on a stuck transport or node would be
  // evicted again every lap, holding the mutex for the whole watchdog each time.
  it('keeps an evicted transport drain reserved for the next backend start (F-055)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
  });

  it('keeps an evicted Guardian client setup reserved for the next backend start (F-055)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.getAccount.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
  });

  it('keeps an evicted proposal import reserved for the next backend start (F-055)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    guardianOffersProposalNotes(1);
    mockProxy.importRecoveryNoteBytes.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
  });

  it('keeps an evicted backfill chunk reserved for the next backend start (F-055)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 10 } as never);
    mockProxy.recoverPublicNotesRange.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
  });

  it('keeps an evicted backfill range resolution reserved for the next backend start (F-055)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.resolveRecoveryScanRange.mockRejectedValue(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
  });

  it('still re-offers a proposal import deferred by a realm teardown (F-055)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    guardianOffersProposalNotes(1);
    mockProxy.importRecoveryNoteBytes.mockRejectedValue(new OperationAbortedError('op-1', 'deadline'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('keeps an evicted history pass reserved for the next backend start (F-118)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockResolvedValueOnce({
      deferred: true,
      evicted: true,
      sourceFailures: 0,
      restored: 0,
      deferredSources: 0
    });
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).not.toHaveBeenCalled();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
      // The lock hook releases only failed runs, so for the same wallet generation only a backend restart frees an
      // evicted pass's entry; a replaced wallet is admitted (see the #1302 tests).
      releaseGuardianRecoveriesOnLock();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    } finally {
      jest
        .mocked(recoverGuardianHistory)
        .mockReset()
        .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 });
    }
  });

  it('admits a replaced wallet after an evicted notes pass (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    mockReadGeneration.mockResolvedValue('gen-2');
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
  });

  it('admits a replaced wallet after an evicted history pass (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockResolvedValueOnce({
      deferred: true,
      evicted: true,
      sourceFailures: 0,
      restored: 0,
      deferredSources: 0
    });
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      mockReadGeneration.mockResolvedValue('gen-2');
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      jest
        .mocked(recoverGuardianHistory)
        .mockReset()
        .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 });
    }
  });

  it('keeps an evicted pass parked when the generation read fails (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    mockReadGeneration.mockRejectedValueOnce(new Error('storage down'));
    try {
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
      mockReadGeneration.mockResolvedValue('gen-2');
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      mockReadGeneration.mockReset();
    }
  });

  it('starts one run when two starts race after a generation change (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    mockReadGeneration.mockResolvedValue('gen-2');
    const [a, b] = await Promise.all([maybeStartGuardianRecovery(account), maybeStartGuardianRecovery(account)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await drainDetachedRun();
  });

  it('keeps an evicted pass parked across a lock for the same wallet (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    releaseGuardianRecoveriesOnLock();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    mockReadGeneration.mockResolvedValue('gen-2');
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
  });

  it('admits a replaced wallet after a completed recovery (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
    mockReadGeneration.mockResolvedValue('gen-2');
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
  });

  it('keeps a completed recovery reserved for the same wallet (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
  });

  it('admits a replaced wallet after the gate cleared a terminal checkpoint (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(terminalGuardianHistoryGeneration).mockResolvedValueOnce('gen-1');

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);

    mockReadGeneration.mockResolvedValue('gen-2');
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
  });

  it('admits a replaced wallet after a failed pass, before any lock (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockRejectedValueOnce(new Error('transport unavailable'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    mockReadGeneration.mockResolvedValue('gen-2');
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
  });

  it('a lock still releases a failed pass for the same wallet (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockRejectedValueOnce(new Error('transport unavailable'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    releaseGuardianRecoveriesOnLock();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    mockReadGeneration.mockResolvedValue('gen-2');
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    await drainDetachedRun();
  });

  it('a lock does not free the reservation of a run admitted after a failed pass (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockRejectedValueOnce(new Error('transport unavailable'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    mockReadGeneration.mockResolvedValue('gen-2');
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    releaseGuardianRecoveriesOnLock();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    await drainDetachedRun();
  });

  it('a released reservation leaves no generation entry to admit a second start (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    // A lock lands during the flag write and the record clear then fails, so the run releases its reservation.
    setPendingFlag.mockImplementationOnce(async () => {
      releaseGuardianRecoveriesOnLock();
      return [];
    });
    mockClearProgress.mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new Error('storage down'));
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      mockReadGeneration.mockResolvedValue('gen-2');
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
      await drainDetachedRun();
    } finally {
      mockClearProgress.mockReset();
    }
  });

  it('does not admit a replaced wallet while the clean pass still clears its progress record (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    const progressClear: { finish: () => void } = { finish: () => undefined };
    mockClearProgress.mockResolvedValueOnce(undefined).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          progressClear.finish = () => resolve();
        })
    );
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
      expect(mockClearProgress).toHaveBeenCalledTimes(2);
      mockReadGeneration.mockResolvedValue('gen-2');
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);

      progressClear.finish();
      await drainDetachedRun();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      progressClear.finish();
      await drainDetachedRun();
      mockClearProgress.mockReset();
    }
  });

  it('a progress clear that fails after the flag cleared keeps the account reserved for a failed pass (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    const progressClear: { fail: () => void } = { fail: () => undefined };
    mockClearProgress.mockResolvedValueOnce(undefined).mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          progressClear.fail = () => reject(new Error('storage down'));
        })
    );
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
      expect(mockClearProgress).toHaveBeenCalledTimes(2);
      progressClear.fail();
      await drainDetachedRun();

      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
      releaseGuardianRecoveriesOnLock();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      progressClear.fail();
      await drainDetachedRun();
      mockClearProgress.mockReset();
    }
  });

  it('a flag clear whose tail fails keeps the reservation in flight until its run ends (#1302)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    const progressClear: { finish: () => void } = { finish: () => undefined };
    // The flag write lands and its broadcast throws, so clearPendingFlag returns 'cleared' through its catch.
    mockAccountsUpdated.mockImplementationOnce(() => {
      throw new Error('broadcast failed');
    });
    mockClearProgress.mockResolvedValueOnce(undefined).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          progressClear.finish = () => resolve();
        })
    );
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
      expect(mockClearProgress).toHaveBeenCalledTimes(2);
      mockReadGeneration.mockResolvedValue('gen-2');
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);

      progressClear.finish();
      await drainDetachedRun();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      progressClear.finish();
      await drainDetachedRun();
      mockClearProgress.mockReset();
      mockAccountsUpdated.mockReset();
      mockProxy.drainPrivateNoteTransport.mockReset();
    }
  });

  it('still re-offers a history pass deferred by a yield (F-118)', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest
      .mocked(recoverGuardianHistory)
      .mockResolvedValueOnce({ deferred: true, sourceFailures: 0, restored: 0, deferredSources: 0 });
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).not.toHaveBeenCalled();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      jest
        .mocked(recoverGuardianHistory)
        .mockReset()
        .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 });
    }
  });

  it('keeps the flag set when a source failed, so the next backend start retries', async () => {
    const account = pendingAccount();
    mockProxy.recoverPublicNotesRange.mockRejectedValue(new Error('node unavailable'));
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 10 } as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockAccountsUpdated).not.toHaveBeenCalled();
  });

  it('gives the client back when a transaction appears mid-run, and stays startable', async () => {
    const account = pendingAccount();
    mockProxy.drainPrivateNoteTransport.mockImplementation(async () => {
      mockUncompleted.mockResolvedValue([{ id: 'tx-1' }] as never);
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    // Stopped before the public backfill rather than contending for the one
    // WASM client with a live transaction.
    expect(mockProxy.recoverPublicNotesRange).not.toHaveBeenCalled();
    expect(setPendingFlag).not.toHaveBeenCalled();

    // Deferring is not a failure, so the reservation went back.
    mockUncompleted.mockResolvedValue([]);
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('stays startable when only the terminal flag write fails', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    setPendingFlag.mockRejectedValue(new Error('encrypt failed'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).toHaveBeenCalled();
    expect(mockAccountsUpdated).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('never touches the vault or front state once the wallet locks mid-run', async () => {
    const account = pendingAccount();
    mockProxy.drainPrivateNoteTransport.mockImplementation(async () => {
      locked();
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockAccountsUpdated).not.toHaveBeenCalled();
  });

  it('re-offers a saturated range as halves, each as its own op', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 1_999 } as never);
    mockProxy.recoverPublicNotesRange
      .mockResolvedValueOnce({ imported: 0, failures: 0, saturated: true } as never)
      .mockResolvedValue({ imported: 1, failures: 0, saturated: false } as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    // Each half is a fresh range, so each starts at note page 0.
    expect(mockProxy.recoverPublicNotesRange.mock.calls.map(call => call.slice(1))).toEqual([
      [0, 1_999, 0],
      [0, 999, 0],
      [1_000, 1_999, 0]
    ]);
    // Both halves landed, so the pass is clean and the flag clears.
    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
  });

  it('stops splitting at a single block instead of looping forever', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 1 } as never);
    mockProxy.recoverPublicNotesRange.mockResolvedValue({ imported: 0, failures: 0, saturated: true } as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(mockProxy.recoverPublicNotesRange.mock.calls.map(call => call.slice(1))).toEqual([
      [0, 1, 0],
      [0, 0, 0],
      [1, 1, 0]
    ]);
    // Two blocks it could not scan are two source failures, so the account
    // stays pending for a later retry rather than clearing over skipped notes.
    expect(setPendingFlag).not.toHaveBeenCalled();
  });

  // The recovery's own imports make notes consumable, auto-consume is on by
  // default, and the SW enqueues a consume per newly visible note — so
  // deferring for a transaction is the normal case, not a rare one. Without a
  // checkpoint every deferral would restart the whole pass and the wallet would
  // never finish recovering.
  describe('checkpointing', () => {
    it('keeps the checkpoint when a clean pass defers, so the next one resumes', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 400_000 } as never);
      // Second chunk sees a transaction that the first chunk's imports caused.
      mockProxy.recoverPublicNotesRange.mockImplementationOnce(async () => {
        mockUncompleted.mockResolvedValue([{ id: 'auto-consume' }] as never);
        return { imported: 1, failures: 0, saturated: false } as never;
      });

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockClearProgress).not.toHaveBeenCalled();
      expect(setPendingFlag).not.toHaveBeenCalled();
      const publicWrites = mockReportProgress.mock.calls.filter(([progress]) => progress.step === 'public');
      expect(publicWrites.length).toBeGreaterThan(0);
      for (const [progress] of publicWrites) expect(progress.historyGeneration).toBe('gen-1');
    });

    it('resumes at the checkpointed block and skips the sources it already did', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockFetchProgress.mockResolvedValue({
        accountId: account.publicKey,
        step: 'public',
        startBlock: 0,
        syncedToBlock: 200_000,
        latestBlock: 400_000,
        updatedAt: Date.now(),
        sourcesClean: true,
        historyGeneration: 'gen-1'
      });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 400_000 } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      // The expensive source is not re-paid.
      expect(mockProxy.importRecoveryNoteBytes).not.toHaveBeenCalled();
      // The creation-block search is skipped too: 0 means "just give me the tip".
      expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledWith(0);
      // Scanning restarts at the checkpoint, not at block 0.
      expect(mockProxy.recoverPublicNotesRange.mock.calls[0]?.[1]).toBe(200_000);
      expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
    });

    // Nothing else in the wallet calls the SDK's `fetchPrivate`, so a private
    // note that lands in the transport while the pass is deferred is collected
    // by this drain or by nothing at all — and the pass that resumes is the one
    // that clears the one-shot flag.
    it('re-drains the transport on a resumed pass, without downgrading the checkpoint', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockFetchProgress.mockResolvedValue({
        accountId: account.publicKey,
        step: 'public',
        startBlock: 0,
        syncedToBlock: 200_000,
        latestBlock: 400_000,
        updatedAt: Date.now(),
        sourcesClean: true,
        historyGeneration: 'gen-1'
      });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 400_000 } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(1);
      // Re-stamping the record at `transport` would throw away the watermark
      // this pass is resuming from if the pass then died.
      expect(mockReportProgress.mock.calls.map(([progress]) => progress.step)).not.toContain('transport');
    });

    // The `finally` that discards a failed pass's record only runs on a
    // graceful exit. A service worker evicted mid-run leaves the record behind,
    // and its watermark can already be past a chunk that FAILED — the work list
    // advances the watermark for completed chunks regardless of an earlier
    // failed one. Resuming that record would finish clean and clear the
    // one-shot flag over notes nothing imported.
    it.each([
      ['a pass that had already failed a source', false],
      ['a record written before health was tracked', undefined]
    ])('refuses to resume from %s', async (_label, sourcesClean) => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockFetchProgress.mockResolvedValue({
        accountId: account.publicKey,
        step: 'public',
        startBlock: 0,
        syncedToBlock: 200_000,
        latestBlock: 400_000,
        updatedAt: Date.now(),
        sourcesClean
      } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      // A full fresh pass: every source re-run, and the range resolved from the
      // creation time rather than from the untrusted watermark.
      expect(mockProxy.importRecoveryNoteBytes).not.toHaveBeenCalled();
      expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledWith(GUARDIAN_CREATED_AT_SECONDS);
      expect(mockReportProgress.mock.calls.map(([progress]) => progress.step)).toContain('transport');
    });

    it.each(['history', 'history-partial'] as const)(
      'resumes a clean pass recorded at %s at the history phase',
      async step => {
        const account = pendingAccount({ coldPublicKey: '0xcold' });
        guardianOffersProposalNotes(1);
        mockProxy.importRecoveryNoteBytes.mockResolvedValue({ imported: 1, failures: 0 } as never);
        mockFetchProgress.mockResolvedValue({
          accountId: account.publicKey,
          step,
          operator: 'https://guardian.test',
          restored: 1,
          updatedAt: Date.now(),
          sourcesClean: true,
          historyGeneration: 'gen-1'
        });

        await maybeStartGuardianRecovery(account);
        await drainDetachedRun();

        expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(1);
        expect(mockProxy.importRecoveryNoteBytes).not.toHaveBeenCalled();
        expect(mockProxy.resolveRecoveryScanRange).not.toHaveBeenCalled();
        expect(mockProxy.recoverPublicNotesRange).not.toHaveBeenCalled();
        expect(GuardianHttpClient).not.toHaveBeenCalled();
        expect(mockReportProgress.mock.calls.map(([progress]) => progress.step)).not.toContain('transport');
        expect(mockDoSync).toHaveBeenCalled();
        expect(recoverGuardianHistory).toHaveBeenCalledWith(account, expect.objectContaining({ generation: 'gen-1' }));
        expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
      }
    );

    // A record written under another history generation belongs to a wallet this one replaced.
    it.each([
      ['history', 'gen-0'],
      ['history-partial', 'gen-0'],
      ['history', undefined],
      ['public', 'gen-0'],
      ['public', undefined]
    ] as const)('runs the full pass over a clean %s record from history generation %s', async (step, generation) => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockFetchProgress.mockResolvedValue({
        accountId: account.publicKey,
        step,
        operator: 'https://guardian.test',
        restored: 1,
        syncedToBlock: 200_000,
        updatedAt: Date.now(),
        sourcesClean: true,
        historyGeneration: generation
      });

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(GuardianHttpClient).toHaveBeenCalled();
      expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledWith(GUARDIAN_CREATED_AT_SECONDS);
      expect(mockReportProgress.mock.calls.map(([progress]) => progress.step)).toContain('transport');
    });

    it.each([
      ['a record written before health was tracked', 'self', undefined],
      ["another account's record", 'other', true]
    ] as const)('runs the full pass over %s at the history phase', async (_label, owner, sourcesClean) => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockFetchProgress.mockResolvedValue({
        accountId: owner === 'self' ? account.publicKey : 'another-account',
        step: 'history',
        updatedAt: Date.now(),
        sourcesClean
      });

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(GuardianHttpClient).toHaveBeenCalled();
      expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledWith(GUARDIAN_CREATED_AT_SECONDS);
      expect(mockReportProgress.mock.calls.map(([progress]) => progress.step)).toContain('transport');
    });

    it('marks the checkpoint unusable as soon as a chunk fails', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 400_000 } as never);
      mockProxy.recoverPublicNotesRange
        .mockRejectedValueOnce(new Error('node unavailable'))
        .mockResolvedValue({ imported: 0, failures: 0, saturated: false } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      // The later chunk succeeds and advances the watermark past the failed
      // range, so every write from that point on must disown it.
      const publicWrites = mockReportProgress.mock.calls
        .map(([progress]) => progress)
        .filter(progress => progress.step === 'public');
      expect(publicWrites[publicWrites.length - 1]?.sourcesClean).toBe(false);
    });

    it('treats a realm teardown during the drain as a deferral', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockProxy.drainPrivateNoteTransport.mockRejectedValue(new OperationAbortedError('op-1', 'deadline'));

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      // Not a failing source, so the account is re-offered rather than waiting
      // for the next backend start.
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    });

    it('refuses to resume past a pass that failed a source', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 400_000 } as never);
      mockProxy.recoverPublicNotesRange.mockImplementationOnce(async () => {
        mockUncompleted.mockResolvedValue([{ id: 'auto-consume' }] as never);
        return { imported: 0, failures: 2, saturated: false } as never;
      });

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      // A watermark cannot express "and two notes were missed", so the record
      // goes rather than letting a later clean pass clear the flag over them.
      expect(mockClearProgress).toHaveBeenCalledWith(account.publicKey);
    });

    // `fetchGuardianNoteRecoveryProgress` reads ONE global record, and every
    // account adopted by a seed recovery is flagged — so the record a queued
    // account finds is very often another account's. Consuming it would make
    // this account skip the transport drain and the proposal import outright and
    // then clear its own one-shot pending flag, losing those notes for good.
    it('ignores a checkpoint left by a different account', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockFetchProgress.mockResolvedValue({
        accountId: 'some-other-account',
        step: 'public',
        startBlock: 0,
        syncedToBlock: 200_000,
        latestBlock: 400_000,
        updatedAt: Date.now()
      });

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      // Treated as a fresh pass: every source is paid for, and the scan range is
      // resolved from the account's creation time rather than from the tip.
      expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(1);
      expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledWith(GUARDIAN_CREATED_AT_SECONDS);
    });

    it('ignores a record that has not reached the public step yet', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      // Same account, but the watermark cannot be trusted: the earlier steps had
      // not finished when this was written.
      mockFetchProgress.mockResolvedValue({
        accountId: account.publicKey,
        step: 'proposals',
        syncedToBlock: 200_000,
        updatedAt: Date.now()
      } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(1);
      expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledWith(GUARDIAN_CREATED_AT_SECONDS);
    });

    it('treats a realm teardown as a deferral, not a failing source', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 400_000 } as never);
      mockProxy.recoverPublicNotesRange.mockRejectedValue(new OperationAbortedError('op-1', 'deadline'));

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockClearProgress).not.toHaveBeenCalled();
      // Deferred, so the reservation went back and the account is startable.
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    });
  });

  // The point of the between-chunk check is to stop CONTENDING for the one WASM
  // client the moment a transaction appears. Asserting only the run's outcome
  // cannot see that: the pre-sync check produces the same outcome after
  // scanning every remaining chunk, which is the bug it exists to prevent.
  it('stops the backfill at the very next chunk when a transaction appears', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 600_000 } as never);
    mockProxy.recoverPublicNotesRange.mockImplementationOnce(async () => {
      mockUncompleted.mockResolvedValue([{ id: 'auto-consume' }] as never);
      return { imported: 1, failures: 0, saturated: false } as never;
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    // Four chunks were queued; only the first ran.
    expect(backfillRanges()).toEqual([[0, 199_999, 0]]);
    expect(setPendingFlag).not.toHaveBeenCalled();
  });

  it('re-checks at its turn in the queue, not just when it was offered', async () => {
    const first = pendingAccount();
    const second = pendingAccount();
    // A transaction appears while `first` runs, so `second` — queued behind it
    // and cleared to start minutes ago — must give up its turn.
    mockProxy.drainPrivateNoteTransport.mockImplementationOnce(async () => {
      mockUncompleted.mockResolvedValue([{ id: 'tx-1' }] as never);
    });

    await maybeStartGuardianRecovery(first);
    await maybeStartGuardianRecovery(second);
    await drainDetachedRun();

    // Only `first` ever drained; `second` never started a source at all.
    expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(1);
    // And it gave its reservation back, so the provider can re-offer it.
    mockUncompleted.mockResolvedValue([]);
    await expect(maybeStartGuardianRecovery(second)).resolves.toBe(true);
  });

  it('never reports a block range the backfill actually skipped', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 400_000 } as never);
    // First chunk fails, second succeeds.
    mockProxy.recoverPublicNotesRange
      .mockRejectedValueOnce(new Error('node unavailable'))
      .mockResolvedValue({ imported: 0, failures: 0, saturated: false } as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    const watermarks = reportedWatermarks();
    // The failed chunk must never appear as scanned — the card would claim it,
    // and the same record is the checkpoint a later pass would resume from.
    expect(watermarks).not.toContain(199_999);
    expect(watermarks[watermarks.length - 1]).toBe(400_000);
  });

  it('does not claim a saturated range until its halves have been scanned', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 1_999 } as never);
    mockProxy.recoverPublicNotesRange
      .mockResolvedValueOnce({ imported: 0, failures: 0, saturated: true } as never)
      .mockResolvedValue({ imported: 0, failures: 0, saturated: false } as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    // The requeued range is only claimed as its halves land, in order.
    expect(reportedWatermarks()).toEqual([0, 0, 999, 1_999]);
  });

  // The backfill can finish long after the last yield check, and the closing
  // sync is itself a long client-holding op — the exact thing every other yield
  // in this run exists to keep away from a live transaction.
  it('yields before the closing sync when a transaction appears during the backfill', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 0 } as never);
    mockProxy.recoverPublicNotesRange.mockImplementationOnce(async () => {
      mockUncompleted.mockResolvedValue([{ id: 'auto-consume' }] as never);
      return { imported: 1, failures: 0, saturated: false } as never;
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(mockDoSync).not.toHaveBeenCalled();
    // A clean deferral, so the checkpoint survives for the next pass.
    expect(mockClearProgress).not.toHaveBeenCalled();
    expect(setPendingFlag).not.toHaveBeenCalled();
  });

  // The pass succeeded; only the write failed. Holding the reservation would
  // make the account unstartable for the rest of this backend's lifetime with
  // nothing left to clear it.
  it('frees the account to retry when the wallet locks before the terminal write', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    // Locked at the last possible moment: the closing sync is the step right
    // before the write, so the pass itself completes and only the write is lost.
    mockDoSync.mockImplementationOnce(async () => {
      locked();
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(mockDoSync).toHaveBeenCalled();
    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockAccountsUpdated).not.toHaveBeenCalled();
    unlocked();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  // Only a written flag ends the record: an unwritten one keeps the history checkpoint, so the retry skips the notes
  // backfill the clean pass already did.
  describe('when the terminal flag write does not land', () => {
    async function resumesAtHistory(loseTheWrite: () => void, lostWrites: number) {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      const records = new Map<string, GuardianNoteRecoveryProgress>();
      mockReportProgress.mockImplementation(async progress => {
        records.set(progress.accountId, { ...progress, updatedAt: Date.now() });
      });
      mockClearProgress.mockImplementation(async accountId => {
        records.delete(accountId);
      });
      mockFetchProgress.mockImplementation(async accountId => records.get(accountId) ?? null);
      jest.mocked(recoverGuardianHistory).mockImplementationOnce(async walletAccount => {
        await reportGuardianNoteRecoveryProgress({
          accountId: walletAccount.publicKey,
          step: 'history',
          operator: 'https://guardian.test',
          restored: 0,
          sourcesClean: true,
          historyGeneration: 'gen-1'
        });
        loseTheWrite();
        return { deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 };
      });
      try {
        await maybeStartGuardianRecovery(account);
        await drainDetachedRun();

        const historyStarted = jest.mocked(recoverGuardianHistory).mock.invocationCallOrder[0]!;
        expect(setPendingFlag).toHaveBeenCalledTimes(lostWrites);
        expect(mockClearProgress.mock.invocationCallOrder.filter(order => order > historyStarted)).toEqual([]);
        expect(records.get(account.publicKey)).toMatchObject({ step: 'history' });

        unlocked();
        await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
        await drainDetachedRun();

        expect(recoverGuardianHistory).toHaveBeenCalledTimes(2);
        expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledTimes(1);
        expect(mockReportProgress.mock.calls.filter(([progress]) => progress.step === 'proposals')).toHaveLength(1);
        const written = setPendingFlag.mock.invocationCallOrder.at(-1)!;
        expect(setPendingFlag).toHaveBeenLastCalledWith(account.publicKey, false);
        expect(mockClearProgress.mock.invocationCallOrder.some(order => order > written)).toBe(true);
        expect(records.has(account.publicKey)).toBe(false);
      } finally {
        mockReportProgress.mockReset();
        mockClearProgress.mockReset();
        jest
          .mocked(recoverGuardianHistory)
          .mockReset()
          .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 });
      }
    }

    it('keeps the history record when the wallet locks before the write, and the retry resumes at history', async () => {
      await resumesAtHistory(locked, 0);
      expect(setPendingFlag).toHaveBeenCalledTimes(1);
    });

    it('keeps the history record when the write fails, and the retry resumes at history', async () => {
      setPendingFlag.mockRejectedValueOnce(new Error('encrypt failed'));
      await resumesAtHistory(() => {}, 1);
      expect(setPendingFlag).toHaveBeenCalledTimes(2);
    });
  });

  // Whoever debugs a stuck recovery reads these lines to decide whether a
  // resume point exists. Only the backfill writes one.
  it('does not claim a checkpoint when it defers before the backfill', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockImplementationOnce(async () => {
      mockUncompleted.mockResolvedValue([{ id: 'tx-1' }] as never);
    });
    const logged = jest.mocked(console.log);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    const lines = logged.mock.calls.map(([line]) => String(line));
    expect(lines.some(line => line.includes('the next pass starts over'))).toBe(true);
    expect(lines.some(line => line.includes('Keeping the checkpoint'))).toBe(false);
  });

  describe('note paging within one range', () => {
    it('re-offers the same range at the next note offset', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 999 } as never);
      mockProxy.recoverPublicNotesRange
        .mockResolvedValueOnce({ imported: 200, failures: 0, saturated: false, nextNoteOffset: 200 } as never)
        .mockResolvedValue({ imported: 50, failures: 0, saturated: false } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockProxy.recoverPublicNotesRange.mock.calls).toEqual([
        [account.publicKey, 0, 999, 0],
        [account.publicKey, 0, 999, 200]
      ]);
      // A half-paged range is not scanned, so the watermark waits for the page
      // that finishes it.
      expect(reportedWatermarks()).toEqual([0, 0, 999]);
    });

    // The cursor crosses the realm boundary as JSON. One that fails to advance
    // would re-run the same page forever.
    it.each([
      ['stalls', 200],
      ['goes backwards', 10]
    ])('gives up on the rest of a range whose cursor %s', async (_label, nextNoteOffset) => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 999 } as never);
      mockProxy.recoverPublicNotesRange
        .mockResolvedValueOnce({ imported: 200, failures: 0, saturated: false, nextNoteOffset: 200 } as never)
        .mockResolvedValue({ imported: 0, failures: 0, saturated: false, nextNoteOffset } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockProxy.recoverPublicNotesRange).toHaveBeenCalledTimes(2);
      // Notes were left unimported, so the flag has to stay set.
      expect(setPendingFlag).not.toHaveBeenCalled();
    });
  });

  describe('proposal note import', () => {
    it('imports in bounded batches and re-stamps the card after each one', async () => {
      // One call per batch, because on mobile and desktop it runs inline and
      // holds the single WASM mutex for the whole batch; and the card has to be
      // re-stamped as it goes or it ages out mid-phase.
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      guardianOffersProposalNotes(30);
      mockProxy.importRecoveryNoteBytes.mockResolvedValue({ imported: 25, failures: 0 } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockProxy.importRecoveryNoteBytes.mock.calls.map(([batch]) => batch.length)).toEqual([25, 5]);
      const proposalReports = mockReportProgress.mock.calls.filter(([progress]) => progress.step === 'proposals');
      expect(proposalReports.length).toBeGreaterThanOrEqual(3);
    });

    it('stops between batches when a transaction appears', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      guardianOffersProposalNotes(30);
      mockProxy.importRecoveryNoteBytes.mockImplementationOnce(async () => {
        mockUncompleted.mockResolvedValue([{ id: 'auto-consume' }] as never);
        return { imported: 25, failures: 0 } as never;
      });

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockProxy.importRecoveryNoteBytes).toHaveBeenCalledTimes(1);
      // Gave up its turn before ever reaching the backfill.
      expect(mockProxy.recoverPublicNotesRange).not.toHaveBeenCalled();
      expect(setPendingFlag).not.toHaveBeenCalled();
    });

    it('counts notes the import rejected, so the flag stays set', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      guardianOffersProposalNotes(5);
      mockProxy.importRecoveryNoteBytes.mockResolvedValue({ imported: 3, failures: 2 } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).not.toHaveBeenCalled();
    });

    // A consume proposal in a shape this build cannot read may still be
    // carrying notes. Skipping it quietly would let the pass finish clean and
    // clear the one-shot flag over them.
    it.each([1, 3])('keeps the recovery pending for an unreadable metadata version %i', async version => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      guardianOffersProposalNotes(5, version);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockProxy.importRecoveryNoteBytes).not.toHaveBeenCalled();
      expect(setPendingFlag).not.toHaveBeenCalled();
    });

    // One null entry in a remote list must cost one proposal, not the notes
    // already collected from the proposals before it.
    it('keeps the notes it already collected when one proposal is malformed', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      jest.mocked(GuardianHttpClient).mockImplementation(
        () =>
          ({
            setSigner: jest.fn(),
            getState: jest.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' }),
            getDeltaProposals: jest.fn().mockResolvedValue([
              {
                deltaPayload: {
                  metadata: {
                    proposalType: 'consume_notes',
                    consumeNotesMetadataVersion: 2,
                    consumeNotesNotes: ['AQID']
                  }
                }
              },
              null,
              { deltaPayload: undefined }
            ])
          }) as never
      );
      mockProxy.importRecoveryNoteBytes.mockResolvedValue({ imported: 1, failures: 0 } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(mockProxy.importRecoveryNoteBytes).toHaveBeenCalledWith([expect.any(Uint8Array)]);
      // The malformed entries are still a failed source, so the flag stays set.
      expect(setPendingFlag).not.toHaveBeenCalled();
    });

    // Capping what is KEPT does not cap the work: a response listing a million
    // proposals of the wrong type is rejected entry by entry, and that
    // iteration is the cost. Going over the bound is a failed source, so the
    // remainder is retried rather than silently dropped.
    it('keeps the recovery pending when the Guardian lists more proposals than it will examine', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      guardianOffersProposalCount(1_500);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).not.toHaveBeenCalled();
    });

    it('keeps the recovery pending when the Guardian offers more notes than the cap', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      guardianOffersProposalNotes(600);
      mockProxy.importRecoveryNoteBytes.mockResolvedValue({ imported: 25, failures: 0 } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      // Capped at 500 notes = 20 full batches, and truncation counts as a
      // failed source so the remainder is retried rather than dropped.
      const imported = mockProxy.importRecoveryNoteBytes.mock.calls.reduce((sum, [batch]) => sum + batch.length, 0);
      expect(imported).toBe(500);
      expect(setPendingFlag).not.toHaveBeenCalled();
    });
  });

  it('does not scan from genesis when the Guardian client could not be built', async () => {
    // Without a Guardian there is no creation block, so the range would be
    // genesis→tip; and since the same failure keeps the flag set, every backend
    // start would re-walk the entire chain.
    const account = pendingAccount({ coldPublicKey: undefined });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(mockProxy.resolveRecoveryScanRange).not.toHaveBeenCalled();
    expect(mockProxy.recoverPublicNotesRange).not.toHaveBeenCalled();
  });

  it('runs one account at a time', async () => {
    const first = pendingAccount();
    const second = pendingAccount();
    let concurrent = 0;
    let peak = 0;
    mockProxy.drainPrivateNoteTransport.mockImplementation(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent--;
    });

    await maybeStartGuardianRecovery(first);
    await maybeStartGuardianRecovery(second);
    await drainDetachedRun();

    expect(peak).toBe(1);
  });
});

// A failed source keeps the flag and the reservation, and the history-partial card promises a
// retry at the next unlock; locking the wallet is what releases the reservation for it.
describe('release on lock', () => {
  function pending<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(settle => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  it('retries a run that kept the flag for a failed history source after the next lock', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockResolvedValueOnce({
      deferred: false,
      sourceFailures: 1,
      restored: 0,
      deferredSources: 0
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);

    releaseGuardianRecoveriesOnLock();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
    expect(recoverGuardianHistory).toHaveBeenCalledTimes(2);
  });

  it('retries a run that kept the flag for a failed notes source after the next lock', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.recoverPublicNotesRange.mockRejectedValueOnce(new Error('node unavailable'));
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 10 } as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();
    expect(setPendingFlag).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);

    releaseGuardianRecoveriesOnLock();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
    expect(mockProxy.recoverPublicNotesRange).toHaveBeenCalledTimes(2);
  });

  it('keeps the reservation of a run still in flight when the wallet locks', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    const drain = pending();
    mockProxy.drainPrivateNoteTransport.mockImplementationOnce(() => drain.promise as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();
    try {
      expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(1);
      releaseGuardianRecoveriesOnLock();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    } finally {
      // Runs are serialized, so a run left open would hold every later test's run behind it.
      drain.resolve();
      await drainDetachedRun();
    }
  });

  // A history-failed run clears the flag and keeps its reservation as a clean run does, and never joins the
  // release set, so a lock does not offer it again.
  it('keeps a run that ended history-failed out of the lock release', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest
      .mocked(recoverGuardianHistory)
      .mockResolvedValueOnce({ deferred: false, sourceFailures: 1, restored: 0, failed: true, deferredSources: 0 });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    releaseGuardianRecoveriesOnLock();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(1);
  });

  it('writes no history-failed record for a wallet replaced while the pass ran', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockImplementationOnce(async () => {
      mockReadGeneration.mockResolvedValue('gen-2');
      return { deferred: false, sourceFailures: 1, restored: 0, failed: true, deferredSources: 0 };
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(mockReportProgress).not.toHaveBeenCalledWith(expect.objectContaining({ step: 'history-failed' }));
    expect(setPendingFlag).not.toHaveBeenCalled();
  });

  it('writes no history-partial record and keeps no reservation for a wallet replaced while the pass ran', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockImplementationOnce(async () => {
      mockReadGeneration.mockResolvedValue('gen-2');
      return { deferred: false, sourceFailures: 1, restored: 2, deferredSources: 0 };
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(mockReportProgress).not.toHaveBeenCalledWith(expect.objectContaining({ step: 'history-partial' }));
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
  });

  it('keeps no reservation for a wallet replaced while a notes pass that failed a source ran', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    mockProxy.drainPrivateNoteTransport.mockImplementationOnce(async () => {
      mockReadGeneration.mockResolvedValue('gen-2');
      throw new Error('transport unavailable');
    });
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(recoverGuardianHistory).not.toHaveBeenCalled();
      expect(setPendingFlag).not.toHaveBeenCalled();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      mockProxy.drainPrivateNoteTransport.mockReset();
    }
  });

  it('keeps no reservation for a wallet replaced while a run that threw ran', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockImplementationOnce(async () => {
      mockReadGeneration.mockResolvedValue('gen-2');
      throw new Error('storage unavailable');
    });
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      expect(setPendingFlag).not.toHaveBeenCalled();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      jest
        .mocked(recoverGuardianHistory)
        .mockReset()
        .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 });
    }
  });

  it('releases a failed run whose lock lands while it re-reads the generation', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockRejectedValueOnce(new Error('storage unavailable'));
    mockReadGeneration.mockResolvedValueOnce('gen-1').mockImplementationOnce(async () => {
      releaseGuardianRecoveriesOnLock();
      return 'gen-1';
    });
    try {
      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await drainDetachedRun();
    } finally {
      mockReadGeneration.mockReset();
      jest
        .mocked(recoverGuardianHistory)
        .mockReset()
        .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 });
    }
  });

  it('retries a notes pass that fails a source and finishes after the lock', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    const sync = pending();
    mockProxy.drainPrivateNoteTransport.mockRejectedValueOnce(new Error('transport unavailable'));
    mockDoSync.mockImplementationOnce(() => sync.promise as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();
    try {
      expect(mockDoSync).toHaveBeenCalledTimes(1);
      releaseGuardianRecoveriesOnLock();
    } finally {
      sync.resolve();
      await drainDetachedRun();
    }

    expect(setPendingFlag).not.toHaveBeenCalled();
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('retries a partial history whose progress write finishes after the lock', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    const write = pending();
    jest.mocked(recoverGuardianHistory).mockResolvedValueOnce({
      deferred: false,
      sourceFailures: 1,
      restored: 0,
      deferredSources: 0
    });
    mockReportProgress.mockImplementation(async progress => {
      if (progress.step === 'history-partial') await write.promise;
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();
    try {
      expect(mockReportProgress).toHaveBeenCalledWith(expect.objectContaining({ step: 'history-partial' }));
      releaseGuardianRecoveriesOnLock();
    } finally {
      write.resolve();
      await drainDetachedRun();
      mockReportProgress.mockReset();
    }

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('retries a run that threw after the lock', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(recoverGuardianHistory).mockRejectedValueOnce(new Error('storage unavailable'));

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();
    expect(setPendingFlag).not.toHaveBeenCalled();
    releaseGuardianRecoveriesOnLock();

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });
});

/** The real history pass reads IndexedDB and storage, which settle on macrotasks the microtask drain never reaches. */
async function settleRealHistory(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  await drainDetachedRun();
}

describe('an operator the account may never have used', () => {
  it('keeps the flag while it does not serve history, and asks it again after the next lock', async () => {
    const actual = jest.requireActual<typeof import('./guardian-history-recovery')>('./guardian-history-recovery');
    const actualStorage = jest.requireActual<typeof import('lib/miden/guardian/history-storage')>(
      'lib/miden/guardian/history-storage'
    );
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    const histories = new Map([
      ['https://guardian.test', jest.fn().mockResolvedValue({ entries: [] })],
      [
        'https://builtin.test',
        jest
          .fn()
          .mockRejectedValueOnce(new GuardianHttpError(404, 'Not Found', ''))
          .mockResolvedValue({ entries: [] })
      ]
    ]);
    jest.mocked(GuardianHttpClient).mockImplementation(
      (endpoint: string) =>
        ({
          setSigner: jest.fn(),
          getState: jest.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' }),
          getDeltaProposals: jest.fn().mockResolvedValue([]),
          getDeltaHistory: histories.get(endpoint)
        }) as never
    );
    mockReadGeneration.mockImplementation(actualStorage.readGuardianHistoryGeneration);
    jest.mocked(recoverGuardianHistory).mockImplementation(actual.recoverGuardianHistory);
    const steps = () => mockReportProgress.mock.calls.map(([progress]) => progress.step);
    try {
      await maybeStartGuardianRecovery(account);
      await settleRealHistory(() => steps().includes('history-partial') || setPendingFlag.mock.calls.length > 0);

      expect(setPendingFlag).not.toHaveBeenCalled();
      expect(steps()).toContain('history-partial');
      expect(histories.get('https://builtin.test')).toHaveBeenCalledTimes(1);

      releaseGuardianRecoveriesOnLock();
      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
      await settleRealHistory(() => setPendingFlag.mock.calls.length > 0);

      expect(histories.get('https://builtin.test')).toHaveBeenCalledTimes(2);
      expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
    } finally {
      jest
        .mocked(recoverGuardianHistory)
        .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 });
    }
  });
});

describe('a node that reports no fee', () => {
  it('stops recovery and clears the flag, keeping the failed record', async () => {
    const actual = jest.requireActual<typeof import('./guardian-history-recovery')>('./guardian-history-recovery');
    const actualStorage = jest.requireActual<typeof import('lib/miden/guardian/history-storage')>(
      'lib/miden/guardian/history-storage'
    );
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    const timestamp = '2026-08-01T00:00:00Z';
    jest.mocked(GuardianHttpClient).mockImplementation(
      () =>
        ({
          setSigner: jest.fn(),
          getState: jest.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' }),
          getDeltaProposals: jest.fn().mockResolvedValue([]),
          getDeltaHistory: jest.fn().mockResolvedValue({
            entries: [
              {
                nonce: 1,
                status: 'canonical',
                timestamp,
                newCommitment: 'commitment-1',
                inputNotes: [],
                outputNotes: [],
                decodeWarnings: []
              }
            ]
          }),
          getDelta: jest.fn().mockResolvedValue({
            accountId: account.publicKey,
            nonce: 1,
            prevCommitment: '',
            newCommitment: 'commitment-1',
            deltaPayload: { txSummary: { data: '1' }, signatures: [] },
            status: { status: 'canonical', timestamp },
            metadata: { proposal: { proposalType: 'p2id' } }
          })
        }) as never
    );
    mockProxy.decodeGuardianHistory.mockRejectedValueOnce(new GuardianHistoryFeeUnavailableError());
    mockReadGeneration.mockImplementation(actualStorage.readGuardianHistoryGeneration);
    jest.mocked(terminalGuardianHistoryGeneration).mockImplementation(actual.terminalGuardianHistoryGeneration);
    jest.mocked(recoverGuardianHistory).mockImplementationOnce(actual.recoverGuardianHistory);
    const steps = () => mockReportProgress.mock.calls.map(([progress]) => progress.step);

    await maybeStartGuardianRecovery(account);
    await settleRealHistory(() => setPendingFlag.mock.calls.length > 0 || steps().includes('history-partial'));
    expect(steps()).toContain('history-failed');
    const reportedAt = mockReportProgress.mock.invocationCallOrder[steps().indexOf('history-failed')]!;
    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
    expect(setPendingFlag.mock.invocationCallOrder[0]).toBeGreaterThan(reportedAt);
    expect(mockClearProgress.mock.invocationCallOrder.every(order => order < reportedAt)).toBe(true);

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    await drainDetachedRun();
    expect(recoverGuardianHistory).toHaveBeenCalledTimes(1);
    expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(1);
  });
});

describe('a source failure that repeats every session', () => {
  async function runSessions(
    history: jest.Mock,
    sessions: number,
    prepare: (account: WalletAccount) => Promise<void> = async () => {},
    builtin: jest.Mock = jest.fn().mockResolvedValue({ entries: [] })
  ) {
    const actual = jest.requireActual<typeof import('./guardian-history-recovery')>('./guardian-history-recovery');
    const actualStorage = jest.requireActual<typeof import('lib/miden/guardian/history-storage')>(
      'lib/miden/guardian/history-storage'
    );
    const account = pendingAccount({ coldPublicKey: '0xcold' });
    jest.mocked(GuardianHttpClient).mockImplementation(
      (endpoint: string) =>
        ({
          setSigner: jest.fn(),
          getState: jest.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' }),
          getDeltaProposals: jest.fn().mockResolvedValue([]),
          getDeltaHistory: endpoint === 'https://guardian.test' ? history : builtin
        }) as never
    );
    mockReadGeneration.mockImplementation(actualStorage.readGuardianHistoryGeneration);
    jest.mocked(recoverGuardianHistory).mockImplementation(actual.recoverGuardianHistory);
    await prepare(account);
    const ends: string[][] = [];
    const flagWrites = () => setPendingFlag.mock.calls.length;
    try {
      for (let session = 0; session < sessions; session++) {
        const before = mockReportProgress.mock.calls.length;
        const flagsBefore = flagWrites();
        const ended = () =>
          mockReportProgress.mock.calls
            .slice(before)
            .map(([progress]) => progress.step)
            .filter(step => step === 'history-partial' || step === 'history-failed');
        await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
        await settleRealHistory(() => ended().length > 0 || flagWrites() > flagsBefore);
        ends.push(ended());
        releaseGuardianRecoveriesOnLock();
      }
    } finally {
      jest
        .mocked(recoverGuardianHistory)
        .mockResolvedValue({ deferred: false, sourceFailures: 0, restored: 0, deferredSources: 0 });
    }
    return { account, ends };
  }

  /** A page that overflows the entry cap from the checkpoint `resumeAtEntryCap` saves. */
  const entryCapOverflow = () =>
    jest.fn().mockResolvedValue({
      entries: [50, 49].map(nonce => ({
        nonce,
        status: 'canonical',
        timestamp: '2026-08-01T00:00:00Z',
        newCommitment: `commitment-${nonce}`,
        inputNotes: [],
        outputNotes: [],
        decodeWarnings: []
      }))
    });

  async function resumeAtEntryCap(walletAccount: WalletAccount) {
    const actualStorage = jest.requireActual<typeof import('lib/miden/guardian/history-storage')>(
      'lib/miden/guardian/history-storage'
    );
    const network = getEffectiveNetworkName();
    const accountId = canonicalWalletAccountId(walletAccount.publicKey);
    await actualStorage.saveGuardianHistoryCheckpoint(await actualStorage.readGuardianHistoryGeneration(), {
      id: historyCheckpointId(network, accountId, 'https://guardian.test'),
      network,
      accountId,
      operator: 'https://guardian.test',
      version: GUARDIAN_HISTORY_VERSION,
      cursor: 'resume',
      seenCursors: [],
      completed: false,
      restored: 0,
      lowestNonce: 100,
      entryCount: MAX_HISTORY_ENTRIES_PER_SOURCE - 1
    });
  }

  it('stops a current operator that overflows the entry cap on the third session and clears the flag', async () => {
    const history = entryCapOverflow();
    const { account, ends } = await runSessions(history, 3, resumeAtEntryCap);

    expect(ends).toEqual([['history-partial'], ['history-partial'], ['history-failed']]);
    expect(history).toHaveBeenCalledTimes(3);
    expect(setPendingFlag).toHaveBeenCalledTimes(1);
    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
  });

  it.each<[string, () => jest.Mock, ((account: WalletAccount) => Promise<void>) | undefined]>([
    ['serves no history', () => jest.fn().mockRejectedValue(new GuardianHttpError(404, 'Not Found', '')), undefined],
    ['overflows the entry cap', entryCapOverflow, resumeAtEntryCap]
  ])(
    'clears the flag at the next offer without running again when a current operator that %s fails terminally and the flag write fails',
    async (_case, serve, prepare) => {
      const actual = jest.requireActual<typeof import('./guardian-history-recovery')>('./guardian-history-recovery');
      jest.mocked(terminalGuardianHistoryGeneration).mockImplementation(actual.terminalGuardianHistoryGeneration);
      setPendingFlag.mockRejectedValueOnce(new Error('encrypt failed'));
      const history = serve();
      const { account, ends } = await runSessions(history, 3, prepare);

      expect(ends).toEqual([['history-partial'], ['history-partial'], ['history-failed']]);
      expect(setPendingFlag).toHaveBeenCalledTimes(1);
      await expect(setPendingFlag.mock.results[0]?.value).rejects.toThrow('encrypt failed');
      const drains = mockProxy.drainPrivateNoteTransport.mock.calls.length;
      const ranges = mockProxy.resolveRecoveryScanRange.mock.calls.length;
      const asked = history.mock.calls.length;

      await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
      await drainDetachedRun();
      expect(setPendingFlag).toHaveBeenCalledTimes(2);
      expect(setPendingFlag).toHaveBeenLastCalledWith(account.publicKey, false);
      expect(mockProxy.drainPrivateNoteTransport).toHaveBeenCalledTimes(drains);
      expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledTimes(ranges);
      expect(history).toHaveBeenCalledTimes(asked);
    }
  );

  it('keeps the flag for a current operator that fails with a network error every session', async () => {
    const history = jest.fn().mockRejectedValue(new Error('offline'));
    const { ends } = await runSessions(history, 4);

    expect(ends).toEqual([['history-partial'], ['history-partial'], ['history-partial'], ['history-partial']]);
    expect(setPendingFlag).not.toHaveBeenCalled();
  });

  it('clears the flag once an operator the account never used has failed three sessions', async () => {
    const history = jest.fn().mockResolvedValue({ entries: [] });
    const builtin = jest.fn().mockRejectedValue(new Error('offline'));
    const { account, ends } = await runSessions(history, 3, undefined, builtin);

    expect(ends).toEqual([['history-partial'], ['history-partial'], []]);
    expect(setPendingFlag).toHaveBeenCalledTimes(1);
    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
  });
});

it('does not start recovery after a persisted fee-metadata failure', async () => {
  jest.mocked(terminalGuardianHistoryGeneration).mockResolvedValue('gen-1');
  const account = pendingAccount();
  await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
  expect(mockProxy.drainPrivateNoteTransport).not.toHaveBeenCalled();
  expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
});

it('leaves the flag to a wallet imported after the start gate judged a terminal checkpoint', async () => {
  const actual = jest.requireActual<typeof import('./guardian-history-recovery')>('./guardian-history-recovery');
  const actualStorage = jest.requireActual<typeof import('lib/miden/guardian/history-storage')>(
    'lib/miden/guardian/history-storage'
  );
  const account = pendingAccount();
  const network = getEffectiveNetworkName();
  const accountId = canonicalWalletAccountId(account.publicKey);
  mockReadGeneration.mockImplementation(actualStorage.readGuardianHistoryGeneration);
  await actualStorage.saveGuardianHistoryCheckpoint(await actualStorage.readGuardianHistoryGeneration(), {
    id: historyCheckpointId(network, accountId, 'https://guardian.test'),
    network,
    accountId,
    operator: 'https://guardian.test',
    version: GUARDIAN_HISTORY_VERSION,
    seenCursors: [],
    completed: false,
    restored: 0,
    failure: 'unsupported',
    unsupportedPasses: 3,
    terminal: true
  });
  jest.mocked(terminalGuardianHistoryGeneration).mockImplementation(actual.terminalGuardianHistoryGeneration);
  // The import lands after the gate judged the checkpoint, so the first generation read is already the new wallet's.
  mockReadGeneration.mockImplementationOnce(async () => {
    await actualStorage.clearGuardianHistoryCheckpoints();
    return actualStorage.readGuardianHistoryGeneration();
  });
  try {
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);
    await drainDetachedRun();
    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockAccountsUpdated).not.toHaveBeenCalled();
    expect(mockProxy.drainPrivateNoteTransport).not.toHaveBeenCalled();

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
    await drainDetachedRun();
  } finally {
    mockReadGeneration.mockReset();
  }
});

it('reports a terminal history failure, then clears the flag and keeps the failed record', async () => {
  const account = pendingAccount({ coldPublicKey: '0xcold' });
  jest.mocked(recoverGuardianHistory).mockResolvedValueOnce({
    deferred: false,
    sourceFailures: 1,
    restored: 0,
    failed: true,
    deferredSources: 0
  });
  await maybeStartGuardianRecovery(account);
  await drainDetachedRun();
  const failedReport = mockReportProgress.mock.calls.findIndex(([progress]) => progress.step === 'history-failed');
  expect(failedReport).toBeGreaterThanOrEqual(0);
  const reportedAt = mockReportProgress.mock.invocationCallOrder[failedReport]!;
  expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
  expect(setPendingFlag.mock.invocationCallOrder[0]).toBeGreaterThan(reportedAt);
  // Only the notes pass's own finally clears the record.
  expect(mockClearProgress).toHaveBeenCalledTimes(1);
  expect(mockClearProgress.mock.invocationCallOrder[0]).toBeLessThan(reportedAt);
});
