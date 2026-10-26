/**
 * FUNDS SAFETY: a stage stamp replayed from the offscreen realm must never author
 * the CONTROL `stage` field.
 *
 * `transaction/index.ts` has two guardian requeue gates that read `currentRow.stage`
 * to conclude a failed transaction never reached the chain:
 *
 *   - the #419 remote-prover-outage requeue, gated on `stage === 'proving'`, whose
 *     stated proof is "submit is stamped 'submitting' and runs only AFTER prove, so
 *     nothing reached the chain";
 *   - the #617 guardian-429 requeue, gated on `'creating-proposal' | 'signing-proposal'`,
 *     whose comment says outright "the STAGE GATE is the safety property, not a nicety".
 *
 * Both requeue a VALUE-MOVING transaction. A guardian send/swap/execute has no input
 * nullifier, so a requeue after a submit actually landed builds and co-signs a SECOND
 * valid transfer — the account is debited twice with nothing on chain to reject it.
 *
 * Per-step timings (#524) are delivered from the offscreen realm over
 * `chrome.runtime` fire-and-forget, with no delivery or ordering guarantee against
 * the op's own reply. If such a stamp could write `stage`, a DROPPED or LATE
 * `submitting` would leave the row reading `proving` after submit had run, and the
 * prover-outage gate would fire on a transaction that was already on chain.
 *
 * So: cross-realm stamps record `stageTimestamps` only. The service worker's own
 * in-order writes stay the sole author of `stage`.
 */
import { setTransactionStage } from './helper';
import { ITransactionStatus } from '../db/types';

type Row = Record<string, unknown>;

const rows: Row[] = [];

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((query: { id: string }) => ({
      first: jest.fn(async () => rows.find(r => r.id === query.id)),
      modify: jest.fn(async (fn: (row: Row) => void) => {
        const row = rows.find(r => r.id === query.id);
        if (row) fn(row);
      })
    }))
  }
}));

jest.mock('../sdk/miden-client', () => ({ getMidenClient: jest.fn() }));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ TransactionResult: class {} }));
jest.mock('dexie', () => ({ liveQuery: jest.fn() }));

const seed = (extra: Row = {}) => {
  rows.length = 0;
  const row: Row = { id: 'tx-1', status: ITransactionStatus.GeneratingTransaction, type: 'send', ...extra };
  rows.push(row);
  return row;
};

describe('setTransactionStage — control vs telemetry', () => {
  it('a cross-realm (timingOnly) stamp records the boundary but does NOT move `stage`', async () => {
    const row = seed({ stage: 'sending' });

    await setTransactionStage('tx-1', 'proving', { timingOnly: true });

    expect(typeof (row.stageTimestamps as Record<string, number>).proving).toBe('number');
    // The control field is untouched — this is the funds-safety property.
    expect(row.stage).toBe('sending');
  });

  it('an inline stamp still writes both, so flag-OFF behaviour is unchanged', async () => {
    const row = seed({ stage: 'sending' });

    await setTransactionStage('tx-1', 'proving');

    expect(typeof (row.stageTimestamps as Record<string, number>).proving).toBe('number');
    expect(row.stage).toBe('proving');
  });

  it('a dropped cross-realm `submitting` cannot leave the row reading `proving`', async () => {
    // The exact scenario the prover-outage gate would misread: the offscreen leaf
    // proved, then submitted, but only the `proving` event survived the bus. Because
    // neither stamp authors `stage`, the row never claims to be mid-prove, so the
    // gate cannot conclude "nothing reached the chain".
    const row = seed({ stage: 'sending' });

    await setTransactionStage('tx-1', 'proving', { timingOnly: true });
    // ...`submitting` is dropped in transit — no second call.

    expect(row.stage).not.toBe('proving');
  });

  it('leaves a terminal row alone regardless of mode', async () => {
    const row = seed({ status: ITransactionStatus.Completed, stage: 'complete' });

    await setTransactionStage('tx-1', 'proving', { timingOnly: true });
    await setTransactionStage('tx-1', 'proving');

    expect(row.stage).toBe('complete');
    expect(row.stageTimestamps).toBeUndefined();
  });
});
