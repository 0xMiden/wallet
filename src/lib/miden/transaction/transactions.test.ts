import { ITransactionStatus, Transaction } from '../db/types';
import { NoteTypeEnum } from '../types';
// Import after mocks are set up
import {
  hasQueuedTransactions,
  getTransactionsInProgress,
  getAllUncompletedTransactions,
  getFailedTransactions,
  getCompletedTransactions,
  getTransactionById,
  cancelTransactionById,
  cancelTransaction,
  updateTransactionStatus,
  initiateSendTransaction,
  initiateConsumeTransaction,
  initiateConsumeTransactionFromId,
  initiateUpdateProcedureThresholdTransaction,
  cancelStuckTransactions,
  cancelStaleQueuedTransactions,
  failInterruptedTransactions,
  generateTransaction,
  MAX_WAIT_BEFORE_CANCEL,
  MAX_QUEUED_AGE,
  REMOTE_PROVER_FAILED_ERROR,
  REMOTE_PROVER_TIMEOUT_ERROR,
  LOCAL_PROVER_FAILED_ERROR,
  RETRY_COOLDOWN_SEC,
  MAX_RETRY_BACKOFF_SEC
} from './index';

// Only the note-transport predicate is swapped; every other endpoint getter keeps
// its real behaviour, since the send guard is the sole thing under test here.
// Defaults to configured so the rest of the file is unaffected.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  isNoteTransportConfigured: () => (globalThis as { __ntlConfigured?: boolean }).__ntlConfigured ?? true
}));

// Mock functions defined inside factory to avoid hoisting issues with SWC
const mockTransactionsFilter = jest.fn();
const mockTransactionsWhere = jest.fn();
const mockTransactionsAdd = jest.fn();

jest.mock('lib/miden/repo', () => {
  // These will be assigned after module initialization
  return {
    get db() {
      return {
        // Run the body inline so the existing mockTransactionsWhere / mockTransactionsAdd
        // wiring the tests already set up still drives behavior. In prod, Dexie serializes
        // concurrent rw transactions at the DB level — this mock preserves the "body runs
        // with atomic check+add" contract without the real atomicity machinery.
        transaction: (_mode: string, _table: unknown, cb: () => Promise<unknown>) => cb()
      };
    },
    get transactions() {
      return {
        filter: mockTransactionsFilter,
        where: mockTransactionsWhere,
        add: mockTransactionsAdd
      };
    }
  };
});

const mockGetInputNote = jest.fn();
const mockSyncState = jest.fn().mockResolvedValue({ blockNum: () => 1 });
const mockGetMidenClient = jest.fn((): any => ({
  syncState: mockSyncState,
  getInputNote: mockGetInputNote
}));
// The #260 offscreen client proxy reads (syncState/getAccount) through the
// `lib/...` alias of miden-client, which jest mocks separately from the relative
// specifier below; delegate the alias to the same mock so the proxy's flag-off
// passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: jest.fn((fn: () => Promise<any>) => fn())
}));

jest.mock('../activity/notes', () => ({
  importAllNotes: jest.fn(),
  queueNoteImport: jest.fn()
}));

