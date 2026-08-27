/**
 * What a transaction's outcome reports, against the REAL database.
 *
 * The gap this closes was invisible to every other test in the suite. Ask "does
 * the wallet notice when the remote prover is down and a send fails as a result"
 * and the answer was no, in both channels at once: no product event, because
 * every value-moving flow reports `completed` the moment the row is enqueued and
 * long before anything is proved, and no crash report, because the pipeline
 * catches its own errors and turns them into failure UX rather than letting one
 * reach a global handler. A transaction could fail every time, for everyone, and
 * nothing outside the device would say so.
 *
 * So these assertions are about a fact reaching the reporter at all, and about
 * the two properties that make it worth having: the stage it died in, and a
 * success side to divide it by. `lib/miden/repo` is the real Dexie schema on
 * `fake-indexeddb`, and cancel and the status writer are the real
 * implementations — the reporter is the only thing stubbed, because it is the
 * boundary under test.
 */
import * as Repo from 'lib/miden/repo';
import { SettledOperation } from 'lib/telemetry/report-operation';

import { cancelTransaction } from './cancel';
import { markBridgedSendFailed, updateBridgedReceivePhase, updateEarnWithdrawPhase } from './complete';
import {
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_INTERRUPTED_ON_STARTUP,
  USER_CANCELLED_TRANSACTION_REASON
} from './constants';
import { completeVerifiedLandedTransaction, updateTransactionStatus } from './helper';
import { ITransaction, ITransactionStatus, ITransactionType, SendTransaction } from '../db/types';

const reported: SettledOperation[] = [];

/** The one operation that should have been reported, or a failure saying so. */
const onlyReported = (): SettledOperation => {
  expect(reported).toHaveLength(1);
  const [event] = reported;
  if (event === undefined) throw new Error('expected one reported operation');
  return event;
};
jest.mock('lib/telemetry/report-operation', () => ({
  reportOperation: (settled: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (global as unknown as { __reported: unknown[] }).__reported.push(settled);
  }
}));
(global as unknown as { __reported: SettledOperation[] }).__reported = reported;

jest.mock('../back/background-notification', () => ({ notifyBackgroundTransactionFailed: jest.fn() }));
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: { getInputNoteDetails: jest.fn(async () => []), syncState: jest.fn(async () => ({})) },
  dispatchGuardianPipeline: jest.fn()
}));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async (fn: () => unknown) => fn(),
  getMidenClient: jest.fn()
}));
jest.mock('lib/platform', () => ({ isMobile: () => false, isExtension: () => true, isDesktop: () => false }));
jest.mock('lib/mobile/background-time', () => ({ hiddenSecondsSince: () => 0 }));

/** Started 30 seconds ago, so the reported duration is a real elapsed time. */
const STARTED_SECONDS_AGO = 30;

const row = (id: string, overrides: Partial<ITransaction> = {}): SendTransaction =>
  ({
    id,
    type: 'send' as ITransactionType,
    accountId: 'mtst1sender',
    secondaryAccountId: 'mtst1recipient',
    faucetId: 'mtst1faucet',
    amount: '1500000',
    noteType: 'private',
    status: ITransactionStatus.GeneratingTransaction,
    stage: 'proving',
    initiatedAt: Math.floor(Date.now() / 1000) - STARTED_SECONDS_AGO,
    displayMessage: 'Sending',
    displayIcon: 'SEND',
    ...overrides
  }) as SendTransaction;

beforeEach(async () => {
  reported.length = 0;
  jest.clearAllMocks();
  await Repo.transactions.clear();
});

afterAll(() => {
  Repo.db.close();
});

