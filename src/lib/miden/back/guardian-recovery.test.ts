import {
  clearGuardianNoteRecoveryProgress,
  fetchGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';
import { getAllUncompletedTransactions } from 'lib/miden/transaction/get';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { maybeStartGuardianRecovery } from './guardian-recovery';
import { midenClientProxy } from './miden-client-proxy';
import { OperationAbortedError } from './offscreen-codec';
import { accountsUpdated, store } from './store';

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
    recoverPublicNotesRange: jest.fn()
  }
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
  }))
}));
jest.mock('lib/guardian-note-recovery-progress', () => ({
  reportGuardianNoteRecoveryProgress: jest.fn(),
  clearGuardianNoteRecoveryProgress: jest.fn(),
  fetchGuardianNoteRecoveryProgress: jest.fn()
}));
jest.mock('./store', () => ({
  store: { getState: jest.fn() },
  accountsUpdated: jest.fn()
}));

const mockUncompleted = jest.mocked(getAllUncompletedTransactions);
const mockGetState = jest.mocked(store.getState);
const mockAccountsUpdated = jest.mocked(accountsUpdated);
const mockClearProgress = jest.mocked(clearGuardianNoteRecoveryProgress);
const mockFetchProgress = jest.mocked(fetchGuardianNoteRecoveryProgress);
const mockProxy = jest.mocked(midenClientProxy);

// `startedRecoveries` and the queue are module state, so each test gets a fresh
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

/** Lets the detached run (queued, then several awaits deep) reach its end. */
async function drainDetachedRun() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  setPendingFlag = jest.fn().mockResolvedValue([]);
  unlocked();
  mockUncompleted.mockResolvedValue([]);
  mockFetchProgress.mockResolvedValue(null);
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
  });

  it('keeps the flag set when the Guardian client cannot be built', async () => {
    const account = pendingAccount({ coldPublicKey: undefined });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockClearProgress).toHaveBeenCalledWith(account.publicKey);
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

    expect(mockProxy.recoverPublicNotesRange.mock.calls.map(call => call.slice(1))).toEqual([
      [0, 1_999],
      [0, 999],
      [1_000, 1_999]
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
      [0, 1],
      [0, 0],
      [1, 1]
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
    });

    it('resumes at the checkpointed block and skips the sources it already did', async () => {
      const account = pendingAccount({ coldPublicKey: '0xcold' });
      mockFetchProgress.mockResolvedValue({
        accountId: account.publicKey,
        step: 'public',
        startBlock: 0,
        syncedToBlock: 200_000,
        latestBlock: 400_000,
        updatedAt: Date.now()
      });
      mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 400_000 } as never);

      await maybeStartGuardianRecovery(account);
      await drainDetachedRun();

      // Neither expensive source is re-paid.
      expect(mockProxy.drainPrivateNoteTransport).not.toHaveBeenCalled();
      expect(mockProxy.importRecoveryNoteBytes).not.toHaveBeenCalled();
      // The creation-block search is skipped too: 0 means "just give me the tip".
      expect(mockProxy.resolveRecoveryScanRange).toHaveBeenCalledWith(0);
      // Scanning restarts at the checkpoint, not at block 0.
      expect(mockProxy.recoverPublicNotesRange.mock.calls[0]?.[1]).toBe(200_000);
      expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
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
