import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { USER_CANCELLED_TRANSACTION_REASON } from 'lib/miden/transaction/constants';

import {
  classifyPaybackClaimFailure,
  getPaybackClaimState,
  getPaybackClaimStates,
  paybackClaimStateFrom,
  type NoteCoverage
} from './payback-claim';

jest.mock('lib/miden/repo', () => ({ transactions: { where: jest.fn() } }));

const swap = (extraInputs: Record<string, unknown> = {}, id = 'swap-1'): ITransaction =>
  ({
    id,
    type: 'swap',
    status: ITransactionStatus.Completed,
    accountId: 'acct',
    initiatedAt: 100,
    extraInputs: { orderId: '7', expiresAt: 200, ...extraInputs }
  }) as unknown as ITransaction;

const claim = (
  id: string,
  overrides: Partial<ITransaction> = {},
  kind: 'settle' | 'reclaim' = 'settle',
  swapId = 'swap-1'
): ITransaction =>
  ({
    id,
    type: 'consume',
    status: ITransactionStatus.Failed,
    accountId: 'acct',
    initiatedAt: 110,
    noteIds: [`${id}-note`],
    error: 'Transaction failed',
    extraInputs: { swapOrderTxId: swapId, swapSettleKind: kind },
    ...overrides
  }) as unknown as ITransaction;

const open: NoteCoverage = () => 'open';

describe('paybackClaimStateFrom', () => {
  it('reports the most recent unclaimed failed payout claim as stuck', () => {
    const state = paybackClaimStateFrom(
      swap(),
      [claim('old', { initiatedAt: 105 }), claim('latest', { initiatedAt: 120, rawError: 'Failed to fetch' })],
      open
    );
    expect(state).toEqual({ stuck: true, failedClaimId: 'latest', reason: 'network' });
  });

  it('keeps an older failed chunk stuck beside a newer completed chunk (F-002)', () => {
    const state = paybackClaimStateFrom(
      swap(),
      [
        claim('failed-chunk', { initiatedAt: 105 }),
        claim('done-chunk', { status: ITransactionStatus.Completed, initiatedAt: 120 })
      ],
      open
    );
    expect(state).toEqual({ stuck: true, failedClaimId: 'failed-chunk', reason: 'other' });
  });

  it.each([{ settledAt: 130 }, { reclaimedAt: 130 }])(
    'keeps an unclaimed failed chunk stuck whatever stamp the order carries (%o)',
    stamp => {
      expect(paybackClaimStateFrom(swap(stamp), [claim('failed')], open)).toEqual({
        stuck: true,
        failedClaimId: 'failed',
        reason: 'other'
      });
    }
  );

  it('is not stuck once another consume claimed every note of the failed claim (F-001)', () => {
    const coverage: NoteCoverage = noteId => (noteId === 'failed-note' ? 'claimed' : 'open');
    expect(paybackClaimStateFrom(swap({ reclaimedAt: 130 }), [claim('failed')], coverage)).toEqual({ stuck: false });
  });

  it('is not stuck while a live consume holds the failed claim notes, tagged or not (F-004)', () => {
    const coverage: NoteCoverage = noteId => (noteId === 'failed-note' ? 'held' : 'open');
    expect(paybackClaimStateFrom(swap(), [claim('failed')], coverage)).toEqual({ stuck: false });
  });

  it('is not stuck while a payout claim is queued, running or awaiting its verdict', () => {
    for (const status of [
      ITransactionStatus.Queued,
      ITransactionStatus.GeneratingTransaction,
      ITransactionStatus.Unconfirmed
    ]) {
      expect(
        paybackClaimStateFrom(swap(), [claim('failed'), claim('live', { status, initiatedAt: 90 })], open)
      ).toEqual({ stuck: false });
    }
  });

  it('ignores reclaim rows, cancelled claims and claims restored from a backup', () => {
    expect(
      paybackClaimStateFrom(
        swap(),
        [
          claim('reclaim', {}, 'reclaim'),
          claim('cancelled', { error: USER_CANCELLED_TRANSACTION_REASON }),
          claim('restored', { restoredFromBackup: true })
        ],
        open
      )
    ).toEqual({ stuck: false });
  });

  it('is not stuck for anything but a completed swap', () => {
    const failedSwap = { ...swap(), status: ITransactionStatus.Failed } as ITransaction;
    expect(paybackClaimStateFrom(failedSwap, [claim('a')], open)).toEqual({ stuck: false });
    expect(paybackClaimStateFrom({ ...swap(), type: 'send' } as ITransaction, [claim('a')], open)).toEqual({
      stuck: false
    });
  });

  it('ignores consume rows linked to another order', () => {
    expect(paybackClaimStateFrom(swap(), [claim('other', {}, 'settle', 'swap-2')], open)).toEqual({ stuck: false });
  });
});