describe('a transaction that failed', () => {
  it('reports the failure, the kind, and the stage it died in', async () => {
    const tx = row('prover-down');
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, new Error('Remote prover request timed out'));

    // The stage is the whole point. Without it a failure says only "a send
    // failed", which cannot distinguish a prover outage from a node rejection
    // from a bug in the wallet — and those have nothing in common but the row.
    expect(reported).toEqual([
      { operation: 'tx_send', result: 'errored', durationMs: expect.any(Number), errorKind: 'timeout', step: 'proving' }
    ]);
  });

  it('measures how long the user waited before it failed', async () => {
    const tx = row('slow-failure');
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, new Error('boom'));

    // Rows keep seconds and telemetry reports milliseconds; a missing conversion
    // would land here as 30 rather than 30_000 and quietly make every duration
    // in the dashboard a thousand times too small.
    expect(onlyReported().durationMs).toBeGreaterThanOrEqual(STARTED_SECONDS_AGO * 1000);
    expect(onlyReported().durationMs).toBeLessThan((STARTED_SECONDS_AGO + 30) * 1000);
  });

  it.each<[string, ITransactionType, string]>([
    ['a swap', 'swap', 'tx_swap'],
    ['a claim', 'consume', 'tx_receive'],
    ['an earn movement', 'earn-deposit', 'tx_earn'],
    ['a bridge', 'bridged-send', 'tx_bridge'],
    ['a guardian rotation', 'replace-hot-key', 'tx_guardian'],
    ['a dApp transaction', 'execute', 'tx_dapp']
  ])('covers %s, not just a send', async (_label, type, operation) => {
    // Every one of these funnels through the same cancel, which is why hooking
    // it once covers the whole surface rather than the two flows a review screen
    // happens to own.
    const tx = row(`failed-${type}`, { type });
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, new Error('boom'));

    expect(reported.map(event => event.operation)).toEqual([operation]);
  });

  it('reports no stage for a row that had not recorded one', async () => {
    const tx = row('no-stage', { stage: undefined });
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, new Error('boom'));

    expect(onlyReported().step).toBeUndefined();
  });
});

describe('what is not a failure', () => {
  it.each([
    ['the user cancelled it', USER_CANCELLED_TRANSACTION_REASON],
    ['the app was restarting', TRANSACTION_INTERRUPTED_ON_STARTUP]
  ])('reports nothing when %s', async (_why, reason) => {
    // Counting these would put a floor under the error rate that no amount of
    // fixing could lower, and the startup sweep alone would dominate it: it
    // fails every in-progress row on every cold start.
    const tx = row(`not-a-failure-${reason}`);
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, reason);

    expect(reported).toEqual([]);
  });

  it('DOES report a consume the node said never landed, despite the reason being named an interruption', async () => {
    // `TRANSACTION_INTERRUPTED_ERROR` is on the notification's suppression list
    // and must not be on the reporting one. Its single caller is
    // `verifyStuckTransactionsFromNode`, reached only after the node has been
    // asked and has said the input note is still unconsumed on a consume past
    // the grace window — a node-verified terminal failure, whose name is a
    // leftover from the user-facing copy. Suppressing it undercounts `tx_receive`
    // failures by exactly the share the reaper resolves, and those are the ones
    // nothing else reports either, since no pipeline catch ever ran for them.
    const tx = row('reaped-consume', { type: 'consume' as ITransactionType, stage: 'sending' });
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, TRANSACTION_INTERRUPTED_ERROR);

    expect(reported).toEqual([
      {
        operation: 'tx_receive',
        result: 'errored',
        durationMs: expect.any(Number),
        errorKind: 'unknown',
        step: 'sending'
      }
    ]);
  });

  it('reports nothing for a row that had already finished', async () => {
    // A late error against a completed row is refused by cancel itself. It must
    // be refused here too, or a successful transaction would report a failure
    // as well as its success and the rate would count it twice.
    const tx = row('already-done', { status: ITransactionStatus.Completed });
    await Repo.transactions.add(tx);

    await cancelTransaction(tx, new Error('a late straggler'));

    expect(reported).toEqual([]);
  });
});

