/**
 * Double-send guard, exercised against the REAL database.
 *
 * Every other test around this guard mocks `lib/miden/repo` with a hand-rolled
 * object, and each one exercises a single writer in isolation. That is exactly
 * how the cancel-mid-flight double payment survived the whole suite: no test
 * ever composed the four writers that actually meet on a row —
 * `cancelTransaction`, the leaf's stage/crossing writes, and
 * `requeueFailedTransaction` — and the hand-rolled fakes did not reproduce the
 * one Dexie behavior the bug turned on, that `.modify()` on an already-terminal
 * row is a silent no-op rather than an error.
 *
 * So this file mocks none of them. `lib/miden/repo` is the real Dexie schema on
 * `fake-indexeddb` (already a global Jest setup file), and cancel, stage, the
 * crossing stamp and requeue are all the real implementations. Only the edges
 * the wallet talks to — the WASM client, the offscreen proxy, notifications —
 * are stubbed.
 *
 * The invariant under test, stated once: a guardian recallable send's cached
 * `requestBytes` pin its note serial, and the note id derived from that serial
 * is the ONLY reason the chain rejects a duplicate. Rebuilding them after a
 * submit that may have landed therefore mints a second payment. The row's
 * `stage` cannot decide this, because a cancel freezes it wherever it happened
 * to be while the pipeline runs on and submits.
 */
import * as Repo from 'lib/miden/repo';

import { cancelTransaction } from './cancel';
import { markMayHaveSubmitted, setTransactionStage, updateTransactionStatus } from './helper';
import { requeueFailedTransaction } from './retry';
import { ITransaction, ITransactionStatus, SendTransaction } from '../db/types';

jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn()
}));

jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getInputNoteDetails: jest.fn(async () => []),
    syncState: jest.fn(async () => ({}))
  },
  dispatchGuardianPipeline: jest.fn()
}));

jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async (fn: () => unknown) => fn(),
  getMidenClient: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isExtension: () => true,
  isDesktop: () => false
}));

jest.mock('lib/mobile/background-time', () => ({
  hiddenSecondsSince: () => 0
}));

// The node-verify step that Retry runs before requeueing. 'unknown' is the
// interesting verdict and the one the bug needed: the row never captured a
// transaction id (the completion write was refused on an already-Failed row),
// so the node cannot confirm the send landed and Retry proceeds to requeue.
type LandedVerdict = 'landed' | 'not-landed' | 'unknown';
const mockVerifySendLanded = jest.fn(async (): Promise<LandedVerdict> => 'unknown');
jest.mock('./cancel', () => ({
  ...jest.requireActual('./cancel'),
  verifySendLanded: (...args: unknown[]) => mockVerifySendLanded(...(args as [])),
  getConsumeVerdict: jest.fn(async () => 'unknown')
}));

const BYTES = () => new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);

/**
 * A guardian recallable send mid-flight: picked up by the loop, request built
 * and cached, currently proving. `requestBytes` is the thing under protection.
 */
const inFlightSend = (id: string, overrides: Partial<ITransaction> = {}): SendTransaction =>
  ({
    id,
    type: 'send',
    accountId: 'mtst1sender',
    secondaryAccountId: 'mtst1recipient',
    faucetId: 'mtst1faucet',
    amount: '1500000',
    noteType: 'private',
    status: ITransactionStatus.GeneratingTransaction,
    stage: 'proving',
    requestBytes: BYTES(),
    initiatedAt: Math.floor(Date.now() / 1000),
    displayMessage: 'Sending',
    displayIcon: 'SEND',
    extraInputs: { recallBlocks: 2016 },
    ...overrides
  }) as SendTransaction;

const read = async (id: string) => (await Repo.transactions.where({ id }).first())!;

beforeEach(async () => {
  jest.clearAllMocks();
  mockVerifySendLanded.mockResolvedValue('unknown');
  await Repo.transactions.clear();
});

afterAll(async () => {
  Repo.db.close();
});

