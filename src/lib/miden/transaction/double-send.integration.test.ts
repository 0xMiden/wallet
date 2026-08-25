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

import {
  MAX_WAIT_BEFORE_CANCEL,
  cancelStuckTransactions,
  cancelTransaction,
  cancelTransactionAfterPipelineStopped,
  cancelTransactionById
} from './cancel';
import { markMayHaveSubmitted, setTransactionStage, updateTransactionStatus } from './helper';
import { isUnverifiableSendRetryError, requeueFailedTransaction } from './retry';
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

// Mutable so the marker's clock can be tested on the platform where it actually
// diverges: on mobile the WebView is frozen while backgrounded, so wall-clock
// elapsed and the active seconds the threshold is denominated in come apart.
//
// Held on `globalThis` rather than in module-scope `jest.fn`s because `cancel.ts`
// calls `isMobile()` at import time (`MAX_WAIT_BEFORE_CANCEL`), which is before a
// `const` in this file is initialized — a closure over one throws on load. Reading
// an unset global just yields the desktop default, which is what the rest of the
// file wants anyway.
declare const globalThis: { __testIsMobile?: boolean; __testHiddenSeconds?: number } & typeof global;

jest.mock('lib/platform', () => ({
  isMobile: () => globalThis.__testIsMobile === true,
  isExtension: () => true,
  isDesktop: () => false
}));