describe('a transaction that succeeded', () => {
  it('reports the success, so the failure count has a denominator', async () => {
    const tx = row('landed');
    await Repo.transactions.add(tx);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {});

    expect(reported).toEqual([{ operation: 'tx_send', result: 'completed', durationMs: expect.any(Number) }]);
  });

  it('measures how long the user waited for it to land', async () => {
    const tx = row('landed-slowly');
    await Repo.transactions.add(tx);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {});

    // Same seconds-to-milliseconds conversion as the failure side, and the same
    // way to get it wrong. This is the number a latency regression shows up in.
    expect(onlyReported().durationMs).toBeGreaterThanOrEqual(STARTED_SECONDS_AGO * 1000);
    expect(onlyReported().durationMs).toBeLessThan((STARTED_SECONDS_AGO + 30) * 1000);
  });

  it('reports a failure written straight through the status writer, which cancel never sees', async () => {
    // A private send whose note could not be delivered, a guardian rotation that
    // could not be applied: a handful of failures skip `cancelTransaction` and
    // write `Failed` here instead. They were the only failures reporting nothing
    // at all. There is no double count, because cancel writes with a raw
    // `.modify` and never reaches this function.
    const tx = row('bypassed-cancel');
    await Repo.transactions.add(tx);

    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      error: 'Could not reach the node',
      rawError: 'failed to fetch'
    });

    expect(reported).toEqual([
      {
        operation: 'tx_send',
        result: 'errored',
        durationMs: expect.any(Number),
        errorKind: 'network',
        step: 'proving'
      }
    ]);
  });

  it('reports the success when a failed transaction turns out to have landed', async () => {
    // The ambiguous post-submit abort: the wallet failed the row because it could
    // not tell whether the money had moved, then node evidence said it had. Both
    // events stand — the failure was true when reported, and without this one the
    // case that motivated the reconciliation existing would be permanently
    // counted as a failure and never as a success.
    //
    // With no duration, deliberately. The only caller runs when the user taps
    // Retry, so the interval available is how long they were away — and putting
    // that in the field a reader watches for latency regressions would let a
    // handful of them own the tail of every send. Asserted as an absent KEY, not
    // a zero: a zero is counted by anything that averages.
    const tx = row('reconciled', { status: ITransactionStatus.Failed, error: 'Could not verify' });
    await Repo.transactions.add(tx);

    await completeVerifiedLandedTransaction(tx.id);

    expect(reported).toEqual([{ operation: 'tx_send', result: 'completed' }]);
  });

  it('reports nothing when there was no failed row to reconcile', async () => {
    const tx = row('nothing-to-reconcile', { status: ITransactionStatus.Completed });
    await Repo.transactions.add(tx);

    await completeVerifiedLandedTransaction(tx.id);

    expect(reported).toEqual([]);
  });

  it('takes back the success when a bridge intent is rejected after the note committed', async () => {
    // The mirror of the reconciliation above, and the case where reporting
    // nothing is worse than useless. As far as the send pipeline is concerned a
    // bridged-send succeeded — it wrote `Completed` and reported it — and the
    // allocator then rejects the intent, leaving the funds in a recallable note.
    // Without a second event the only thing a failed bridge ever says is that it
    // worked, which moves a failure into the denominator and makes the bridge
    // look healthier the more often it fails this exact way.
    const tx = row('bridge-rejected', { type: 'bridged-send' as ITransactionType });
    await Repo.transactions.add(tx);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {});
    await markBridgedSendFailed(tx.id, 'solver has no liquidity for this route', 12345);

    expect(reported).toEqual([
      { operation: 'tx_bridge', result: 'completed', durationMs: expect.any(Number) },
      {
        operation: 'tx_bridge',
        result: 'errored',
        durationMs: expect.any(Number),
        errorKind: 'unknown',
        step: 'submitting'
      }
    ]);
  });
});

