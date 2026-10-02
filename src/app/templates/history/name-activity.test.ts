import { ITransactionStatus } from 'lib/miden/db/types';

import { HistoryEntryType, IHistoryEntry, midenNameActivityOf, reconcileMidenNameActivity } from './IHistoryEntry';

const parent: IHistoryEntry = {
  key: 'register',
  txId: 'register',
  address: 'account',
  timestamp: 1,
  message: 'Registered',
  txType: 'register-name',
  type: HistoryEntryType.CompletedTransaction
};
const receipt: IHistoryEntry = {
  ...parent,
  key: 'receipt',
  txId: 'receipt',
  txType: 'consume',
  midenNameParentTxId: 'register',
  transactionIcon: 'RECEIVE',
  status: ITransactionStatus.Completed
};

describe('name activity reconciliation', () => {
  it('folds only the explicitly linked successful NFA receipt into its parent', () => {
    const unrelated = { ...receipt, key: 'unrelated', midenNameParentTxId: 'another-registration' };
    expect(reconcileMidenNameActivity([receipt, unrelated, parent])).toEqual([unrelated, parent]);
  });

  it('keeps receipts visible when the parent has not loaded, or the receipt failed or is pending', () => {
    expect(reconcileMidenNameActivity([receipt])).toEqual([receipt]);
    const failed: IHistoryEntry = { ...receipt, transactionIcon: 'FAILED' };
    const pending = { ...receipt, type: HistoryEntryType.PendingTransaction };
    expect(reconcileMidenNameActivity([failed, pending, parent])).toEqual([failed, pending, parent]);
  });

  it('links name claims to their registration and tracks completion of the registration', () => {
    expect(
      midenNameActivityOf({
        type: 'consume',
        extraInputs: { midenNameClaim: { label: 'alice', registerTxId: 'register' } }
      })
    ).toEqual({ midenNameParentTxId: 'register' });
    for (const [phase, status] of [
      ['submitted', 'pending'],
      ['owned', 'confirmed'],
      ['failed', 'failed']
    ]) {
      expect(
        midenNameActivityOf({
          type: 'register-name',
          extraInputs: { phase, claimTxId: 'claim' }
        })
      ).toEqual({ midenNameStatus: status, midenNameReceiptTxId: 'claim' });
    }
    expect(midenNameActivityOf({ type: 'send', extraInputs: {} })).toEqual({});
  });
});