describe('getPaybackClaimStates', () => {
  const rows: ITransaction[] = [];
  const anyOfCalls: Array<[string, string[]]> = [];
  beforeEach(() => {
    rows.length = 0;
    anyOfCalls.length = 0;
    jest.mocked(Repo.transactions.where).mockImplementation(((index: string) => ({
      anyOf: (values: string[]) => {
        anyOfCalls.push([index, values]);
        const matches = (row: ITransaction) => {
          if (index === 'extraInputs.swapOrderTxId') return values.includes(row.extraInputs?.swapOrderTxId);
          if (index === 'noteId') return row.noteId !== undefined && values.includes(row.noteId);
          return (row.noteIds ?? []).some(noteId => values.includes(noteId));
        };
        return { toArray: async () => rows.filter(matches) };
      }
    })) as unknown as typeof Repo.transactions.where);
  });

  it('resolves several swaps with one linked-claim query (F-003)', async () => {
    rows.push(
      claim('a-failed', {}, 'settle', 'swap-a'),
      claim('b-failed', {}, 'settle', 'swap-b'),
      claim('b-claimed', { status: ITransactionStatus.Completed, noteIds: ['b-failed-note'], extraInputs: {} })
    );
    const states = await getPaybackClaimStates([swap({}, 'swap-a'), swap({}, 'swap-b'), swap({}, 'swap-c')]);

    expect(states.get('swap-a')).toEqual({ stuck: true, failedClaimId: 'a-failed', reason: 'other' });
    expect(states.get('swap-b')).toEqual({ stuck: false });
    expect(states.get('swap-c')).toEqual({ stuck: false });
    expect(anyOfCalls.filter(([index]) => index === 'extraInputs.swapOrderTxId')).toEqual([
      ['extraInputs.swapOrderTxId', ['swap-a', 'swap-b', 'swap-c']]
    ]);
  });

  it('counts an untagged live consume of the same account as holding the note, and another account as not', async () => {
    rows.push(
      claim('failed'),
      claim('held', { status: ITransactionStatus.Queued, noteIds: ['failed-note'], extraInputs: {} }),
      claim('other-account', {
        status: ITransactionStatus.Completed,
        accountId: 'someone-else',
        noteIds: ['failed-note'],
        extraInputs: {}
      })
    );
    expect(await getPaybackClaimState(swap())).toEqual({ stuck: false });

    rows.splice(1, 1);
    expect(await getPaybackClaimState(swap())).toEqual({ stuck: true, failedClaimId: 'failed', reason: 'other' });
  });

  it('makes no query without a completed swap', async () => {
    expect((await getPaybackClaimStates([{ ...swap(), status: ITransactionStatus.Failed } as ITransaction])).size).toBe(
      0
    );
    expect(anyOfCalls).toEqual([]);
  });
});

describe('classifyPaybackClaimFailure', () => {
  it('names a fee shortfall', () => {
    expect(classifyPaybackClaimFailure(claim('a', { rawError: 'the fee asset in the vault is insufficient 0x12ab' }))).toBe(
      'fee'
    );
  });

  it('names a Guardian refusal', () => {
    expect(classifyPaybackClaimFailure(claim('a', { rawError: 'guardian returned 401 authentication_failed' }))).toBe(
      'guardian'
    );
    expect(
      classifyPaybackClaimFailure(
        claim('a', {
          failureDiagnostics: { authPreparation: 'unknown', authLayout: 'unknown', commitmentMatch: 'unknown' }
        } as unknown as Partial<ITransaction>)
      )
    ).toBe('guardian');
  });

  it('names a transport failure', () => {
    expect(classifyPaybackClaimFailure(claim('a', { rawError: 'transport error: status code 503' }))).toBe('network');
  });

  it('falls back to other', () => {
    expect(classifyPaybackClaimFailure(claim('a', { error: 'note script failed 0xdeadbeef' }))).toBe('other');
  });
});