describe('transactions utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('hasQueuedTransactions', () => {
    it('returns true when queued transactions exist', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([{ id: 'tx-1', status: ITransactionStatus.Queued }])
      });

      const result = await hasQueuedTransactions();

      expect(result).toBe(true);
    });

    it('returns false when no queued transactions', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([])
      });

      const result = await hasQueuedTransactions();

      expect(result).toBe(false);
    });
  });

  describe('getTransactionsInProgress', () => {
    it('returns transactions in GeneratingTransaction status sorted by initiatedAt', async () => {
      const tx1 = { id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 200 };
      const tx2 = { id: 'tx-2', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 100 };
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([tx1, tx2])
      });

      const result = await getTransactionsInProgress();

      expect(result[0]!.id).toBe('tx-2'); // Earlier initiatedAt first
      expect(result[1]!.id).toBe('tx-1');
    });
  });

  describe('getAllUncompletedTransactions', () => {
    it('returns queued and generating transactions', async () => {
      const txs = [
        { id: 'tx-1', status: ITransactionStatus.Queued, initiatedAt: 100 },
        { id: 'tx-2', status: ITransactionStatus.GeneratingTransaction, initiatedAt: 200 }
      ];
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce(txs)
      });

      const result = await getAllUncompletedTransactions();

      expect(result).toHaveLength(2);
    });
  });

  describe('getFailedTransactions', () => {
    it('returns failed transactions sorted by initiatedAt', async () => {
      const tx1 = { id: 'tx-1', status: ITransactionStatus.Failed, initiatedAt: 200 };
      const tx2 = { id: 'tx-2', status: ITransactionStatus.Failed, initiatedAt: 100 };
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([tx1, tx2])
      });

      const result = await getFailedTransactions();

      expect(result[0]!.id).toBe('tx-2');
    });
  });

  describe('getCompletedTransactions', () => {
    it('returns completed transactions for account', async () => {
      const txs = [
        { id: 'tx-1', status: ITransactionStatus.Completed, accountId: 'acc-1', completedAt: 100 },
        { id: 'tx-2', status: ITransactionStatus.Completed, accountId: 'acc-2', completedAt: 200 }
      ];
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce(txs)
      });

      const result = await getCompletedTransactions('acc-1');

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('tx-1');
    });

    it('includes failed transactions when includeFailed is true', async () => {
      const completedTxs = [{ id: 'tx-1', status: ITransactionStatus.Completed, accountId: 'acc-1', completedAt: 100 }];
      const failedTxs = [{ id: 'tx-2', status: ITransactionStatus.Failed, accountId: 'acc-1', initiatedAt: 200 }];

      mockTransactionsFilter
        .mockReturnValueOnce({ toArray: jest.fn().mockResolvedValueOnce(completedTxs) })
        .mockReturnValueOnce({ toArray: jest.fn().mockResolvedValueOnce(failedTxs) });

      const result = await getCompletedTransactions('acc-1', undefined, undefined, true);

      expect(result).toHaveLength(2);
    });
  });

  describe('getTransactionById', () => {
    it('returns transaction when found', async () => {
      const tx = { id: 'tx-1', accountId: 'acc-1' };
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(tx)
      });

      const result = await getTransactionById('tx-1');

      expect(result).toEqual(tx);
    });

    it('throws when transaction not found', async () => {
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(undefined)
      });

      await expect(getTransactionById('nonexistent')).rejects.toThrow('Transaction not found');
    });
  });

  describe('cancelTransactionById', () => {
    it('cancels transaction when found', async () => {
      const tx = { id: 'tx-1' };
      const mockModify = jest.fn();
      mockTransactionsWhere
        // 1) cancelTransactionById's own lookup
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(tx) })
        // 2) cancelTransaction's finalized-guard lookup (non-finalized → falls through)
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(undefined) })
        // 3) cancelTransaction's actual .modify()
        .mockReturnValueOnce({ modify: mockModify });

      await cancelTransactionById('tx-1', 'Test cancellation');

      expect(mockModify).toHaveBeenCalled();
    });

    it('does nothing when transaction not found', async () => {
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(undefined)
      });

      // Should not throw
      await expect(cancelTransactionById('nonexistent', 'Test cancellation')).resolves.toBeUndefined();
    });
  });

  describe('MAX_WAIT_BEFORE_CANCEL', () => {
    it('is 30 minutes in seconds', () => {
      expect(MAX_WAIT_BEFORE_CANCEL).toBe(30 * 60);
    });
  });

  describe('cancelTransaction', () => {
    it('marks transaction as failed with completedAt timestamp', async () => {
      const mockModify = jest.fn();
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(undefined) })
        .mockReturnValueOnce({ modify: mockModify });

      const tx = { id: 'tx-1' } as Transaction;
      await cancelTransaction(tx, 'Test error');

      expect(mockTransactionsWhere).toHaveBeenCalledWith({ id: 'tx-1' });
      expect(mockModify).toHaveBeenCalled();
    });

    it('refuses to fail a row that completed between the read and the write', async () => {
      // The finalized guard above it is a read in its own Dexie transaction, so
      // it only rejects a row that was ALREADY terminal. A pipeline that commits
      // Completed in the gap — a user cancel racing its own finishing send — was
      // overwritten with Failed, turning a settled send into a reported failure.
      // The guarded `onlyIfStatus` path cannot cover this: it is the callers that
      // pass nothing that need it.
      const dbTx: Record<string, unknown> = {
        id: 'tx-1',
        status: ITransactionStatus.Completed,
        displayIcon: 'SUCCESS'
      };
      const mockModify = jest.fn((fn: (t: Record<string, unknown>) => unknown) => fn(dbTx));
      mockTransactionsWhere
        .mockReturnValueOnce({
          first: jest.fn().mockResolvedValueOnce({ id: 'tx-1', status: ITransactionStatus.GeneratingTransaction })
        })
        .mockReturnValueOnce({ modify: mockModify });

      const applied = await cancelTransaction({ id: 'tx-1' } as Transaction, new Error('late failure'));

      expect(applied).toBe(false);
      expect(dbTx.status).toBe(ITransactionStatus.Completed);
      expect(dbTx.displayIcon).toBe('SUCCESS');
      expect(dbTx.error).toBeUndefined();
      // `false`, not a bare `return`. Dexie skips the put on exactly that value
      // and treats `undefined` as "modified", re-putting the unchanged clone and
      // firing a `liveQuery` event for a write that changed nothing. Nothing
      // else can catch that: the clone equals the row, so every field assertion
      // above passes either way.
      expect(mockModify.mock.results[0]?.value).toBe(false);
    });
  });

  describe('updateTransactionStatus', () => {
    it('updates transaction status and other values', async () => {
      const tx = { id: 'tx-1', status: ITransactionStatus.Queued };
      const mockModify = jest.fn();
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(tx) })
        .mockReturnValueOnce({ modify: mockModify });

      await updateTransactionStatus('tx-1', ITransactionStatus.GeneratingTransaction, {
        processingStartedAt: 12345
      });

      expect(mockModify).toHaveBeenCalled();
    });

    it('stamps stage="complete" on success so a finished tx stops reading as in-flight (#618)', async () => {
      // setTransactionStage refuses post-terminal writes, so without this a
      // completed replace-hot-key froze at 'confirming' and a completed guardian
      // consume at 'guardian-synced' — both of which read as still-running.
      const tx = { id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, stage: 'confirming' };
      const row: Record<string, unknown> = { ...tx };
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(tx) })
        .mockReturnValueOnce({ modify: jest.fn(async (cb: (t: Record<string, unknown>) => void) => cb(row)) });

      await updateTransactionStatus('tx-1', ITransactionStatus.Completed, {});

      expect(row.status).toBe(ITransactionStatus.Completed);
      expect(row.stage).toBe('complete');
    });

    it('stamps complete even when the payload is a whole row carrying a stale stage (#618)', async () => {
      // completeCustomTransaction forwards interpretTransactionResult(...), which is
      // the pick-time row object itself — so the payload DOES carry a `stage` key.
      // A presence check on otherValues.stage would skip the stamp here and let
      // Object.assign write the stale pick-time stage back over the DB's current one.
      const tx = { id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, stage: 'guardian-synced' };
      const row: Record<string, unknown> = { ...tx };
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(tx) })
        .mockReturnValueOnce({ modify: jest.fn(async (cb: (t: Record<string, unknown>) => void) => cb(row)) });

      await updateTransactionStatus('tx-1', ITransactionStatus.Completed, {
        stage: 'creating-proposal',
        transactionId: 'hash-1'
      } as never);

      expect(row.stage).toBe('complete');
      expect(row.transactionId).toBe('hash-1');
    });

    it('preserves the stage on FAILURE — it records where the failure happened (#618)', async () => {
      const tx = { id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, stage: 'creating-proposal' };
      const row: Record<string, unknown> = { ...tx };
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(tx) })
        .mockReturnValueOnce({ modify: jest.fn(async (cb: (t: Record<string, unknown>) => void) => cb(row)) });

      await updateTransactionStatus('tx-1', ITransactionStatus.Failed, {});

      expect(row.status).toBe(ITransactionStatus.Failed);
      expect(row.stage).toBe('creating-proposal');
    });

    it('throws when transaction not found', async () => {
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(undefined)
      });

      await expect(updateTransactionStatus('nonexistent', ITransactionStatus.Completed, {})).rejects.toThrow(
        'No transaction found to update'
      );
    });

    it('throws when transaction already completed', async () => {
      const tx = { id: 'tx-1', status: ITransactionStatus.Completed };
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(tx)
      });

      await expect(updateTransactionStatus('tx-1', ITransactionStatus.Failed, {})).rejects.toThrow(
        'Transaction already in a finalized state'
      );
    });

    it('throws when transaction already failed', async () => {
      const tx = { id: 'tx-1', status: ITransactionStatus.Failed };
      mockTransactionsWhere.mockReturnValueOnce({
        first: jest.fn().mockResolvedValueOnce(tx)
      });

      await expect(updateTransactionStatus('tx-1', ITransactionStatus.Completed, {})).rejects.toThrow(
        'Transaction already in a finalized state'
      );
    });

    it('refuses to overwrite a row that went terminal between the read and the write', async () => {
      // The read above and the write below are separate Dexie transactions, and
      // the terminal writer is no longer always inside the loop lock: the requeue
      // wake's ceiling can fail a stale row from outside it. Lose that race
      // without a write-time check and this writes Completed over the Failed —
      // leaving `error`, `displayIcon: 'FAILED'` and `completedAt` in place,
      // since nothing on the success path clears them. The user sees a FAILED
      // icon and an expiry message on a send that actually went through.
      const row: Record<string, unknown> = { id: 'tx-1', status: ITransactionStatus.GeneratingTransaction };
      mockTransactionsWhere.mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce({ ...row }) });
      let callbackResult: unknown;
      mockTransactionsWhere.mockReturnValueOnce({
        modify: jest.fn(async (cb: (t: Record<string, unknown>) => unknown) => {
          row.status = ITransactionStatus.Failed;
          row.error = 'Transaction expired';
          row.displayIcon = 'FAILED';
          callbackResult = cb(row);
        })
      });

      await expect(updateTransactionStatus('tx-1', ITransactionStatus.Completed, {})).rejects.toThrow(
        'Transaction already in a finalized state'
      );
      expect(row.status).toBe(ITransactionStatus.Failed);
      expect(row.displayIcon).toBe('FAILED');
      // `false`, not a bare `return`: Dexie only skips the put on that exact
      // value, so a bare return would re-put the clone and fire a `liveQuery`
      // event for a write that changed nothing. Invisible in the field
      // assertions above, since the clone matches the row either way.
      expect(callbackResult).toBe(false);
    });
  });

  describe('initiateSendTransaction', () => {
    it('creates and adds a send transaction', async () => {
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateSendTransaction(
        'sender-account',
        'recipient-account',
        'faucet-id',
        NoteTypeEnum.Public,
        BigInt(1000),
        undefined,
        false
      );

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });

    it('refuses a PRIVATE send when no note transport is configured, before anything is queued', async () => {
      // Mainnet has no entry in MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS, so the client
      // is built with no transport — and `relay_private_note` resolves the transport
      // API before it writes its retry outbox, so such a send would land on chain,
      // reach nobody, and leave no retry record. Refusing here is what keeps the
      // assets in the account: nothing has been queued, proved or submitted yet.
      (globalThis as { __ntlConfigured?: boolean }).__ntlConfigured = false;
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      try {
        await expect(
          initiateSendTransaction(
            'sender-account',
            'recipient-account',
            'faucet-id',
            NoteTypeEnum.Private,
            BigInt(1000)
          )
        ).rejects.toThrow(/no note transport service is configured/i);

        // The decisive assertion: no row was written, so there is nothing for the
        // processing loop to pick up and spend.
        expect(mockTransactionsAdd).not.toHaveBeenCalled();
      } finally {
        (globalThis as { __ntlConfigured?: boolean }).__ntlConfigured = true;
      }
    });

    it('still allows a PUBLIC send when no note transport is configured', async () => {
      // A public send carries its whole note on chain and needs no transport, so a
      // transport-less network must not block it.
      (globalThis as { __ntlConfigured?: boolean }).__ntlConfigured = false;
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      try {
        const result = await initiateSendTransaction(
          'sender-account',
          'recipient-account',
          'faucet-id',
          NoteTypeEnum.Public,
          BigInt(1000)
        );

        expect(mockTransactionsAdd).toHaveBeenCalled();
        expect(typeof result).toBe('string');
      } finally {
        (globalThis as { __ntlConfigured?: boolean }).__ntlConfigured = true;
      }
    });

    it('allows a PRIVATE send when note transport IS configured', async () => {
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateSendTransaction(
        'sender-account',
        'recipient-account',
        'faucet-id',
        NoteTypeEnum.Private,
        BigInt(1000)
      );

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });
  });

  describe('initiateConsumeTransaction', () => {
    const note = {
      id: 'note-123',
      faucetId: 'faucet',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: NoteTypeEnum.Private
    };

    // The dedup reads two indexes per note: scalar `noteId` (legacy/single
    // rows) and multi-entry `noteIds` (batch rows). Tests feed legacy rows
    // through the scalar query; batch rows can be supplied separately.
    const mockDedupQuery = (rows: any[], batchRows: any[] = []) => {
      mockTransactionsWhere
        .mockReturnValueOnce({
          equals: jest.fn().mockReturnValueOnce({
            toArray: jest.fn().mockResolvedValueOnce(rows)
          })
        })
        .mockReturnValueOnce({
          equals: jest.fn().mockReturnValueOnce({
            toArray: jest.fn().mockResolvedValueOnce(batchRows)
          })
        });
    };

    it('creates consume transaction when none exists', async () => {
      mockDedupQuery([]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });

    it('returns existing transaction id when a Queued consume exists for same note', async () => {
      const existingTx = {
        id: 'existing-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Queued,
        initiatedAt: 100
      };
      mockDedupQuery([existingTx]);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).toBe('existing-tx');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });

    it('returns existing transaction id when a Completed consume exists for same note', async () => {
      // This is the bug from issue #171: after a consume completes, getConsumableNotes()
      // can still return the note briefly. Without Completed dedup, auto-consume would
      // re-enqueue a fresh tx every SWR poll.
      const existingTx = {
        id: 'completed-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Completed,
        initiatedAt: 100,
        completedAt: 200
      };
      mockDedupQuery([existingTx]);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).toBe('completed-tx');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });

    it('creates a new transaction when only an old Failed consume exists (retry allowed after backoff)', async () => {
      // The dedup query now returns ALL consume rows for the noteId (Failed
      // included), and the bounded-retry policy decides whether to allow a new
      // attempt. A single Failed row means the backoff is only RETRY_COOLDOWN_SEC
      // (2^0), and its `completedAt` is past that → the backoff has elapsed → a
      // fresh attempt (re-probe) is enqueued.
      const nowSec = Math.floor(Date.now() / 1000);
      const oldFailedTx = {
        id: 'old-failed-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - RETRY_COOLDOWN_SEC - 100,
        completedAt: nowSec - RETRY_COOLDOWN_SEC - 50
      };
      mockDedupQuery([oldFailedTx]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
      expect(result).not.toBe('old-failed-tx');
    });

    it('blocks a new attempt while the cooldown has not elapsed since the last Failed', async () => {
      // Most recent Failed completed less than RETRY_COOLDOWN_SEC ago →
      // suppress the new attempt and return the most recent Failed id.
      const nowSec = Math.floor(Date.now() / 1000);
      const recentFailed = {
        id: 'recent-failed-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - 30,
        completedAt: nowSec - 10
      };
      mockDedupQuery([recentFailed]);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).toBe('recent-failed-tx');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });

    it('queues a fresh attempt on a manual retry even while the cooldown has not elapsed', async () => {
      // The bounded-retry gate throttles auto-consume's background polling, but
      // an explicit user retry (manualRetry=true) must bypass it — otherwise the
      // Retry button silently no-ops for up to RETRY_COOLDOWN_SEC.
      const nowSec = Math.floor(Date.now() / 1000);
      const recentFailed = {
        id: 'recent-failed-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - 30,
        completedAt: nowSec - 10
      };
      mockDedupQuery([recentFailed]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note, undefined, true);

      expect(result).not.toBe('recent-failed-tx');
      expect(mockTransactionsAdd).toHaveBeenCalled();
    });

    it('still dedups a manual retry against an in-flight consume for the same note', async () => {
      // manualRetry only bypasses the Failed-row backoff — it must NOT double-queue
      // when a Queued/Generating/Completed row is already in flight.
      const existingTx = {
        id: 'existing-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 100
      };
      mockDedupQuery([existingTx]);

      const result = await initiateConsumeTransaction('account-1', note, undefined, true);

      expect(result).toBe('existing-tx');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });

    it('clears a requeue cooldown on the blocking Queued row so an explicit retry is not silently ignored (#617)', async () => {
      // A guardian 429 requeues the consume as Queued with nextEligibleAt up to
      // 5 min out, and the FIFO loop skips it until then. Dedup means a fresh tap
      // does NOT queue a second row — so without clearing the cooldown, tapping
      // Claim would appear to do nothing for minutes. Regression guard: this is
      // the interaction that made the guardian e2e drain time out.
      const modify = jest.fn(async (cb: (t: Record<string, unknown>) => void) => {
        cb(rowRef);
      });
      const rowRef: Record<string, unknown> = {
        nextEligibleAt: Math.floor(Date.now() / 1000) + 300,
        unauthorizedRetryUntil: Math.floor(Date.now() / 1000) - 60
      };
      const backedOff = {
        id: 'backed-off-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Queued,
        nextEligibleAt: Math.floor(Date.now() / 1000) + 300,
        initiatedAt: 100
      };
      mockDedupQuery([backedOff]);
      mockTransactionsWhere.mockReturnValue({ modify, first: jest.fn().mockResolvedValue(backedOff) });

      const result = await initiateConsumeTransaction('account-1', note, undefined, true);

      expect(result).toBe('backed-off-tx');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
      expect(modify).toHaveBeenCalled();
      expect(rowRef.nextEligibleAt).toBeUndefined();
      // Same argument for the unauthorized budget: a row whose window expired
      // while it sat here would otherwise get no automatic attempt at all on the
      // retry the user just asked for.
      expect(rowRef.unauthorizedRetryUntil).toBeUndefined();
    });

    it('grows the backoff with each failure: a gap that clears one failure still blocks after several', async () => {
      // The backoff doubles with lifetime failures. Five failures require
      // RETRY_COOLDOWN_SEC · 2^4 = 80 min of idle. The most recent failure is
      // RETRY_COOLDOWN_SEC + 100s ago — enough to clear the base cooldown a
      // single failure would impose, but far short of the grown backoff — so the
      // new attempt is suppressed. This is exactly what a sliding window missed.
      const nowSec = Math.floor(Date.now() / 1000);
      const failedRows = Array.from({ length: 5 }, (_, i) => ({
        id: `failed-tx-${i}`,
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - RETRY_COOLDOWN_SEC - 1000 - i,
        completedAt: nowSec - RETRY_COOLDOWN_SEC - 100 - i
      }));
      mockDedupQuery(failedRows);

      const result = await initiateConsumeTransaction('account-1', note);

      // Should reuse the most-recent Failed id (the one with the smallest age).
      expect(result).toBe('failed-tx-0');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });

    it('blocks re-attempt after many lifetime failures even when all are old (terminal-safe backoff #313)', async () => {
      // The original #215 sliding window forgot failures older than 30 min, so a
      // deterministically-unconsumable note that getConsumableNotes keeps offering
      // dripped a fresh failure every RETRY_COOLDOWN_SEC forever. The lifetime
      // exponential backoff counts ALL Failed rows: 10 of them push the required
      // idle gap to MAX_RETRY_BACKOFF_SEC (24h), so a note whose most recent
      // failure was only ~30 min ago is still suppressed rather than re-attempted.
      const nowSec = Math.floor(Date.now() / 1000);
      const failures = Array.from({ length: 10 }, (_, i) => ({
        id: `failed-${i}`,
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - 3600 - 100 - i,
        completedAt: nowSec - 1800 - i // most recent ~30 min ago
      }));
      mockDedupQuery(failures);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(mockTransactionsAdd).not.toHaveBeenCalled();
      expect(result).toBe('failed-0');
    });

    it('does not dedup across different accounts', async () => {
      const otherAccountTx = {
        id: 'other-account-tx',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-2',
        status: ITransactionStatus.Completed,
        initiatedAt: 100
      };
      mockDedupQuery([otherAccountTx]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).not.toBe('other-account-tx');
      expect(mockTransactionsAdd).toHaveBeenCalled();
    });

    // Dedup asks "did THIS wallet already claim this note". A restored row is
    // not evidence of that, and counting one would let a dump naming a note id
    // block that note from ever being claimed.
    it('does not dedup against a row restored from a backup', async () => {
      mockDedupQuery([
        {
          id: 'restored-tx',
          type: 'consume',
          noteId: 'note-123',
          accountId: 'account-1',
          status: ITransactionStatus.Completed,
          restoredFromBackup: true,
          initiatedAt: 100
        }
      ]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(result).not.toBe('restored-tx');
      expect(mockTransactionsAdd).toHaveBeenCalled();
    });

    it('falls back to initiatedAt when a Failed row has no completedAt (backoff still applies)', async () => {
      // Edge case: a Failed row whose `completedAt` was never written (e.g. a
      // crash mid-cancel). Both the sort comparator and the backoff check use
      // `completedAt ?? initiatedAt`, so a row missing `completedAt` must still
      // be considered for the gate. This test exercises the `?? initiatedAt`
      // fallback by ranking a no-completedAt Failed first via initiatedAt and
      // verifying the backoff branch suppresses the new attempt.
      const nowSec = Math.floor(Date.now() / 1000);
      const noCompletedAtFailed = {
        id: 'no-completed-at-failed',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - 5,
        completedAt: undefined
      };
      const olderFailed = {
        id: 'older-failed',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - RETRY_COOLDOWN_SEC - 200,
        completedAt: nowSec - RETRY_COOLDOWN_SEC - 100
      };
      mockDedupQuery([olderFailed, noCompletedAtFailed]);

      const result = await initiateConsumeTransaction('account-1', note);

      // The no-completedAt row sorts first (initiatedAt = nowSec - 5 is the
      // highest effective timestamp), and its initiatedAt-derived "recency" is
      // inside the cooldown window, so suppression returns its id.
      expect(result).toBe('no-completed-at-failed');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });

    it('re-probes a single stale failure with no completedAt once its backoff has elapsed (initiatedAt fallback)', async () => {
      // Same `?? initiatedAt` fallback, single failure: the backoff is only
      // RETRY_COOLDOWN_SEC (2^0), and the row's initiatedAt-derived recency is
      // far past that, so the backoff has elapsed and a fresh attempt is enqueued
      // — the re-probe that keeps this a bounded backoff, not a permanent give-up.
      const nowSec = Math.floor(Date.now() / 1000);
      const ancientNoCompletedAt = {
        id: 'ancient-no-completed-at',
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        initiatedAt: nowSec - RETRY_COOLDOWN_SEC - 10_000,
        completedAt: undefined
      };
      mockDedupQuery([ancientNoCompletedAt]);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(result).not.toBe('ancient-no-completed-at');
    });

    it('re-probes even after many lifetime failures once the capped backoff (24h) has elapsed (#313)', async () => {
      // Terminal-safe, not terminal: the backoff is capped at MAX_RETRY_BACKOFF_SEC,
      // so a note stuck for a long time is still retried roughly daily. If it has
      // since become consumable (reclaim height reached, chain advanced), that probe
      // succeeds and the note recovers on its own — no permanent give-up, no
      // failure-class parsing.
      const nowSec = Math.floor(Date.now() / 1000);
      const failures = Array.from({ length: 12 }, (_, i) => ({
        id: `failed-${i}`,
        type: 'consume',
        noteId: 'note-123',
        accountId: 'account-1',
        status: ITransactionStatus.Failed,
        // Most recent failure is just past the 24h ceiling.
        initiatedAt: nowSec - MAX_RETRY_BACKOFF_SEC - 1000 - i,
        completedAt: nowSec - MAX_RETRY_BACKOFF_SEC - 100 - i
      }));
      mockDedupQuery(failures);
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransaction('account-1', note);

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });

    it('sort comparator hits the `b.completedAt ?? b.initiatedAt` fallback when an interior row lacks completedAt', async () => {
      // Three Failed rows where the middle one (in input order) has
      // `completedAt: undefined`. The sort comparator's pairwise calls force
      // both arms of the `??` on `b`: the missing-completedAt row eventually
      // appears in the `b` slot of a comparison and exercises the fallback.
      const nowSec = Math.floor(Date.now() / 1000);
      const inputRows = [
        {
          id: 'a-recent',
          type: 'consume',
          noteId: 'note-123',
          accountId: 'account-1',
          status: ITransactionStatus.Failed,
          initiatedAt: nowSec - 200,
          completedAt: nowSec - 100
        },
        {
          id: 'b-no-completedat',
          type: 'consume',
          noteId: 'note-123',
          accountId: 'account-1',
          status: ITransactionStatus.Failed,
          initiatedAt: nowSec - 50,
          completedAt: undefined
        },
        {
          id: 'c-recent',
          type: 'consume',
          noteId: 'note-123',
          accountId: 'account-1',
          status: ITransactionStatus.Failed,
          initiatedAt: nowSec - 400,
          completedAt: nowSec - 300
        }
      ];
      mockDedupQuery(inputRows);

      const result = await initiateConsumeTransaction('account-1', note);

      // After sorting, the no-completedAt row's effective timestamp
      // (initiatedAt = nowSec - 50) is the highest, so it wins as the most
      // recent. The cooldown branch fires because that timestamp is well
      // inside RETRY_COOLDOWN_SEC, suppressing the new attempt.
      expect(result).toBe('b-no-completedat');
      expect(mockTransactionsAdd).not.toHaveBeenCalled();
    });
  });

  describe('initiateConsumeTransactionFromId', () => {
    it('creates consume transaction from note id', async () => {
      mockGetInputNote.mockReturnValueOnce({
        metadata: () => ({ noteType: () => 'public' })
      });
      // Scalar `noteId` query + multi-entry `noteIds` query (batch rows).
      mockTransactionsWhere
        .mockReturnValueOnce({
          equals: jest.fn().mockReturnValueOnce({
            toArray: jest.fn().mockResolvedValueOnce([])
          })
        })
        .mockReturnValueOnce({
          equals: jest.fn().mockReturnValueOnce({
            toArray: jest.fn().mockResolvedValueOnce([])
          })
        });
      mockTransactionsAdd.mockResolvedValueOnce(undefined);

      const result = await initiateConsumeTransactionFromId('account-1', 'note-456');

      expect(mockTransactionsAdd).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });
  });

  describe('initiateUpdateProcedureThresholdTransaction', () => {
    it('rejects when the account is not a Guardian account', async () => {
      // Empty getAccounts() → isGuardianAccount short-circuits to false, so the
      // procedure-threshold hardening tx is rejected up front.
      const guardianProvider = {
        getAccounts: async () => [],
        getPublicKeyForCommitment: async () => '',
        signWord: async () => ''
      } as never;

      await expect(
        initiateUpdateProcedureThresholdTransaction('acc-x', 'update_guardian', 2, false, guardianProvider)
      ).rejects.toThrow('only supported for Guardian accounts');
    });
  });

  describe('cancelStuckTransactions', () => {
    it('cancels transactions that exceed MAX_WAIT_BEFORE_CANCEL', async () => {
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const stuckTx = {
        id: 'stuck-tx',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 100,
        processingStartedAt: nowInSeconds - MAX_WAIT_BEFORE_CANCEL - 10 // 10 seconds past the limit
      };
      const recentTx = {
        id: 'recent-tx',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 200,
        processingStartedAt: nowInSeconds
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([stuckTx, recentTx])
      });

      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({ first: jest.fn().mockResolvedValue(undefined), modify: mockModify });

      await cancelStuckTransactions();

      // Should only cancel the stuck transaction
      expect(mockModify).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no transactions are stuck', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([])
      });

      await cancelStuckTransactions();

      expect(mockTransactionsWhere).not.toHaveBeenCalled();
    });

    it('cancels transactions with undefined processingStartedAt', async () => {
      const crashedTx = {
        id: 'crashed-tx',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: 100,
        processingStartedAt: undefined
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([crashedTx])
      });

      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({ first: jest.fn().mockResolvedValue(undefined), modify: mockModify });

      await cancelStuckTransactions();

      expect(mockModify).toHaveBeenCalledTimes(1);
    });
  });

  describe('failInterruptedTransactions', () => {
    it('leaves a freshly-orphaned send untouched under cancelStuckTransactions (documents the #282 gap)', async () => {
      // A private send orphaned when the browser closed mid-prove has
      // processingStartedAt set to "now" (stamped atomically at
      // generateTransaction). The 30-min gate means the reaper does nothing,
      // so the row sits on "Sending" with no feedback until it finally ages out.
      const nowSec = Math.floor(Date.now() / 1000);
      const orphan = {
        id: 'orphan-send',
        type: 'send',
        status: ITransactionStatus.GeneratingTransaction,
        stage: 'sending',
        initiatedAt: nowSec - 5,
        processingStartedAt: nowSec
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([orphan])
      });
      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({ first: jest.fn().mockResolvedValue(undefined), modify: mockModify });

      await cancelStuckTransactions();

      expect(mockModify).not.toHaveBeenCalled();
    });

    it('immediately fails a freshly-orphaned in-progress send with the interrupted message', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const orphan = {
        id: 'orphan-send',
        type: 'send',
        status: ITransactionStatus.GeneratingTransaction,
        stage: 'sending',
        initiatedAt: nowSec - 5,
        processingStartedAt: nowSec
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([orphan])
      });
      const dbTx: any = { transactionId: 'preexisting-should-not-be-touched' };
      const mockModify = jest.fn(async (fn: (t: any) => void) => fn(dbTx));
      mockTransactionsWhere.mockReturnValue({ first: jest.fn().mockResolvedValue(undefined), modify: mockModify });

      await failInterruptedTransactions();

      expect(mockModify).toHaveBeenCalledTimes(1);
      expect(dbTx.status).toBe(ITransactionStatus.Failed);
      expect(dbTx.displayMessage).toMatch(/interrupted/i);
      // We do NOT resubmit, so cancelTransaction must not stamp or alter an on-chain tx id.
      expect(dbTx.transactionId).toBe('preexisting-should-not-be-touched');
    });

    it('no-ops when there are no in-progress transactions', async () => {
      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([])
      });
      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({ first: jest.fn().mockResolvedValue(undefined), modify: mockModify });

      await failInterruptedTransactions();

      expect(mockModify).not.toHaveBeenCalled();
    });

    it('sweeps ONLY GeneratingTransaction rows — Queued/Completed are excluded by the predicate', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const gen = {
        id: 'gen',
        type: 'send',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: nowSec - 1,
        processingStartedAt: nowSec
      };
      const queued = { id: 'queued', type: 'send', status: ITransactionStatus.Queued, initiatedAt: nowSec - 2 };
      const completed = { id: 'done', type: 'send', status: ITransactionStatus.Completed, initiatedAt: nowSec - 3 };

      // Actually apply getTransactionsInProgress's predicate to a mixed dataset,
      // so a regression that broadened the sweep (e.g. getAllUncompletedTransactions)
      // would be caught.
      mockTransactionsFilter.mockImplementationOnce((pred: (t: any) => boolean) => ({
        toArray: jest.fn().mockResolvedValueOnce([gen, queued, completed].filter(pred))
      }));
      const modifiedIds: string[] = [];
      mockTransactionsWhere.mockImplementation(({ id }: { id: string }) => ({
        first: jest.fn().mockResolvedValue(undefined),
        modify: jest.fn(async (fn: (t: any) => void) => {
          modifiedIds.push(id);
          fn({});
        })
      }));

      await failInterruptedTransactions();

      expect(modifiedIds).toEqual(['gen']);
    });

    it('leaves a row that completed between the snapshot and the sweep untouched (finalized guard)', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const gen = {
        id: 'raced',
        type: 'send',
        status: ITransactionStatus.GeneratingTransaction,
        initiatedAt: nowSec - 1,
        processingStartedAt: nowSec
      };
      mockTransactionsFilter.mockReturnValueOnce({ toArray: jest.fn().mockResolvedValueOnce([gen]) });
      const mockModify = jest.fn();
      // The row was marked Completed after the snapshot → cancelTransaction's finalized
      // guard must block the downgrade so the on-chain-landed tx isn't flipped to Failed.
      mockTransactionsWhere.mockReturnValue({
        first: jest.fn().mockResolvedValue({ id: 'raced', status: ITransactionStatus.Completed }),
        modify: mockModify
      });

      await failInterruptedTransactions();

      expect(mockModify).not.toHaveBeenCalled();
    });

    it('keeps the interrupted error (not a prover-failure) for a tx interrupted mid-prove', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      // Guardian txs stamp an explicit 'proving' stage while still GeneratingTransaction,
      // which would otherwise make resolveTransactionErrorMessage relabel the error.
      const orphan = {
        id: 'guardian-send',
        type: 'send',
        status: ITransactionStatus.GeneratingTransaction,
        stage: 'proving',
        initiatedAt: nowSec - 1,
        processingStartedAt: nowSec
      };
      mockTransactionsFilter.mockReturnValueOnce({ toArray: jest.fn().mockResolvedValueOnce([orphan]) });
      const dbTx: any = {};
      const mockModify = jest.fn(async (fn: (t: any) => void) => fn(dbTx));
      mockTransactionsWhere.mockReturnValue({ first: jest.fn().mockResolvedValue(orphan), modify: mockModify });

      await failInterruptedTransactions();

      expect(dbTx.status).toBe(ITransactionStatus.Failed);
      expect(dbTx.displayMessage).toMatch(/interrupted/i);
      // Must NOT be relabelled as a prover failure ("please try again") just because the
      // tx died in the 'proving' stage — that would invite the retry the sweep avoids.
      expect(dbTx.error).toMatch(/interrupted/i);
      expect(dbTx.error).not.toMatch(/prov(e|ing)|try again/i);
    });
  });

  describe('cancelStaleQueuedTransactions', () => {
    it('cancels queued transactions older than MAX_QUEUED_AGE', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const staleTx = {
        id: 'stale-tx',
        status: ITransactionStatus.Queued,
        initiatedAt: nowSec - MAX_QUEUED_AGE - 10
      };
      const freshTx = {
        id: 'fresh-tx',
        status: ITransactionStatus.Queued,
        initiatedAt: nowSec
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([staleTx, freshTx])
      });

      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({ first: jest.fn().mockResolvedValue(undefined), modify: mockModify });

      await cancelStaleQueuedTransactions();

      // Should only cancel the stale transaction
      expect(mockModify).toHaveBeenCalledTimes(1);
    });

    it('does nothing when all queued transactions are recent', async () => {
      const freshTx = {
        id: 'fresh-tx',
        status: ITransactionStatus.Queued,
        initiatedAt: Math.floor(Date.now() / 1000)
      };

      mockTransactionsFilter.mockReturnValueOnce({
        toArray: jest.fn().mockResolvedValueOnce([freshTx])
      });

      await cancelStaleQueuedTransactions();

      expect(mockTransactionsWhere).not.toHaveBeenCalled();
    });
  });

  describe('cancelTransaction error serialization', () => {
    it('sets displayMessage, displayIcon, and serializes Error objects', async () => {
      const mockModify = jest.fn((fn: (tx: any) => void) => {
        const dbTx: any = {};
        fn(dbTx);
        return dbTx;
      });
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(undefined) })
        .mockReturnValueOnce({ modify: mockModify });

      const tx = { id: 'tx-1' } as Transaction;
      await cancelTransaction(tx, new Error('Network failure'));

      expect(mockModify).toHaveBeenCalled();
      const modifyFn = mockModify.mock.calls[0]![0];
      const dbTx: any = {};
      modifyFn(dbTx);

      expect(dbTx.status).toBe(ITransactionStatus.Failed);
      expect(dbTx.error).toBe('Error: Network failure');
      expect(dbTx.displayMessage).toBe('Failed');
      expect(dbTx.displayIcon).toBe('FAILED');
    });

    it('serializes plain string errors with String()', async () => {
      const mockModify = jest.fn();
      mockTransactionsWhere
        .mockReturnValueOnce({ first: jest.fn().mockResolvedValueOnce(undefined) })
        .mockReturnValueOnce({ modify: mockModify });

      const tx = { id: 'tx-1' } as Transaction;
      await cancelTransaction(tx, 'simple error string');

      const modifyFn = mockModify.mock.calls[0]![0];
      const dbTx: any = {};
      modifyFn(dbTx);

      expect(dbTx.error).toBe('simple error string');
    });

    it('rewrites a proving-stage failure to the matching prover message (remote vs local) and keeps the raw error', async () => {
      const runProvingCancel = async (delegateTransaction: boolean | undefined) => {
        const mockModify = jest.fn();
        mockTransactionsWhere
          // Finalized-guard lookup returns the live row, exposing the stage it died in.
          .mockReturnValueOnce({
            first: jest.fn().mockResolvedValueOnce({ id: 'tx-1', status: ITransactionStatus.Queued, stage: 'proving' })
          })
          .mockReturnValueOnce({ modify: mockModify });
        await cancelTransaction({ id: 'tx-1', delegateTransaction } as Transaction, new Error('prover exploded'));
        const dbTx: any = {};
        mockModify.mock.calls[0]![0](dbTx);
        return dbTx;
      };

      // Delegated (remote) proving → remote message.
      const remote = await runProvingCancel(true);
      expect(remote.error).toBe(REMOTE_PROVER_FAILED_ERROR);
      expect(remote.rawError).toBe('Error: prover exploded');

      // Local (on-device / native) proving → local message, NOT the remote one.
      const local = await runProvingCancel(false);
      expect(local.error).toBe(LOCAL_PROVER_FAILED_ERROR);
      expect(local.rawError).toBe('Error: prover exploded');
    });

    it('rewrites a sending-stage timeout to the matching prover message but passes through non-timeout sending failures raw', async () => {
      const runCancel = async (message: string, delegateTransaction?: boolean) => {
        const mockModify = jest.fn();
        mockTransactionsWhere
          .mockReturnValueOnce({
            first: jest.fn().mockResolvedValueOnce({ id: 'tx-1', status: ITransactionStatus.Queued, stage: 'sending' })
          })
          .mockReturnValueOnce({ modify: mockModify });
        await cancelTransaction({ id: 'tx-1', delegateTransaction } as Transaction, new Error(message));
        const dbTx: any = {};
        mockModify.mock.calls[0]![0](dbTx);
        return dbTx;
      };

      // The 'sending' stage can't be pinned to pre-submit, so a delegated timeout
      // gets the hedged copy (no false "no funds moved" claim) — not the definitive
      // stage-'proving' REMOTE_PROVER_FAILED_ERROR (#419 review).
      const remoteTimedOut = await runCancel('request timeout hit', true);
      expect(remoteTimedOut.error).toBe(REMOTE_PROVER_TIMEOUT_ERROR);
      expect(remoteTimedOut.rawError).toBe('Error: request timeout hit');

      const localTimedOut = await runCancel('request timeout hit', false);
      expect(localTimedOut.error).toBe(LOCAL_PROVER_FAILED_ERROR);

      const other = await runCancel('insufficient balance');
      expect(other.error).toBe('Error: insufficient balance');
      expect(other.rawError).toBeUndefined();
    });
  });

  describe('generateTransaction', () => {
    it('calls syncState before processing transaction', async () => {
      const callOrder: string[] = [];
      mockSyncState.mockImplementation(async () => {
        callOrder.push('syncState');
        return { blockNum: () => 1 };
      });

      // Mock updateTransactionStatus
      const tx = { id: 'tx-1', status: ITransactionStatus.Queued };
      const mockModify = jest.fn();
      mockTransactionsWhere.mockReturnValue({
        first: jest.fn().mockResolvedValue(tx),
        modify: mockModify.mockImplementation(() => {
          callOrder.push('updateStatus');
        })
      });

      // Mock the WASM client for the actual transaction execution
      // sendTransaction now returns TransactionResult directly (no worker)
      mockGetMidenClient.mockResolvedValue({
        syncState: mockSyncState,
        sendTransaction: jest.fn().mockImplementation(() => {
          callOrder.push('sendTransaction');
          return {
            executedTransaction: () => ({
              id: () => ({ toHex: () => 'tx-hex' }),
              outputNotes: () => ({ notes: () => [] }),
              inputNotes: () => ({ notes: () => [] })
            }),
            serialize: () => new Uint8Array([7])
          };
        })
      });

      // Verify syncState is called and the order is correct by catching the error
      // after syncState + updateStatus
      const signCallback = jest.fn().mockResolvedValue(new Uint8Array());
      const transaction = {
        id: 'tx-1',
        type: 'send',
        accountId: 'acc-1',
        delegateTransaction: false
      } as any;

      try {
        await generateTransaction(transaction, signCallback, false, {
          getAccounts: async () => [],
          getPublicKeyForCommitment: async () => '',
          signWord: async () => ''
        });
      } catch {
        // Expected to fail on TransactionResult.deserialize — that's fine
      }

      // Verify syncState runs before the status flip to GeneratingTransaction.
      // An earlier `updateStatus` entry is the stage='syncing' marker — that's
      // an informational write; what matters is that syncState completes
      // before the final status flip (the last `updateStatus`).
      const syncIdx = callOrder.indexOf('syncState');
      const lastStatusIdx = callOrder.lastIndexOf('updateStatus');
      expect(syncIdx).toBeGreaterThanOrEqual(0);
      expect(syncIdx).toBeLessThan(lastStatusIdx);
      expect(mockSyncState).toHaveBeenCalled();
    });
  });
});