jest.mock('lib/mobile/background-time', () => ({
  hiddenSecondsSince: () => globalThis.__testHiddenSeconds ?? 0
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
  globalThis.__testIsMobile = false;
  globalThis.__testHiddenSeconds = 0;
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

/**
 * The leaf's crossing stamp only runs from the moment the leaf reaches it. A
 * cancel during execute or prove lands BEFORE that — a window of seconds to
 * minutes, and the one a user actually reaches for Cancel in — so between the
 * cancel and the stamp the row looks, to Retry, exactly like a send that never
 * broadcast. Retry in that window is one click away on the same screen.
 *
 * Cancelling from outside the pipeline therefore records the uncertainty
 * itself, because a cancel does not abort the work in flight.
 */
describe('a cancel that does not stop the pipeline says so', () => {
  it('flags an in-flight send cancelled while it was only proving', async () => {
    const tx = inFlightSend('mid-prove', { stage: 'proving' });
    await Repo.transactions.add(tx);

    await cancelTransactionById('mid-prove', 'user cancelled');

    const row = await read('mid-prove');
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.cancelledInFlightAt).toEqual(expect.any(Number));
    // Not the sticky flag: nothing has submitted, and saying so permanently is
    // what bricked the row in the first version of this guard.
    expect(row.mayHaveSubmitted).toBeUndefined();
  });

  it('keeps the bytes when Retry lands before the leaf ever reached its stamp', async () => {
    const tx = inFlightSend('retry-before-stamp', { stage: 'proving' });
    await Repo.transactions.add(tx);

    // Cancel, then Retry immediately — the leaf is still proving and has not
    // stamped anything. This is the sequence the leaf-side stamp alone misses.
    await cancelTransactionById('retry-before-stamp', 'user cancelled');
    await requeueFailedTransaction('retry-before-stamp');

    expect((await read('retry-before-stamp')).requestBytes).toBeDefined();
  });

  it.each(['executing', 'creating-proposal', 'signing-proposal'] as const)(
    'covers a cancel at %s, well before any submit',
    async stage => {
      const tx = inFlightSend(`live-${stage}`, { stage });
      await Repo.transactions.add(tx);

      await cancelTransactionById(`live-${stage}`, 'user cancelled');
      await requeueFailedTransaction(`live-${stage}`);

      expect((await read(`live-${stage}`)).requestBytes).toBeDefined();
    }
  );

  it('leaves a QUEUED send alone — it was never picked up, so nothing is in flight', async () => {
    const tx = inFlightSend('never-picked-up', { status: ITransactionStatus.Queued, stage: undefined });
    await Repo.transactions.add(tx);

    await cancelTransactionById('never-picked-up', 'user cancelled');

    expect((await read('never-picked-up')).cancelledInFlightAt).toBeUndefined();
  });

  // The counterweight. If every failure were flagged, the rebuild this guard
  // gates would never happen and the PR's actual fix — a send whose request was
  // built against the wrong vault slot — could never recover.
  it('leaves the pipeline\u2019s OWN failure unflagged, so a bad request still rebuilds', async () => {
    const tx = inFlightSend('prove-died', { stage: 'proving' });
    await Repo.transactions.add(tx);

    // What the pipeline's catch does: it has already stopped, and had it
    // submitted the leaf would have stamped.
    await cancelTransactionAfterPipelineStopped(tx, new Error('prover exploded'));
    await requeueFailedTransaction('prove-died');

    const row = await read('prove-died');
    expect(row.mayHaveSubmitted).toBeUndefined();
    expect(row.requestBytes).toBeUndefined();
  });
});

/**
 * The marker says "we do not yet know", so something has to make it stop
 * saying that — otherwise it is a sticky flag again, and a send that failed
 * early has its request pinned forever and replays it on every retry. Which is
 * exactly the request the callback-asset fix in this change needs to REBUILD.
 *
 * Two things resolve it, and both are exercised here.
 */
describe('the in-flight marker resolves, so a bad request is not pinned forever', () => {
  it('the pipeline\u2019s own catch clears a concurrent cancel\u2019s marker', async () => {
    const tx = inFlightSend('cancel-then-die', { stage: 'proving' });
    await Repo.transactions.add(tx);

    // User cancels while it proves; the prove then genuinely fails.
    await cancelTransactionById('cancel-then-die', 'user cancelled');
    expect((await read('cancel-then-die')).cancelledInFlightAt).toEqual(expect.any(Number));

    await cancelTransactionAfterPipelineStopped(await read('cancel-then-die'), new Error('prover exploded'));

    const row = await read('cancel-then-die');
    expect(row.cancelledInFlightAt).toBeUndefined();

    // And so the request is rebuilt rather than replayed.
    await requeueFailedTransaction('cancel-then-die');
    expect((await read('cancel-then-die')).requestBytes).toBeUndefined();
  });

  it('but not when the leaf stamped a real crossing first — that flag is sticky', async () => {
    const tx = inFlightSend('cancel-then-submit-then-die', { stage: 'proving' });
    await Repo.transactions.add(tx);

    await cancelTransactionById('cancel-then-submit-then-die', 'user cancelled');
    // The leaf carried on past the cancel and broadcast.
    await markMayHaveSubmitted('cancel-then-submit-then-die');
    // Then the post-submit apply blew up and the catch ran.
    await cancelTransactionAfterPipelineStopped(await read('cancel-then-submit-then-die'), new Error('apply failed'));

    await requeueFailedTransaction('cancel-then-submit-then-die');

    const row = await read('cancel-then-submit-then-die');
    expect(row.cancelledInFlightAt).toBeUndefined();
    expect(row.mayHaveSubmitted).toBe(true);
    // The bytes that pin the note id survive, so the chain rejects the duplicate.
    expect(row.requestBytes).toBeDefined();
  });

  it('lapses on its own when no catch ever runs, as when the worker is recycled', async () => {
    const tx = inFlightSend('worker-died', { stage: 'proving' });
    await Repo.transactions.add(tx);
    await cancelTransactionById('worker-died', 'user cancelled');

    // Nothing cleared it, because the pipeline that would have is gone. Age it
    // past the window in which a pipeline could still be alive.
    await Repo.transactions.where({ id: 'worker-died' }).modify(r => {
      r.cancelledInFlightAt = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    });

    await requeueFailedTransaction('worker-died');

    expect((await read('worker-died')).requestBytes).toBeUndefined();
  });
});

/**
 * Regression: the reaper's marker must not be PERMANENT. It used to pin the
 * cached request of every stuck send with nothing to unpin it, so the row
 * replayed the identical failing request on every retry, forever.
 *
 * It does mark them — reaping stops the spinner, not the work; see
 * `cancelStuckTransactions`. The requirement is that the mark lapses, so a
 * request the reap caught mid-prove is rebuilt once the pipeline can no longer
 * be alive rather than replayed for good.
 */
describe('the stuck reaper does not pin the request of a send it reaps for good', () => {
  const wedged = (id: string, overrides: Partial<ITransaction> = {}) =>
    inFlightSend(id, {
      stage: 'executing',
      // Stuck: picked up over the 30-minute desktop threshold ago.
      processingStartedAt: Math.floor(Date.now() / 1000) - 60 * 60,
      ...overrides
    });

  /** Age the marker past its window, as the passage of time would. */
  const lapseMarker = async (id: string) => {
    await Repo.transactions.where({ id }).modify(r => {
      r.cancelledInFlightAt = Math.floor(Date.now() / 1000) - (MAX_WAIT_BEFORE_CANCEL + 60);
    });
  };

  it('lets a send that wedged while executing rebuild on retry', async () => {
    await Repo.transactions.add(wedged('reaped'));

    await cancelStuckTransactions();

    const reaped = await read('reaped');
    expect(reaped.status).toBe(ITransactionStatus.Failed);
    // Marked, because the pipeline may well still be running...
    expect(reaped.cancelledInFlightAt).toBeDefined();
    // ...but not as a crossing, which is the part that would be permanent.
    expect(reaped.mayHaveSubmitted).toBeUndefined();

    await lapseMarker('reaped');
    await requeueFailedTransaction('reaped');
    expect((await read('reaped')).requestBytes).toBeUndefined();
  });

  it('still keeps them when the leaf recorded a crossing before it wedged', async () => {
    await Repo.transactions.add(wedged('reaped-submitted'));
    // The leaf's stamp is not stage-dependent and survives the reap.
    await markMayHaveSubmitted('reaped-submitted');

    await cancelStuckTransactions();
    await lapseMarker('reaped-submitted');
    await requeueFailedTransaction('reaped-submitted');

    expect((await read('reaped-submitted')).requestBytes).toBeDefined();
  });
});

/**
 * `requeueFailedTransaction` reads the row, awaits a network round trip in
 * `verifySendLanded`, and only then writes. `markMayHaveSubmitted` writes the
 * flag and nothing else, so a crossing recorded inside that window passes the
 * status/stage re-check untouched — and deciding from the pre-await snapshot
 * would clear the bytes of a send that had just broadcast.
 */
describe('a crossing recorded while Retry is mid-flight is not missed', () => {
  it('keeps the bytes when the leaf stamps between the read and the write', async () => {
    const tx = inFlightSend('race', { stage: 'proving' });
    await Repo.transactions.add(tx);
    await cancelTransaction(tx, 'boom');
    // Precondition: unflagged, so the snapshot Retry takes says "pre-submit".
    expect((await read('race')).mayHaveSubmitted).toBeUndefined();

    // The leaf reaches its submit crossing during the node check.
    mockVerifySendLanded.mockImplementation(async () => {
      await markMayHaveSubmitted('race');
      return 'unknown';
    });

    await requeueFailedTransaction('race');

    const row = await read('race');
    expect(row.mayHaveSubmitted).toBe(true);
    expect(row.requestBytes).toBeDefined();
  });
});

/**
 * The two safety mechanisms elsewhere in this file both need something a plain
 * send can lack. Byte identity needs a cached request, which only the guardian
 * recallable path ever produces. The node check needs a captured transaction id,
 * which a row failed from outside its pipeline never gets, because the write
 * that would stamp it is refused on an already-terminal row.
 *
 * An offscreen wedge-kill produces exactly that row: one killable op spanning
 * execute → prove → submit → apply, torn down without saying which side of the
 * submit it died on. Rebuilding is a coin-flip on the user's money, so Retry
 * refuses and says so.
 */
describe('a plain send with nothing left to prove either way is not retried blind', () => {
  const abort = () =>
    Object.assign(new Error('Offscreen operation op-1 aborted (deadline)'), {
      name: 'OperationAbortedError'
    });

  it('records a wedge-kill as a real crossing, since the ambiguity never resolves', async () => {
    const tx = inFlightSend('wedged', { stage: 'sending', requestBytes: undefined });
    await Repo.transactions.add(tx);

    await cancelTransactionAfterPipelineStopped(await read('wedged'), abort());

    expect((await read('wedged')).mayHaveSubmitted).toBe(true);
  });

  it('records a lock-recovery eviction (WasmClientPoisonedError) as a real crossing too — the pipeline was abandoned, not stopped', async () => {
    // Issue #775: a watchdog eviction rejects the caller but cannot cancel the
    // operation, which may still reach submit. Clearing the in-flight marker
    // here would let Retry mint a second payment while the abandoned pipeline
    // completes the first.
    const { WasmClientPoisonedError } = require('lib/miden/sdk/wasm-client-poison');
    const tx = inFlightSend('wedged-poison', { stage: 'sending', requestBytes: undefined });
    await Repo.transactions.add(tx);

    await cancelTransactionAfterPipelineStopped(await read('wedged-poison'), new WasmClientPoisonedError('watchdog'));

    expect((await read('wedged-poison')).mayHaveSubmitted).toBe(true);
  });

  it('does NOT record a crossing for an eviction during the pre-write sync — that send provably never built one', async () => {
    // Issue #775. `generateTransaction`'s first act is a locked `syncState()`,
    // taken while the row still reads 'syncing' — an untimed call, so one of the
    // likeliest places for a watchdog eviction to land. `mayHaveSubmitted` is
    // permanent and Retry refuses on it, so recording it here would brick the
    // user's retry on a send that demonstrably never touched the chain.
    const { WasmClientPoisonedError } = require('lib/miden/sdk/wasm-client-poison');
    const tx = inFlightSend('poison-presync', { stage: 'syncing', requestBytes: undefined });
    await Repo.transactions.add(tx);

    await cancelTransactionAfterPipelineStopped(await read('poison-presync'), new WasmClientPoisonedError('watchdog'));

    expect((await read('poison-presync')).mayHaveSubmitted).toBeFalsy();
  });

  it('reads the stage from the COMMITTED row, not the caller snapshot, when deciding', async () => {
    // Callers pass the row they picked the transaction up with, which still
    // carries the stage it held at pickup rather than the one the failure
    // happened in. A stale 'syncing' snapshot must not clear a crossing for a
    // row that has since reached 'sending'.
    const { WasmClientPoisonedError } = require('lib/miden/sdk/wasm-client-poison');
    const tx = inFlightSend('poison-stale-snapshot', { stage: 'syncing', requestBytes: undefined });
    await Repo.transactions.add(tx);
    const staleSnapshot = await read('poison-stale-snapshot');
    await Repo.transactions.where({ id: 'poison-stale-snapshot' }).modify(row => {
      row.stage = 'sending';
    });

    await cancelTransactionAfterPipelineStopped(staleSnapshot, new WasmClientPoisonedError('watchdog'));

    expect((await read('poison-stale-snapshot')).mayHaveSubmitted).toBe(true);
  });

  it('refuses the retry rather than minting a second payment', async () => {
    const tx = inFlightSend('wedged-retry', { stage: 'sending', requestBytes: undefined });
    await Repo.transactions.add(tx);
    await cancelTransactionAfterPipelineStopped(await read('wedged-retry'), abort());

    await expect(requeueFailedTransaction('wedged-retry')).rejects.toThrow(/may already have reached the network/);
    // Still Failed — not quietly requeued behind the error.
    expect((await read('wedged-retry')).status).toBe(ITransactionStatus.Failed);
  });

  it('retries normally once the node CAN be asked, because an id was captured', async () => {
    const tx = inFlightSend('wedged-with-id', {
      stage: 'sending',
      requestBytes: undefined,
      transactionId: '0xtxid'
    });
    await Repo.transactions.add(tx);
    await cancelTransactionAfterPipelineStopped(await read('wedged-with-id'), abort());

    await requeueFailedTransaction('wedged-with-id');

    expect((await read('wedged-with-id')).status).toBe(ITransactionStatus.Queued);
  });

  it('retries normally when bytes pin the note id, because the chain rejects the duplicate', async () => {
    const tx = inFlightSend('wedged-with-bytes', { stage: 'sending' });
    await Repo.transactions.add(tx);
    await cancelTransactionAfterPipelineStopped(await read('wedged-with-bytes'), abort());

    await requeueFailedTransaction('wedged-with-bytes');

    const row = await read('wedged-with-bytes');
    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.requestBytes).toBeDefined();
  });

  // The counterweight, and the one that matters most: this release exists to fix
  // a send rejected by the kernel for addressing the wrong vault slot. That is an
  // ordinary failure, not an aborted op, so it must still rebuild and retry.
  it('leaves an ordinary pipeline failure fully retryable', async () => {
    const tx = inFlightSend('vault-slot', { stage: 'executing', requestBytes: undefined });
    await Repo.transactions.add(tx);

    await cancelTransactionAfterPipelineStopped(
      await read('vault-slot'),
      new Error('failed to remove the fungible asset from the vault')
    );
    await requeueFailedTransaction('vault-slot');

    const row = await read('vault-slot');
    expect(row.mayHaveSubmitted).toBeUndefined();
    expect(row.status).toBe(ITransactionStatus.Queued);
  });

  it('does not apply the abort rule to types that have their own protection', async () => {
    const tx = inFlightSend('wedged-swap', { type: 'swap', stage: 'sending' });
    await Repo.transactions.add(tx);

    await cancelTransactionAfterPipelineStopped(await read('wedged-swap'), abort());

    // A swap's bytes are reused byte-identically, so the chain rejects a
    // duplicate on its own and the row stays retryable.
    expect((await read('wedged-swap')).mayHaveSubmitted).toBeUndefined();
    await requeueFailedTransaction('wedged-swap');
    expect((await read('wedged-swap')).status).toBe(ITransactionStatus.Queued);
  });
});

// The guard's failure mode is not letting a double-send through — it is refusing
// a send that was never at risk. A plain (non-guardian) send is where the two are
// easiest to confuse: it holds no bytes, and its pipeline stamps 'sending' ONCE at
// pickup and never narrows, so `PRE_SUBMIT_STAGES` cannot vouch for any of its
// failures. Treating that silence as evidence of a crossing refuses every retry
// it has.
describe('a plain send is not refused on the strength of a stage it never had', () => {
  const plainSend = (id: string, overrides: Partial<ITransaction> = {}) =>
    inFlightSend(id, {
      stage: 'sending',
      requestBytes: undefined,
      status: ITransactionStatus.Failed,
      ...overrides
    });

  it('does not invent a crossing for a row with no bytes to protect', async () => {
    await Repo.transactions.add(plainSend('plain-1'));

    await requeueFailedTransaction('plain-1');

    const row = await read('plain-1');
    expect(row.status).toBe(ITransactionStatus.Queued);
    expect(row.mayHaveSubmitted).toBeUndefined();
  });

  // The regression this pair pins: the flag used to be written from the stage
  // alone, so every plain send earned it on its first requeue and was refused on
  // its second — Retry working exactly once, then failing shut for good.
  it('is still retryable after failing again, and again', async () => {
    await Repo.transactions.add(plainSend('plain-2'));

    for (let attempt = 0; attempt < 3; attempt++) {
      await requeueFailedTransaction('plain-2');
      expect((await read('plain-2')).status).toBe(ITransactionStatus.Queued);
      await Repo.transactions.where({ id: 'plain-2' }).modify(r => {
        r.status = ITransactionStatus.Failed;
        r.stage = 'sending';
      });
    }
  });

  it('including the vault-slot rejection this release exists to fix', async () => {
    await Repo.transactions.add(
      plainSend('plain-vault-slot', { error: 'failed to remove the fungible asset from the vault' })
    );

    await requeueFailedTransaction('plain-vault-slot');
    await Repo.transactions.where({ id: 'plain-vault-slot' }).modify(r => {
      r.status = ITransactionStatus.Failed;
      r.stage = 'sending';
    });

    await expect(requeueFailedTransaction('plain-vault-slot')).resolves.toBeUndefined();
    expect((await read('plain-vault-slot')).status).toBe(ITransactionStatus.Queued);
  });

  // ...while the two producers that DO record a crossing still refuse, so the
  // scoping above did not simply disable the guard.
  it('but a recorded crossing on a byteless row still refuses', async () => {
    await Repo.transactions.add(plainSend('plain-crossed'));
    await markMayHaveSubmitted('plain-crossed');

    await expect(requeueFailedTransaction('plain-crossed')).rejects.toThrow(/may already have reached the network/);
  });

  // A row WITH bytes keeps the stage-derived flag: there the flag protects
  // something, and pinning the note id is what makes the duplicate rejectable.
  it('still persists the stage verdict when there are bytes to protect', async () => {
    await Repo.transactions.add(inFlightSend('guardian-row', { stage: 'sending', status: ITransactionStatus.Failed }));

    await requeueFailedTransaction('guardian-row');

    const row = await read('guardian-row');
    expect(row.mayHaveSubmitted).toBe(true);
    expect(row.requestBytes).toBeDefined();
  });

  // An unresolved "don't know yet" must not be laundered into a permanent "yes"
  // by passing through a requeue: it expires by design, and freezing it would
  // pin the request — and its absolute reclaim height — forever.
  it('does not promote an expiring cancel marker into a permanent crossing', async () => {
    await Repo.transactions.add(
      inFlightSend('cancel-marker', {
        stage: 'proving',
        status: ITransactionStatus.Failed,
        cancelledInFlightAt: Math.floor(Date.now() / 1000)
      })
    );

    await requeueFailedTransaction('cancel-marker');

    const row = await read('cancel-marker');
    // Bytes held, because the marker still says a submit is possible...
    expect(row.requestBytes).toBeDefined();
    // ...but on the expiring marker alone, so it can still lapse.
    expect(row.mayHaveSubmitted).toBeUndefined();
    expect(row.cancelledInFlightAt).toBeDefined();
  });
});

// `MAX_WAIT_BEFORE_CANCEL` is denominated in ACTIVE seconds — the reaper that
// owns it subtracts backgrounded time. The marker compared wall clock against it,
// so on a phone the two disagreed about the same row.
describe('the marker is measured on the same clock as the threshold it is bounded by', () => {
  const cancelledAgo = (seconds: number) =>
    inFlightSend('phone', {
      stage: 'proving',
      status: ITransactionStatus.Failed,
      requestBytes: undefined,
      cancelledInFlightAt: Math.floor(Date.now() / 1000) - seconds
    });

  // Past the window in wall-clock terms either way; the two differ only in how
  // much of that stretch the platform had us frozen for.
  const WALL = MAX_WAIT_BEFORE_CANCEL + 600;

  it('holds a send backgrounded past the wall-clock window but barely active', async () => {
    globalThis.__testIsMobile = true;
    // Almost all of it frozen: the pipeline has had a fraction of the window to
    // run in, and is still there to resume and submit.
    globalThis.__testHiddenSeconds = WALL - 100;
    await Repo.transactions.add(cancelledAgo(WALL));

    await expect(requeueFailedTransaction('phone')).rejects.toThrow(/may already have reached the network/);
  });

  it('lets the same elapsed wall clock lapse when none of it was frozen', async () => {
    globalThis.__testIsMobile = true;
    globalThis.__testHiddenSeconds = 0;
    await Repo.transactions.add(cancelledAgo(WALL));

    await requeueFailedTransaction('phone');
    expect((await read('phone')).status).toBe(ITransactionStatus.Queued);
  });

  it('does not discount anything on desktop, where a background tab keeps running', async () => {
    globalThis.__testIsMobile = false;
    globalThis.__testHiddenSeconds = WALL - 100;
    await Repo.transactions.add(cancelledAgo(WALL));

    await requeueFailedTransaction('phone');
    expect((await read('phone')).status).toBe(ITransactionStatus.Queued);
  });

  // A stamp cannot be written in the future, so a future one means the clock moved
  // backwards under us. Read as a plain `now - at <= MAX` that is negative, hence
  // "live", for the whole span of the discrepancy — days, for a restored row.
  it('treats a wildly future-dated stamp as telling us nothing, not as live forever', async () => {
    await Repo.transactions.add(
      inFlightSend('skewed', {
        stage: 'proving',
        status: ITransactionStatus.Failed,
        requestBytes: undefined,
        cancelledInFlightAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
      })
    );

    await requeueFailedTransaction('skewed');
    expect((await read('skewed')).status).toBe(ITransactionStatus.Queued);
  });

  it('still holds through a small backwards correction, which is real skew', async () => {
    await Repo.transactions.add(
      inFlightSend('skewed-small', {
        stage: 'proving',
        status: ITransactionStatus.Failed,
        requestBytes: undefined,
        cancelledInFlightAt: Math.floor(Date.now() / 1000) + 30
      })
    );

    await expect(requeueFailedTransaction('skewed-small')).rejects.toThrow(/may already have reached the network/);
  });
});

describe('the marker lands only where there is still a pipeline to outlive the cancel', () => {
  it('is not stranded on a row whose pipeline stopped between the read and the write', async () => {
    const tx = inFlightSend('raced', { stage: 'proving', requestBytes: undefined });
    await Repo.transactions.add(tx);
    // The Cancel reads the row here (still in flight)...
    const snapshot = await read('raced');
    // ...the pipeline's own catch gets there first, resolving the marker...
    await cancelTransactionAfterPipelineStopped(snapshot, new Error('prove failed'));
    // ...and only then does the Cancel write, off its stale snapshot.
    await cancelTransactionById('raced', 'user cancelled');

    // No marker: the only thing that would have cleared it has already run, so a
    // fresh one here would refuse the row for its full lifetime for nothing.
    expect((await read('raced')).cancelledInFlightAt).toBeUndefined();
    await requeueFailedTransaction('raced');
    expect((await read('raced')).status).toBe(ITransactionStatus.Queued);
  });

  it('still marks a row whose pipeline really is in flight', async () => {
    await Repo.transactions.add(inFlightSend('live', { stage: 'proving', requestBytes: undefined }));

    await cancelTransactionById('live', 'user cancelled');

    expect((await read('live')).cancelledInFlightAt).toBeDefined();
  });

  it('leaves a Queued row alone — it was never picked up', async () => {
    await Repo.transactions.add(
      inFlightSend('queued', { status: ITransactionStatus.Queued, stage: undefined, requestBytes: undefined })
    );

    await cancelTransactionById('queued', 'user cancelled');

    expect((await read('queued')).cancelledInFlightAt).toBeUndefined();
  });
});

// The reaper's stated premise was that a row it takes cannot still be running.
// The threshold is when the app stops waiting, not when the work stops.
describe('the stuck reaper marks what it reaps, because reaping does not stop the work', () => {
  it('marks a reaped send, so Retry does not treat it as never sent', async () => {
    await Repo.transactions.add(
      inFlightSend('reaped', {
        stage: 'proving',
        requestBytes: undefined,
        processingStartedAt: Math.floor(Date.now() / 1000) - 10_000
      })
    );

    await cancelStuckTransactions();

    const row = await read('reaped');
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.cancelledInFlightAt).toBeDefined();
    await expect(requeueFailedTransaction('reaped')).rejects.toThrow(/may already have reached the network/);
  });

  // The marker expiring is no longer enough on its own. It retires the precise
  // reading ("a pipeline was live when we cancelled"), but the coarse one behind
  // it survives: the row demonstrably left the queue, and for a send that is
  // never narrowed any further, so a submit still cannot be ruled out from the
  // row alone. What keeps this from bricking is the acknowledgement below, not
  // the clock — the user reads their own balance and answers the one question
  // the wallet cannot.
  it('still refuses once the window has passed, and requeues when the user acknowledges', async () => {
    await Repo.transactions.add(
      inFlightSend('reaped-later', {
        stage: 'proving',
        requestBytes: undefined,
        processingStartedAt: Math.floor(Date.now() / 1000) - 10_000
      })
    );
    await cancelStuckTransactions();

    await Repo.transactions.where({ id: 'reaped-later' }).modify(r => {
      r.cancelledInFlightAt = Math.floor(Date.now() / 1000) - (MAX_WAIT_BEFORE_CANCEL + 60);
    });

    await expect(requeueFailedTransaction('reaped-later')).rejects.toThrow(/may already have reached the network/);

    await requeueFailedTransaction('reaped-later', { acknowledgeUnverifiedSend: true });
    expect((await read('reaped-later')).status).toBe(ITransactionStatus.Queued);
  });
});

