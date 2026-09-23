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

  it('links publication returns and tracks completion of the full publication', () => {
    expect(
      midenNameActivityOf({
        type: 'consume',
        extraInputs: { midenNameReturn: { label: 'alice', publishTxId: 'publish' } }
      })
    ).toEqual({ midenNameParentTxId: 'publish' });
    for (const [phase, status] of [
      ['returning', 'pending'],
      ['done', 'confirmed'],
      ['failed', 'failed']
    ]) {
      expect(
        midenNameActivityOf({
          type: 'publish-name-record',
          extraInputs: { phase, returnTxId: 'return' }
        })
      ).toEqual({ midenNameStatus: status, midenNameReceiptTxId: 'return' });
    }
  });
});