describe('the rows that are Completed from birth', () => {
  // Two row types carry their real outcome in `extraInputs.phase` and are
  // `Completed` in the database from the moment they are created, so neither ever
  // makes a terminal write through `updateTransactionStatus` and neither was
  // reporting anything at all — not a failure, and not a success either. So
  // `tx_bridge_settled` counted only outbound bridges and `tx_earn_settled` only
  // deposits, while the docs said these events mean "one transaction reached a
  // terminal state". Same structural blind spot the whole feature exists to
  // close, left open for the two row types where the money is least visible.
  const phased = (id: string, type: string, phase: string): ITransaction =>
    row(id, {
      type: type as ITransactionType,
      status: ITransactionStatus.Completed,
      extraInputs: { phase }
    } as Partial<ITransaction>) as ITransaction;

  it('reports a failed earn withdrawal, which the user cannot even retry', async () => {
    // `earn-withdraw` is excluded from `REQUEUEABLE_TYPES`, so a failure here is
    // terminal from the user's side: the funds simply appear stuck. Reporting
    // nothing made that invisible.
    const tx = phased('withdraw-failed', 'earn-withdraw', 'delivering');
    await Repo.transactions.add(tx);

    await updateEarnWithdrawPhase(tx.id, 'failed', { error: 'bridge relay timed out' });

    expect(onlyReported()).toEqual({
      operation: 'tx_earn',
      result: 'errored',
      durationMs: expect.any(Number),
      errorKind: 'timeout',
      step: 'submitting'
    });
  });

  it('reports a successful earn withdrawal, so the failure has a denominator', async () => {
    const tx = phased('withdraw-landed', 'earn-withdraw', 'delivering');
    await Repo.transactions.add(tx);

    await updateEarnWithdrawPhase(tx.id, 'received');

    expect(onlyReported()).toEqual({
      operation: 'tx_earn',
      result: 'completed',
      durationMs: expect.any(Number)
    });
  });

  it('reports an earn withdrawal once even when a later writer patches the terminal row again', async () => {
    // `canAdvanceEarnWithdrawPhase` permits SAME-phase writes on purpose, so
    // callers can idempotently patch a note id or an output amount onto a row
    // that has already settled — and `completeConsumeTransaction` writes
    // `received` on a row `resolveBridgeInNoteId` may have already moved there.
    // So the double report is reachable, and the only thing standing in front of
    // it is the check that the row was not already terminal.
    const tx = phased('withdraw-patched', 'earn-withdraw', 'delivering');
    await Repo.transactions.add(tx);

    await updateEarnWithdrawPhase(tx.id, 'received');
    await updateEarnWithdrawPhase(tx.id, 'received', { midenNoteId: '0xnote' });

    expect(reported).toHaveLength(1);
  });

  it('reports an inbound bridge once, on the phase where the bridge finished its job', async () => {
    // `ready` and `received` are both terminal — the note is on Miden and
    // claimable, then it is claimed. The bridge is done at `ready`; whether the
    // user then claims it is a question about the user. And unlike the
    // earn-withdraw writer there is no monotonic guard here, so passing through
    // both phases must still produce exactly one event.
    const tx = phased('bridge-in', 'bridged-receive', 'delivering');
    await Repo.transactions.add(tx);

    await updateBridgedReceivePhase(tx.id, 'ready');
    await updateBridgedReceivePhase(tx.id, 'received');

    expect(onlyReported()).toEqual({
      operation: 'tx_bridge',
      result: 'completed',
      durationMs: expect.any(Number)
    });
  });

  it('reports a failed inbound bridge, which is money the user cannot see', async () => {
    const tx = phased('bridge-in-failed', 'bridged-receive', 'submitting');
    await Repo.transactions.add(tx);

    await updateBridgedReceivePhase(tx.id, 'failed', { error: 'intent rejected by the allocator' });

    expect(onlyReported()).toEqual({
      operation: 'tx_bridge',
      result: 'errored',
      durationMs: expect.any(Number),
      errorKind: 'unknown',
      step: 'submitting'
    });
  });

  it('reports nothing for a phase that is not the end of anything', async () => {
    const tx = phased('bridge-in-progress', 'bridged-receive', 'submitting');
    await Repo.transactions.add(tx);

    await updateBridgedReceivePhase(tx.id, 'delivering');

    expect(reported).toEqual([]);
  });

  it('reports nothing for a status on the way there', async () => {
    // Only the terminal write is an outcome. Reporting an intermediate one would
    // count a single transaction several times over.
    const tx = row('still-going', { status: ITransactionStatus.Queued });
    await Repo.transactions.add(tx);

    await updateTransactionStatus(tx.id, ITransactionStatus.GeneratingTransaction, {});

    expect(reported).toEqual([]);
  });
});
