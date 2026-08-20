import { isRequeueableTransaction, requeueFailedTransaction } from './retry';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockTransactionsWhere = jest.fn();

jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { where: mockTransactionsWhere };
  }
}));

const mockVerifySendLanded = jest.fn();
jest.mock('./cancel', () => ({
  verifySendLanded: (...args: unknown[]) => mockVerifySendLanded(...args)
}));

const mockUpdateTransactionStatus = jest.fn().mockResolvedValue(undefined);
jest.mock('./helper', () => ({
  updateTransactionStatus: (...args: unknown[]) => mockUpdateTransactionStatus(...args)
}));

/** In-memory row + Dexie-shaped where().first()/where().modify() plumbing. */
function wireRow(row: ITransaction | undefined) {
  mockTransactionsWhere.mockImplementation(() => ({
    first: jest.fn().mockResolvedValue(row),
    modify: jest.fn((fn: (tx: ITransaction) => void) => {
      if (row) fn(row);
      return Promise.resolve(row ? 1 : 0);
    })
  }));
}

function failedRow(overrides: Partial<ITransaction> = {}): ITransaction {
  return {
    id: 'tx-1',
    type: 'send',
    accountId: 'acct-1',
    status: ITransactionStatus.Failed,
    initiatedAt: 1000,
    processingStartedAt: 1100,
    completedAt: 1200,
    stage: 'sending',
    nextEligibleAt: 99_999,
    error: 'Something broke',
    rawError: 'Error: something broke',
    displayMessage: 'Failed',
    displayIcon: 'FAILED',
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: node can't confirm the tx landed, so requeue proceeds as before.
  mockVerifySendLanded.mockResolvedValue('unknown');
});

// GAP 2 (resilience): Retry must never resubmit a send/swap whose original submit
// actually landed — that's a double-send / real fund loss.
describe('requeueFailedTransaction — double-send idempotency guard', () => {
  it('does NOT resubmit a send the node reports as landed; completes it instead', async () => {
    const row = failedRow({ type: 'send', transactionId: 'abc123' });
    wireRow(row);
    mockVerifySendLanded.mockResolvedValue('landed');

    await requeueFailedTransaction('tx-1');

    // Completed, NOT reset to Queued — no second send is broadcast.
    expect(mockUpdateTransactionStatus).toHaveBeenCalledWith('tx-1', ITransactionStatus.Completed, expect.anything());
    expect(row.status).toBe(ITransactionStatus.Failed); // untouched by a requeue modify
  });

  it('resubmits (requeues) when the node cannot confirm the send landed', async () => {
    const row = failedRow({ type: 'send', transactionId: 'abc123' });
    wireRow(row);
    mockVerifySendLanded.mockResolvedValue('unknown');

    await requeueFailedTransaction('tx-1');

    expect(mockUpdateTransactionStatus).not.toHaveBeenCalled();
    expect(row.status).toBe(ITransactionStatus.Queued); // requeued for a fresh attempt
  });

  it('checks landed-state for swap/bridged-send/execute too', async () => {
    for (const type of ['swap', 'bridged-send', 'execute'] as const) {
      mockVerifySendLanded.mockClear();
      wireRow(failedRow({ type, transactionId: 'abc' }));
      await requeueFailedTransaction('tx-1');
      expect(mockVerifySendLanded).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT node-verify a consume (it has its own input-note landed check)', async () => {
    wireRow(failedRow({ type: 'consume' }));
    await requeueFailedTransaction('tx-1');
    expect(mockVerifySendLanded).not.toHaveBeenCalled();
  });
});

describe('isRequeueableTransaction', () => {
  it('accepts failed rows of re-queueable types only', () => {
    for (const type of ['send', 'consume', 'swap', 'bridged-send', 'execute'] as const) {
      expect(isRequeueableTransaction({ status: ITransactionStatus.Failed, type })).toBe(true);
    }
    for (const type of ['switch-guardian', 'replace-hot-key', 'update-procedure-threshold'] as const) {
      expect(isRequeueableTransaction({ status: ITransactionStatus.Failed, type })).toBe(false);
    }
  });

  it('excludes earn-deposit: the surrounding Epoch intent is already abandoned', () => {
    // Re-running only the Miden leg would mint a fresh P2IDE collateral note to
    // the allocator with no quote and no intent behind it, locking the user's
    // funds until the note's reclaim height. The user re-initiates from the Earn
    // flow instead. (The locked-wallet Queued path and
    // ApplyTransactionAfterSubmitFailed still include earn-deposit — the intent
    // is still live in both of those.)
    expect(isRequeueableTransaction({ status: ITransactionStatus.Failed, type: 'earn-deposit' })).toBe(false);
  });

  it('rejects non-failed rows regardless of type', () => {
    expect(isRequeueableTransaction({ status: ITransactionStatus.Completed, type: 'send' })).toBe(false);
    expect(isRequeueableTransaction({ status: ITransactionStatus.Queued, type: 'send' })).toBe(false);
    expect(isRequeueableTransaction({ status: undefined, type: 'send' })).toBe(false);
  });
});

describe('requeueFailedTransaction', () => {
  it('resets the row to Queued and clears every failure/backoff field', async () => {
    const row = failedRow();
    wireRow(row);
    const before = Math.floor(Date.now() / 1000);

    await requeueFailedTransaction('tx-1');

    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.initiatedAt).toBeGreaterThanOrEqual(before);
    expect(row.processingStartedAt).toBeUndefined();
    expect(row.completedAt).toBeUndefined();
    expect(row.stage).toBeUndefined();
    // Stale requeue-backoff must not delay an explicit user retry.
    expect(row.nextEligibleAt).toBeUndefined();
    expect(row.error).toBeUndefined();
    expect(row.rawError).toBeUndefined();
    expect(row.displayMessage).toBeUndefined();
    expect(row.displayIcon).toBe('SEND');
  });

  it('restores the pre-failure display icon per type', async () => {
    const cases: Array<[ITransaction['type'], ITransaction['displayIcon']]> = [
      ['consume', 'RECEIVE'],
      ['swap', 'SWAP'],
      ['bridged-send', 'SEND'],
      ['execute', 'DEFAULT']
    ];
    for (const [type, icon] of cases) {
      const row = failedRow({ type });
      wireRow(row);
      // eslint-disable-next-line no-await-in-loop
      await requeueFailedTransaction('tx-1');
      expect(row.displayIcon).toBe(icon);
    }
  });

  it('throws for a missing row', async () => {
    wireRow(undefined);
    await expect(requeueFailedTransaction('gone')).rejects.toThrow('not found');
  });

  it('throws for a non-retryable type and leaves the row untouched', async () => {
    const row = failedRow({ type: 'replace-hot-key' });
    wireRow(row);
    await expect(requeueFailedTransaction('tx-1')).rejects.toThrow('not retryable');
    expect(row.status).toBe(ITransactionStatus.Failed);
  });

  it('throws for a completed row (never downgrades a landed tx)', async () => {
    const row = failedRow({ status: ITransactionStatus.Completed });
    wireRow(row);
    await expect(requeueFailedTransaction('tx-1')).rejects.toThrow('not retryable');
    expect(row.status).toBe(ITransactionStatus.Completed);
  });
});

