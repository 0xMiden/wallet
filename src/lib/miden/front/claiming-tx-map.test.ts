import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';

import { claimingTxIdByNoteId } from './claiming-tx-map';

const tx = (over: Partial<ITransaction>): ITransaction =>
  ({
    id: 'tx-1',
    type: 'consume',
    status: ITransactionStatus.Queued,
    accountId: 'acct',
    initiatedAt: 0
  }) as unknown as ITransaction as ITransaction & typeof over;

describe('claimingTxIdByNoteId', () => {
  it('maps every note id on a batch consume row to that row', () => {
    const map = claimingTxIdByNoteId([{ ...tx({}), id: 'tx-a', noteIds: ['n1', 'n2'] } as ITransaction]);

    expect(map.get('n1')).toBe('tx-a');
    expect(map.get('n2')).toBe('tx-a');
  });

  it('reads the singular noteId when the row carries no noteIds array', () => {
    const map = claimingTxIdByNoteId([{ ...tx({}), id: 'tx-b', noteId: 'n3' } as ITransaction]);

    expect(map.get('n3')).toBe('tx-b');
  });

  it('ignores rows that are not consumes, so a send never gates a note', () => {
    const map = claimingTxIdByNoteId([
      { ...tx({}), id: 'tx-send', type: 'send', noteIds: ['n4'] } as unknown as ITransaction
    ]);

    expect(map.has('n4')).toBe(false);
  });

  it('keeps the first row for a note id when two rows claim it', () => {
    const map = claimingTxIdByNoteId([
      { ...tx({}), id: 'tx-first', noteIds: ['n5'] } as ITransaction,
      { ...tx({}), id: 'tx-second', noteIds: ['n5'] } as ITransaction
    ]);

    expect(map.get('n5')).toBe('tx-first');
  });

  it('is empty for no rows, so nothing is gated when nothing is in flight', () => {
    expect(claimingTxIdByNoteId([]).size).toBe(0);
  });
});