/**
 * Integration test: full network outage recovery flow.
 * Uses jest.isolateModules with a stateful in-memory DB to simulate:
 *   1. Network up → transaction succeeds
 *   2. Network down → syncState fails → transaction cancelled
 *   3. Network back up → new transaction succeeds
 */
describe('Transaction resilience: network outage recovery (isolated)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('recovers after network outage - full flow', async () => {
    // ---- In-memory DB ----
    const txStore: any[] = [];
    const repoMock = {
      transactions: {
        add: jest.fn(async (tx: any) => {
          txStore.push({ ...tx });
        }),
        filter: jest.fn((fn: (tx: any) => boolean) => ({
          toArray: jest.fn(async () => txStore.filter(fn))
        })),
        where: jest.fn((query: any) => ({
          first: jest.fn(async () => txStore.find(tx => tx.id === query.id)),
          modify: jest.fn(async (fn: (tx: any) => void) => {
            const tx = txStore.find(t => t.id === query.id);
            if (tx) fn(tx);
          })
        }))
      }
    };

    // ---- Network toggle ----
    let networkUp = true;
    const mockSyncState = jest.fn(async () => {
      if (!networkUp) throw new Error('Network unreachable');
      return { blockNum: () => 42 };
    });

    const mockNewTransaction = jest.fn(async () => ({
      executedTransaction: () => ({
        id: () => ({ toHex: () => 'mock-tx-hash' }),
        outputNotes: () => ({ notes: () => [] }),
        inputNotes: () => ({ notes: () => [] })
      }),
      serialize: () => new Uint8Array([1, 2, 3])
    }));

    jest.doMock('lib/miden/repo', () => repoMock);

    jest.doMock('../sdk/miden-client', () => ({
      getMidenClient: jest.fn(async () => ({
        syncState: mockSyncState,
        newTransaction: mockNewTransaction
      })),
      withWasmClientLock: jest.fn((cb: () => any) => cb())
    }));
    // The #260 proxy (routed by index.ts's syncState preflight) imports
    // getMidenClient via the `lib/...` alias — inside this isolate block the
    // relative doMock above doesn't cover it, so delegate the alias to it.
    jest.doMock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      InputNoteState: {
        ConsumedAuthenticatedLocal: 0,
        ConsumedUnauthenticatedLocal: 1,
        ConsumedExternal: 2,
        Invalid: 3,
        Committed: 4,
        Expected: 5,
        Unverified: 6
      }
    }));

    jest.doMock('../helpers', () => ({
      ...jest.requireActual('../helpers'),
      toNoteTypeString: jest.fn(() => 'public')
    }));

    jest.doMock('../activity/helpers', () => ({
      interpretTransactionResult: jest.fn((tx: any) => ({
        ...tx,
        transactionId: 'mock-tx-hash',
        displayMessage: 'Executed',
        displayIcon: 'DEFAULT'
      }))
    }));

    jest.doMock('../activity/notes', () => ({
      importAllNotes: jest.fn(),
      queueNoteImport: jest.fn()
    }));

    jest.doMock('lib/platform', () => ({
      isMobile: jest.fn(() => false),
      isExtension: jest.fn(() => false)
    }));

    jest.doMock('shared/logger', () => ({
      logger: { warning: jest.fn(), error: jest.fn() }
    }));

    let ITransactionStatus: any;
    let generateTransactionsLoop: any;

    jest.isolateModules(() => {
      ({ ITransactionStatus } = require('../db/types'));
      ({ generateTransactionsLoop } = require('./index'));
    });

    const signCallback = jest.fn(async () => new Uint8Array());
    // Guardian provider stub — test accounts are non-Guardian, so getAccounts()
    // returns an empty list and the isGuardianAccount check short-circuits.
    const guardianProvider = {
      getAccounts: async () => [],
      getPublicKeyForCommitment: async () => '',
      signWord: async () => ''
    };

    // ---- Phase 1: Network up, transaction succeeds ----
    networkUp = true;
    txStore.push({
      id: 'tx-1',
      type: 'execute',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Date.now(),
      displayIcon: 'DEFAULT',
      displayMessage: 'Executing',
      requestBytes: new Uint8Array([1])
    });

    const result1 = await generateTransactionsLoop(signCallback, false, guardianProvider);

    expect(result1).toBe(true);
    const tx1 = txStore.find((t: any) => t.id === 'tx-1');
    expect(tx1.status).toBe(ITransactionStatus.Completed);
    expect(tx1.transactionId).toBe('mock-tx-hash');
    expect(mockSyncState).toHaveBeenCalled();

    // ---- Phase 2: Network down, new transaction gets cancelled ----
    networkUp = false;
    mockSyncState.mockClear();

    txStore.push({
      id: 'tx-2',
      type: 'execute',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Date.now(),
      displayIcon: 'DEFAULT',
      displayMessage: 'Executing',
      requestBytes: new Uint8Array([2])
    });

    const result2 = await generateTransactionsLoop(signCallback, false, guardianProvider);

    // generateTransactionsLoop catches the error and cancels the tx
    expect(result2).toBe(false);
    const tx2 = txStore.find((t: any) => t.id === 'tx-2');
    expect(tx2.status).toBe(ITransactionStatus.Failed);
    expect(tx2.displayMessage).toBe('Failed');
    expect(tx2.displayIcon).toBe('FAILED');

    // ---- Phase 3: Network back up, new transaction succeeds ----
    networkUp = true;
    mockSyncState.mockClear();

    txStore.push({
      id: 'tx-3',
      type: 'execute',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Date.now(),
      displayIcon: 'DEFAULT',
      displayMessage: 'Executing',
      requestBytes: new Uint8Array([3])
    });

    const result3 = await generateTransactionsLoop(signCallback, false, guardianProvider);

    expect(result3).toBe(true);
    const tx3 = txStore.find((t: any) => t.id === 'tx-3');
    expect(tx3.status).toBe(ITransactionStatus.Completed);
    expect(tx3.transactionId).toBe('mock-tx-hash');
    expect(mockSyncState).toHaveBeenCalled();

    // ---- Phase 4: the pre-flight sync is EVICTED by the watchdog (#777) ----
    // The sync ceiling makes this the likeliest place for an eviction to land,
    // and an eviction ABANDONS its operation rather than cancelling it — so the
    // funds-relevant question is what stage the row is in when the recovery
    // reads it. `syncUnderBoundedLock` runs BEFORE the flip to
    // GeneratingTransaction, while the row still reads 'syncing', which is the
    // one stage whose pre-write property is provable. Anything that let
    // 'sending' be stamped first would make Retry permanently refuse a send that
    // demonstrably never built a request.
    const { WasmClientPoisonedError } = require('lib/miden/sdk/wasm-client-poison');
    networkUp = true;
    mockSyncState.mockClear();
    mockSyncState.mockRejectedValueOnce(new WasmClientPoisonedError('watchdog'));

    txStore.push({
      id: 'tx-4',
      type: 'send',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: Date.now(),
      displayIcon: 'DEFAULT',
      displayMessage: 'Sending',
      requestBytes: undefined
    });

    const result4 = await generateTransactionsLoop(signCallback, false, guardianProvider);

    expect(result4).toBe(false);
    const tx4 = txStore.find((t: any) => t.id === 'tx-4');
    expect(tx4.status).toBe(ITransactionStatus.Failed);
    // Still 'syncing': the eviction never reached the 'sending' stamp.
    expect(tx4.stage).toBe('syncing');
    // And therefore no permanent crossing, so Retry stays available.
    expect(tx4.mayHaveSubmitted).toBeFalsy();
    expect(tx4.processingStartedAt).toBeFalsy();
  });
});

