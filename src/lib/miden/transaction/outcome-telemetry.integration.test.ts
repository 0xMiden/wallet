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
import { TRANSACTION_INTERRUPTED_ON_STARTUP, USER_CANCELLED_TRANSACTION_REASON } from './constants';
import { updateTransactionStatus } from './helper';
import { ITransaction, ITransactionStatus, ITransactionType, SendTransaction } from '../db/types';

const reported: SettledOperation[] = [];
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
    expect(reported[0].durationMs).toBeGreaterThanOrEqual(STARTED_SECONDS_AGO * 1000);
    expect(reported[0].durationMs).toBeLessThan((STARTED_SECONDS_AGO + 30) * 1000);
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

    expect(reported[0].step).toBeUndefined();
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
    expect(reported[0].durationMs).toBeGreaterThanOrEqual(STARTED_SECONDS_AGO * 1000);
    expect(reported[0].durationMs).toBeLessThan((STARTED_SECONDS_AGO + 30) * 1000);
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

  it('reports nothing for a status on the way there', async () => {
    // Only the terminal write is an outcome. Reporting an intermediate one would
    // count a single transaction several times over.
    const tx = row('still-going', { status: ITransactionStatus.Queued });
    await Repo.transactions.add(tx);

    await updateTransactionStatus(tx.id, ITransactionStatus.GeneratingTransaction, {});

    expect(reported).toEqual([]);
  });
});
