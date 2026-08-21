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
  ...jest.requireActual('./cancel'),
  verifySendLanded: (...args: unknown[]) => mockVerifySendLanded(...args)
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn(),
  withWasmClientLock: async (fn: () => unknown) => fn()
}));

// Real module underneath. The landed-verdict branch used to be asserted purely
// through `expect(mockUpdateTransactionStatus).toHaveBeenCalledWith(...)`, which
// is satisfied by a call that THROWS — and the real `updateTransactionStatus`
// throws on exactly the Failed row this function is defined over, so the guard's
// only success path never worked while this test reported that it did. Running
// the real writers means the assertions below are about the row, not about
// whether a spy was called.
const mockUpdateTransactionStatus = jest.fn().mockResolvedValue(undefined);
jest.mock('./helper', () => ({
  ...jest.requireActual('./helper'),
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
    const row = failedRow({ type: 'send', transactionId: 'abc123', error: 'Something broke' });
    wireRow(row);
    mockVerifySendLanded.mockResolvedValue('landed');

    await requeueFailedTransaction('tx-1');

    // Asserted on the ROW: Completed, and never reset to Queued, so no second
    // send is broadcast. The failure is cleared off it too — the row's story is
    // now that it succeeded.
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.status).not.toBe(ITransactionStatus.Queued);
    expect(row.stage).toBe('complete');
    expect(row.error).toBeUndefined();
  });

  // The reconciliation is deliberately one-way. `completeVerifiedLandedTransaction`
  // promotes Failed → Completed on node evidence; it must never touch a row that
  // is already Completed, which is what the terminal guard it bypasses protects.
  it('leaves an already-Completed row alone', async () => {
    const row = failedRow({ type: 'send', transactionId: 'abc123' });
    wireRow(row);
    mockVerifySendLanded.mockResolvedValue('landed');
    row.status = ITransactionStatus.Completed;
    row.displayMessage = 'Completed earlier';

    await requeueFailedTransaction('tx-1').catch(() => undefined);

    expect(row.displayMessage).toBe('Completed earlier');
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

  it.each(['syncing', 'creating-proposal', 'signing-proposal', 'executing', 'proving'] as const)(
    "drops a send's bytes when it failed pre-submit at %s",
    async stage => {
      const row = failedRow({ type: 'send', stage, requestBytes: bytes() });
      wireRow(row);

      await requeueFailedTransaction('tx-1');

      expect(row.requestBytes).toBeUndefined();
    }
  );

  // A missing stage looks like "never ran" and is the opposite. Bytes only
  // exist once the row got past the 'syncing'/'sending' stamps, so a row that
  // has them AND no stage was reset by an earlier requeue — and what it was
  // reset from is precisely what is unknown. Rows written by an older build
  // reach this with no `mayHaveSubmitted` to fall back on.
  it("KEEPS a send's bytes when the stage is missing but bytes exist", async () => {
    const kept = bytes();
    const row = failedRow({ type: 'send', stage: undefined, requestBytes: kept });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBe(kept);
    expect(row.mayHaveSubmitted).toBe(true);
  });

  // 'sending' is the one that looks safe and is not. It is stamped before the
  // guardian leaf, and only the INLINE leaf then advances it — the offscreen
  // leaf (`dispatchGuardianPipeline`, the default build) takes no stage callback,
  // so a row that executed, proved, SUBMITTED and then lost its realm is still
  // sitting at 'sending'. Clearing there would let Retry mint a fresh note
  // serial for a transfer that already landed.
  it("KEEPS a send's bytes at 'sending', which the offscreen leaf never advances", async () => {
    const kept = bytes();
    const row = failedRow({ type: 'send', stage: 'sending', requestBytes: kept });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBe(kept);
    expect(row.status).toBe(ITransactionStatus.Queued);
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

  // `verifySendLanded` makes a network round trip between the row read and the
  // write, so a concurrent retry can requeue the row and the loop can advance the
  // new attempt in that window. Writing blind would reset a live transaction and
  // clear the NEW attempt's bytes on the strength of the OLD attempt's stage.
  it('leaves the row alone when it moved on during the landed-check round trip', async () => {
    const kept = bytes();
    const row = failedRow({ type: 'send', stage: 'executing', requestBytes: kept });
    wireRow(row);
    mockVerifySendLanded.mockImplementation(async () => {
      // A concurrent retry already requeued it and the loop picked it back up.
      row.status = ITransactionStatus.GeneratingTransaction;
      row.stage = 'submitting';
      return 'unknown';
    });

    await requeueFailedTransaction('tx-1');

    expect(row.status).toBe(ITransactionStatus.GeneratingTransaction);
    expect(row.stage).toBe('submitting');
    expect(row.requestBytes).toBe(kept);
  });
});

// The stage gate alone is amnesiac: requeueing resets `stage` to undefined, so
// the "this attempt may have submitted" signal survived exactly one retry and
// the NEXT failure — at an early, genuinely pre-submit stage — cleared the very
// bytes the previous retry protected. `mayHaveSubmitted` is the sticky record
// that makes the guard hold across requeues.
describe('requeueFailedTransaction — mayHaveSubmitted is sticky', () => {
  const bytes = () => new Uint8Array([1, 2, 3]);

  it('stamps the row when it keeps bytes for a possibly-submitted send', async () => {
    const row = failedRow({ type: 'send', stage: 'submitting', requestBytes: bytes() });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.mayHaveSubmitted).toBe(true);
    // The stage that justified it is gone — which is exactly why it is persisted.
    expect(row.stage).toBeUndefined();
  });

  it('does not stamp a send that provably never submitted', async () => {
    const row = failedRow({ type: 'send', stage: 'proving', requestBytes: bytes() });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.mayHaveSubmitted).toBeUndefined();
    expect(row.requestBytes).toBeUndefined();
  });

  // The regression: attempt A dies at 'submitting' (bytes kept, flag set),
  // the retry is picked up and attempt B dies at 'syncing'. Stage-only, that
  // second failure reads as pre-submit and rebuilds the note id that is the
  // only thing stopping the chain from accepting attempt A's transfer twice.
  it('keeps bytes on a LATER pre-submit failure once the flag is set', async () => {
    const kept = bytes();
    const row = failedRow({ type: 'send', stage: 'syncing', requestBytes: kept, mayHaveSubmitted: true });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBe(kept);
    expect(row.mayHaveSubmitted).toBe(true);
  });

  // Same hole, reached without a second user Retry: the requeued row sits
  // Queued with no stage until `cancelStaleQueuedTransactions` fails it, and
  // `cancelTransaction` writes no stage — so a missing stage plus live bytes is
  // reachable and must NOT be read as proof of never having submitted.
  it('keeps bytes when the flag is set and the stage is missing entirely', async () => {
    const kept = bytes();
    const row = failedRow({ type: 'send', stage: undefined, requestBytes: kept, mayHaveSubmitted: true });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBe(kept);
  });

  // Asserted through its consequence, not the field: a test that only checked
  // `mayHaveSubmitted` were still true would pass even with the sticky half of
  // the gate deleted, since nothing ever writes `false`.
  it('never unsets the flag, so the bytes stay protected on a pre-submit failure', async () => {
    const kept = bytes();
    const row = failedRow({ type: 'send', stage: 'executing', requestBytes: kept, mayHaveSubmitted: true });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBe(kept);
    expect(row.mayHaveSubmitted).toBe(true);
  });

  // The cancelled-mid-flight sequence, from the row's point of view. A cancel
  // (Cancel button, or the stale-queued reaper) fails the row while the leaf is
  // still proving; nothing aborts the leaf, so it goes on to stamp the flag and
  // submit, but `setTransactionStage` refuses to advance a terminal row and the
  // stage stays 'proving' forever. Reading the stage alone therefore says
  // "never broadcast" about a transfer that landed — clearing the bytes here
  // would rebuild the serial and pay the recipient a second time.
  it('keeps bytes when the stage says pre-submit but the leaf recorded a crossing', async () => {
    const kept = bytes();
    const row = failedRow({ type: 'send', stage: 'proving', requestBytes: kept, mayHaveSubmitted: true });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.requestBytes).toBe(kept);
  });

  // `send` is the only type whose bytes this gate can drop, so stamping the flag
  // on a swap would persist a signal nothing reads and imply a guard swaps don't
  // have (their bytes are unconditionally reused).
  it('does not stamp a non-send row, whose bytes are never cleared anyway', async () => {
    const kept = bytes();
    const row = failedRow({ type: 'swap', stage: 'submitting', requestBytes: kept });
    wireRow(row);

    await requeueFailedTransaction('tx-1');

    expect(row.mayHaveSubmitted).toBeUndefined();
    expect(row.requestBytes).toBe(kept);
  });
});