describe('the row is real: what a cancel actually does to a running send', () => {
  it('freezes the stage, because setTransactionStage refuses a terminal row', async () => {
    const tx = inFlightSend('frozen');
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, 'user cancelled');
    // The pipeline is NOT aborted by the cancel — it keeps going and reports
    // the stage it reaches next. That write is silently dropped.
    await setTransactionStage('frozen', 'submitting');

    const row = await read('frozen');
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.stage).toBe('proving');
  });

  it('cannot stop the leaf recording that it is about to broadcast', async () => {
    const tx = inFlightSend('crossing');
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, 'user cancelled');
    await markMayHaveSubmitted('crossing');

    const row = await read('crossing');
    // Still lying about where the pipeline got to — which is the whole reason
    // the crossing has to be recorded in a field of its own.
    expect(row.stage).toBe('proving');
    expect(row.mayHaveSubmitted).toBe(true);
  });

  it('refuses to capture the landed transaction id, so the node check comes up empty', async () => {
    const tx = inFlightSend('no-id');
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, 'user cancelled');
    // What `completeSendTransaction` attempts once the submit lands. It throws,
    // and this is the second half of why the row is dangerous: with no captured
    // id, `verifySendLanded` cannot prove the send landed and Retry falls
    // through to the requeue path.
    await expect(
      updateTransactionStatus('no-id', ITransactionStatus.Completed, { transactionId: '0xdeadbeef' })
    ).rejects.toThrow('already in a finalized state');

    const row = await read('no-id');
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.transactionId).toBeUndefined();
  });
});

// Reconciling a Failed row the node can prove landed is the ONLY way out of the
// state above, and it ran through `updateTransactionStatus` — whose terminal
// guard rejects the Failed row `requeueFailedTransaction` is defined over. The
// branch therefore threw on every invocation, the row stayed Failed for a send
// that had succeeded, and both UI callers rendered the raw internal message
// ('Transaction already in a finalized state') as the retry error.
describe('a send the node CAN prove landed is reconciled, not resubmitted', () => {
  it('completes the failed row instead of throwing at the user', async () => {
    mockVerifySendLanded.mockResolvedValue('landed');
    const tx = inFlightSend('reconcile', { transactionId: '0xlanded' });
    await Repo.transactions.add(tx);
    await cancelTransaction(tx, 'ambiguous post-submit abort');
    expect((await read('reconcile')).error).toBeDefined();

    await expect(requeueFailedTransaction('reconcile')).resolves.toBeUndefined();

    const row = await read('reconcile');
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.stage).toBe('complete');
    // The failure is no longer the row's story.
    expect(row.error).toBeUndefined();
    expect(row.rawError).toBeUndefined();
  });

  it('does not resubmit it — the row never returns to Queued', async () => {
    mockVerifySendLanded.mockResolvedValue('landed');
    const tx = inFlightSend('no-resubmit');
    await Repo.transactions.add(tx);
    await cancelTransaction(tx, 'boom');

    await requeueFailedTransaction('no-resubmit');

    expect((await read('no-resubmit')).status).not.toBe(ITransactionStatus.Queued);
  });
});

// The full sequence, end to end, in the order it happens in production.
describe('a send cancelled while in flight is not paid twice', () => {
  /**
   * Replays the pipeline from the moment it is cancelled: the leaf keeps
   * running, reaches the submit crossing, and the submit lands. `stampCrossing`
   * models whether the leaf records that crossing — with it, the fix; without
   * it, the shipped bug.
   */
  const runCancelledLeaf = async (id: string, { stampCrossing }: { stampCrossing: boolean }) => {
    const tx = inFlightSend(id);
    await Repo.transactions.add(tx);

    // 1. Something fails the row out from under the running pipeline.
    await cancelTransaction(tx, 'user cancelled');

    // 2. Nothing aborted the pipeline. It reaches the submit crossing.
    if (stampCrossing) await markMayHaveSubmitted(id);
    await setTransactionStage(id, 'submitting');

    // 3. The submit LANDS, and `completeSendTransaction` tries to record it. The
    //    write is REFUSED — `updateTransactionStatus` throws on a terminal row —
    //    so no transaction id is ever captured, which is why the node check in
    //    step 4 comes back 'unknown' rather than 'landed'.
    await expect(
      updateTransactionStatus(id, ITransactionStatus.Completed, { transactionId: '0xlanded' })
    ).rejects.toThrow('already in a finalized state');

    // 4. The user taps Retry on a row that looks simply failed.
    await requeueFailedTransaction(id);

    return read(id);
  };

  it('keeps the bytes that pin the note id, so the chain rejects the duplicate', async () => {
    const row = await runCancelledLeaf('p0-fixed', { stampCrossing: true });

    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.requestBytes).toBeDefined();
    expect(Array.from(row.requestBytes!)).toEqual(Array.from(BYTES()));
  });

  // Falsifiability. Same sequence with the leaf's crossing write removed is the
  // original P0: the stage still reads 'proving', Retry believes nothing was
  // broadcast, and the rebuilt request draws a fresh serial — a second payment.
  // If this ever stops failing, the guard has become decorative.
  it('would rebuild them — a second payment — if the leaf did not record the crossing', async () => {
    const row = await runCancelledLeaf('p0-unfixed', { stampCrossing: false });

    expect(row.requestBytes).toBeUndefined();
  });

  it('stays protected across a second failure at an early stage', async () => {
    await runCancelledLeaf('p0-sticky', { stampCrossing: true });

    // The requeued row is picked up again and dies during sync — genuinely
    // pre-submit for THIS attempt, but the earlier crossing still stands.
    await Repo.transactions.where({ id: 'p0-sticky' }).modify(r => {
      r.status = ITransactionStatus.Failed;
      r.stage = 'syncing';
    });
    await requeueFailedTransaction('p0-sticky');

    const row = await read('p0-sticky');
    expect(row.requestBytes).toBeDefined();
    expect(row.mayHaveSubmitted).toBe(true);
  });
});