// A guardian recallable send is the only `send` row with cached bytes. Those
// bytes freeze an absolute reclaim height AND the outgoing asset's vault key, so
// a retry has to rebuild them — but they also pin the note id, which is the only
// thing standing between an ambiguous post-submit failure and a double-send.
// Hence the stage gate: rebuild only when the last attempt provably never
// submitted.
describe('requeueFailedTransaction — cached requestBytes', () => {
  const bytes = () => new Uint8Array([1, 2, 3]);

  it.each(['syncing', 'sending', 'creating-proposal', 'signing-proposal', 'executing', 'proving'] as const)(
    "drops a send's bytes when it failed pre-submit at %s",
    async stage => {
      const row = failedRow({ type: 'send', stage, requestBytes: bytes() });
      wireRow(row);

      await requeueFailedTransaction('tx-1');

      expect(row.requestBytes).toBeUndefined();
    }
  );

  it("drops a send's bytes when the row never reached the loop (no stage)", async () => {
    const row = failedRow({ type: 'send', stage: undefined, requestBytes: bytes() });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBeUndefined();
  });

  // 'submitting' is stamped immediately BEFORE provenTx.submit(), so the submit
  // may have reached the node. Reusing the bytes re-emits the same note id and
  // the chain rejects the duplicate; rebuilding would draw a fresh serial number
  // and genuinely double-send.
  it.each(['submitting', 'confirming', 'guardian-syncing'] as const)(
    "KEEPS a send's bytes when the failure at %s could have submitted",
    async stage => {
      const kept = bytes();
      const row = failedRow({ type: 'send', stage, requestBytes: kept });
      wireRow(row);

      await requeueFailedTransaction('tx-1');

      expect(row.requestBytes).toBe(kept);
      expect(row.status).toBe(ITransactionStatus.Queued);
    }
  );

  it("never drops a swap's bytes — the PSWAP flow requires byte-identical reuse", async () => {
    const kept = bytes();
    const row = failedRow({ type: 'swap', stage: 'executing', requestBytes: kept });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBe(kept);
  });

  // The pre-built bridge note carries the mandate-binding attachment this
  // builder cannot reproduce.
  it("never drops a bridged-send's bytes", async () => {
    const kept = bytes();
    const row = failedRow({ type: 'bridged-send', stage: 'executing', requestBytes: kept });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBe(kept);
  });
});
