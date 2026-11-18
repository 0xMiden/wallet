import { TxStatus } from '../helpers/history';
import type { StressOpRecord } from './stress-driver';
import { auditStressSends } from './stress-send-audit';

const op: StressOpRecord = {
  idx: 1,
  sender: 'A',
  receiver: 'B',
  amount: 1,
  isPrivate: true,
  sendMs: 1,
  status: 'ok'
};

test('only counts an accepted attempt linked to its uniquely completed send', () => {
  const audit = auditStressSends(
    [
      { ...op, rowId: 'sent', secondaryRowId: 'secondary', secondaryStatus: 'ok' },
      { ...op, idx: 2, status: 'fail', rowId: 'late' },
      { ...op, idx: 3, rowId: 'sent' },
      { ...op, idx: 4, rowId: 'queued' },
      { ...op, idx: 5 },
      { ...op, idx: 6, rowId: 'claim' }
    ],
    {
      A: [
        { id: 'sent', type: 'send', status: TxStatus.Completed, transactionId: 'tx1' },
        { id: 'late', type: 'send', status: TxStatus.Completed, transactionId: 'tx2' },
        { id: 'queued', type: 'send', status: TxStatus.Queued },
        { id: 'claim', type: 'consume', status: TxStatus.Completed, transactionId: 'tx3' }
      ],
      B: [{ id: 'secondary', type: 'send', status: TxStatus.Completed, transactionId: 'tx4' }]
    }
  );
  expect(audit.confirmedPrimary).toBe(1);
  expect(audit.confirmedSecondary).toBe(1);
  expect(audit.links.map(link => link.outcome)).toEqual([
    'completed',
    'completed',
    'completed',
    'duplicate',
    'pending',
    'unlinked',
    'unlinked'
  ]);
});