// Note: The completeCustomTransaction test below uses jest.isolateModules
// which conflicts with module-level mocks. It's kept as a separate isolated test.
describe('completeCustomTransaction (isolated)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('marks transaction completed even when output notes are non-private', async () => {
    const dbTx: any = { id: 'tx-1', status: 0 };
    const modify = jest.fn(async (fn: (tx: any) => void) => fn(dbTx));

    jest.doMock('lib/miden/repo', () => ({
      transactions: {
        where: jest.fn(() => ({
          first: jest.fn(async () => dbTx),
          modify
        }))
      }
    }));

    jest.doMock('../helpers', () => ({
      ...jest.requireActual('../helpers'),
      toNoteTypeString: jest.fn(() => 'public')
    }));

    jest.doMock('../activity/helpers', () => ({
      interpretTransactionResult: jest.fn((tx: any) => ({ ...tx }))
    }));

    jest.doMock('../activity/notes', () => ({
      importAllNotes: jest.fn(),
      queueNoteImport: jest.fn()
    }));

    jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
      InputNoteState: {
        ConsumedAuthenticatedLocal: 'ConsumedAuthenticatedLocal',
        ConsumedUnauthenticatedLocal: 'ConsumedUnauthenticatedLocal',
        ConsumedExternal: 'ConsumedExternal',
        Invalid: 'Invalid',
        Committed: 'Committed',
        Expected: 'Expected',
        Unverified: 'Unverified'
      }
    }));

    jest.doMock('../sdk/miden-client', () => ({
      getMidenClient: jest.fn()
    }));

    jest.doMock('lib/platform', () => ({
      isMobile: jest.fn(() => false),
      isExtension: jest.fn(() => false)
    }));

    let ITransactionStatus: any;
    let completeCustomTransaction: any;

    jest.isolateModules(() => {
      ({ ITransactionStatus } = require('../db/types'));
      ({ completeCustomTransaction } = require('./index'));
    });

    const nonPrivateNote = {
      metadata: () => ({ noteType: () => ({}) })
    };

    const result: any = {
      executedTransaction: () => ({
        outputNotes: () => ({
          notes: () => [nonPrivateNote]
        })
      })
    };

    const tx: any = { id: 'tx-1' };

    await completeCustomTransaction(tx, result);

    expect(modify).toHaveBeenCalledTimes(1);
    expect(dbTx.status).toBe(ITransactionStatus.Completed);
    expect(dbTx.completedAt).toEqual(expect.any(Number));
  });
});