// A guard whose only outcome is a permanently broken row gets worked around: the
// Retry button never hides, so it throws the same error on every tap, and the way
// out is to send again by hand — the double payment the guard exists to prevent.
// The wallet cannot tell whether the send landed; the user can see it in their
// balance, so it asks them.
describe('a refused send is not a dead end', () => {
  const refused = async (id: string) => {
    await Repo.transactions.add(
      inFlightSend(id, { stage: 'sending', status: ITransactionStatus.Failed, requestBytes: undefined })
    );
    await markMayHaveSubmitted(id);
  };

  it('refuses by default, with an error the UI can tell apart from any other', async () => {
    await refused('ack-1');

    await expect(requeueFailedTransaction('ack-1')).rejects.toMatchObject({
      name: 'UnverifiableSendRetryError'
    });
    expect(isUnverifiableSendRetryError(new Error('something else'))).toBe(false);
  });

  it('proceeds once the user confirms the send never arrived', async () => {
    await refused('ack-2');

    await requeueFailedTransaction('ack-2', { acknowledgeUnverifiedSend: true });

    expect((await read('ack-2')).status).toBe(ITransactionStatus.Queued);
  });

  // Retracted, not stepped over: the user has ruled the crossing out, so a LATER
  // failure on this row must be judged on its own evidence. Leaving the flag set
  // would refuse the next retry for a crossing that has been disproved.
  it('clears the markers rather than bypassing them', async () => {
    await refused('ack-3');
    await Repo.transactions.where({ id: 'ack-3' }).modify(r => {
      r.cancelledInFlightAt = Math.floor(Date.now() / 1000);
    });

    await requeueFailedTransaction('ack-3', { acknowledgeUnverifiedSend: true });

    const row = await read('ack-3');
    expect(row.mayHaveSubmitted).toBeUndefined();
    expect(row.cancelledInFlightAt).toBeUndefined();
  });

  it('is retryable again after the acknowledged attempt fails once more', async () => {
    await refused('ack-4');
    await requeueFailedTransaction('ack-4', { acknowledgeUnverifiedSend: true });
    await Repo.transactions.where({ id: 'ack-4' }).modify(r => {
      r.status = ITransactionStatus.Failed;
      r.stage = 'sending';
    });

    // No acknowledgement needed this time: nothing records a crossing any more.
    await requeueFailedTransaction('ack-4');
    expect((await read('ack-4')).status).toBe(ITransactionStatus.Queued);
  });

  // The acknowledgement is scoped to the refusal it answers, and must not become a
  // general override of the other guards.
  it('does not requeue a landed transaction just because the flag is passed', async () => {
    await refused('ack-5');
    mockVerifySendLanded.mockResolvedValue('landed');

    await requeueFailedTransaction('ack-5', { acknowledgeUnverifiedSend: true });

    expect((await read('ack-5')).status).toBe(ITransactionStatus.Completed);
  });

  it('does not make a non-retryable type retryable', async () => {
    await Repo.transactions.add(inFlightSend('ack-6', { type: 'earn-deposit', status: ITransactionStatus.Failed }));

    await expect(requeueFailedTransaction('ack-6', { acknowledgeUnverifiedSend: true })).rejects.toThrow(
      /not retryable/
    );
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
