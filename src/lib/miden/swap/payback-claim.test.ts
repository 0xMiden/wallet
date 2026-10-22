import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { USER_CANCELLED_TRANSACTION_REASON } from 'lib/miden/transaction/constants';

import { classifyPaybackClaimFailure, paybackClaimStateFrom } from './payback-claim';

const swap = (extraInputs: Record<string, unknown> = {}): ITransaction =>
  ({
    id: 'swap-1',
    type: 'swap',
    status: ITransactionStatus.Completed,
    accountId: 'acct',
    initiatedAt: 100,
    extraInputs: { orderId: '7', expiresAt: 200, ...extraInputs }
  }) as unknown as ITransaction;

const claim = (id: string, overrides: Partial<ITransaction> = {}, kind: 'settle' | 'reclaim' = 'settle'): ITransaction =>
  ({
    id,
    type: 'consume',
    status: ITransactionStatus.Failed,
    accountId: 'acct',
    initiatedAt: 110,
    error: 'Transaction failed',
    extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: kind },
    ...overrides
  }) as unknown as ITransaction;

describe('paybackClaimStateFrom', () => {
  it('reports the latest failed payback claim as stuck', () => {
    const state = paybackClaimStateFrom(swap(), [
      claim('old', { initiatedAt: 105 }),
      claim('latest', { initiatedAt: 120, rawError: 'Failed to fetch' })
    ]);
    expect(state).toEqual({ stuck: true, failedClaimId: 'latest', reason: 'network' });
  });

  it('is not stuck once the order is settled', () => {
    expect(paybackClaimStateFrom(swap({ settledAt: 130 }), [claim('a')])).toEqual({ stuck: false });
  });

  it('is not stuck while a payback claim is queued, running or awaiting its verdict', () => {
    for (const status of [
      ITransactionStatus.Queued,
      ITransactionStatus.GeneratingTransaction,
      ITransactionStatus.Unconfirmed
    ]) {
      expect(paybackClaimStateFrom(swap(), [claim('failed'), claim('live', { status, initiatedAt: 90 })])).toEqual({
        stuck: false
      });
    }
  });

  it('is not stuck when the latest payback claim completed', () => {
    expect(
      paybackClaimStateFrom(swap(), [
        claim('failed', { initiatedAt: 105 }),
        claim('done', { status: ITransactionStatus.Completed, initiatedAt: 120 })
      ])
    ).toEqual({ stuck: false });
  });

  it('ignores reclaim rows, cancelled claims and claims restored from a backup', () => {
    expect(
      paybackClaimStateFrom(swap(), [
        claim('reclaim', {}, 'reclaim'),
        claim('cancelled', { error: USER_CANCELLED_TRANSACTION_REASON }),
        claim('restored', { restoredFromBackup: true })
      ])
    ).toEqual({ stuck: false });
  });

  it('is not stuck for anything but a completed swap', () => {
    const failedSwap = { ...swap(), status: ITransactionStatus.Failed } as ITransaction;
    expect(paybackClaimStateFrom(failedSwap, [claim('a')])).toEqual({ stuck: false });
    expect(paybackClaimStateFrom({ ...swap(), type: 'send' } as ITransaction, [claim('a')])).toEqual({ stuck: false });
  });

  it('ignores consume rows linked to another order', () => {
    const other = claim('other', { extraInputs: { swapOrderTxId: 'swap-2', swapSettleKind: 'settle' } });
    expect(paybackClaimStateFrom(swap(), [other])).toEqual({ stuck: false });
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