// The guard has to be discriminating, not merely conservative. A send that
// provably never reached a submit must still rebuild its request — that rebuild
// is the PR's actual fix for the callback-asset bug, and freezing bytes on every
// failure would quietly undo it.
describe('a send that never got near a submit still rebuilds', () => {
  it('drops the stale bytes when the leaf failed before the crossing', async () => {
    const tx = inFlightSend('pre-submit');
    await Repo.transactions.add(tx);

    // Failed at 'proving' with no crossing recorded — the prover died.
    await cancelTransaction(tx, 'prover timeout');
    await requeueFailedTransaction('pre-submit');

    const row = await read('pre-submit');
    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.requestBytes).toBeUndefined();
    expect(row.mayHaveSubmitted).toBeUndefined();
  });

  it.each(['syncing', 'creating-proposal', 'signing-proposal', 'executing', 'proving'] as const)(
    'rebuilds after a failure at %s',
    async stage => {
      const tx = inFlightSend(`pre-${stage}`, { stage });
      await Repo.transactions.add(tx);
      await cancelTransaction(tx, 'boom');

      await requeueFailedTransaction(`pre-${stage}`);

      expect((await read(`pre-${stage}`)).requestBytes).toBeUndefined();
    }
  );

  // 'sending' is stamped before the guardian leaf and the OFFSCREEN leaf — the
  // shipping default — never narrows it, so it can enclose a submit.
  it.each(['sending', 'submitting'] as const)('keeps the bytes after a failure at %s', async stage => {
    const tx = inFlightSend(`post-${stage}`, { stage });
    await Repo.transactions.add(tx);
    await cancelTransaction(tx, 'boom');

    await requeueFailedTransaction(`post-${stage}`);

    expect((await read(`post-${stage}`)).requestBytes).toBeDefined();
  });
});

describe('rows written by an older build, which carry no crossing record at all', () => {
  it('keeps bytes when the stage is missing but bytes exist', async () => {
    // Pickup stamps 'syncing' then 'sending' before any request is built, so a
    // row holding bytes with no stage was RESET by an earlier requeue — the
    // history it was reset from is exactly what is unknown.
    const tx = inFlightSend('legacy-reset', { stage: undefined });
    await Repo.transactions.add(tx);
    await cancelTransaction(tx, 'reaped while queued');

    await requeueFailedTransaction('legacy-reset');

    expect((await read('legacy-reset')).requestBytes).toBeDefined();
  });
});

describe('the guard is scoped to the only type whose bytes it can drop', () => {
  it('never clears a swap, whose bytes the PSWAP flow requires byte-identically', async () => {
    const tx = inFlightSend('swap-row', { type: 'swap' });
    await Repo.transactions.add(tx);
    await cancelTransaction(tx, 'boom');

    await requeueFailedTransaction('swap-row');

    const row = await read('swap-row');
    expect(row.requestBytes).toBeDefined();
    // No crossing record is written either: nothing reads it for this type, and
    // persisting it would imply a guard swaps do not have.
    expect(row.mayHaveSubmitted).toBeUndefined();
  });
});
