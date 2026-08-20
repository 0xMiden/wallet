import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import {
  clearGuardianNoteRecoveryProgress,
  fetchGuardianNoteRecoveryProgress,
  reportGuardianNoteRecoveryProgress
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
const mockReportProgress = jest.mocked(reportGuardianNoteRecoveryProgress);
const mockProxy = jest.mocked(midenClientProxy);

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
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  setPendingFlag = jest.fn().mockResolvedValue([]);
  guardianOffersProposalNotes(0);
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
        updatedAt: Date.now(),
        sourcesClean: true
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
        sourcesClean: true
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
    expect(backfillRanges()).toEqual([[0, 199_999]]);
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
