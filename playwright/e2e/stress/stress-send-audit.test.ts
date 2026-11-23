import type { StressOpRecord } from './stress-driver';
import { auditStressSends, evaluateStressSendAudit } from './stress-send-audit';
import { TxStatus } from '../helpers/history';

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

test('classifies Completed rows missing transactionId and unexpected statuses as unlinked while preserving duplicates', () => {
  const audit = auditStressSends(
    [
      { ...op, idx: 1, rowId: 'no-tx-id' },
      { ...op, idx: 2, rowId: 'empty-tx-id' },
      { ...op, idx: 3, rowId: 'weird-status' },
      { ...op, idx: 4, rowId: 'no-tx-id' }
    ],
    {
      A: [
        { id: 'no-tx-id', type: 'send', status: TxStatus.Completed },
        { id: 'empty-tx-id', type: 'send', status: TxStatus.Completed, transactionId: '   ' },
        { id: 'weird-status', type: 'send', status: 99 }
      ],
      B: []
    }
  );

  expect(audit.confirmedPrimary).toBe(0);
  expect(audit.links.map(link => link.outcome)).toEqual(['unlinked', 'unlinked', 'unlinked', 'duplicate']);

  const evaluation = evaluateStressSendAudit(audit, { conservationStrict: false, maxFailedSendRate: 1 });
  expect(evaluation.ok).toBe(false);
  expect(evaluation.pendingLinks).toEqual([]);
  expect(evaluation.unlinkedLinks).toHaveLength(3);
  expect(evaluation.duplicateLinks).toHaveLength(1);
});

test('allows Guardian-mode TxStatus.Failed primary sends within maxFailedSendRate and rejects excess', () => {
  const operations: StressOpRecord[] = Array.from({ length: 20 }, (_, index) => ({
    ...op,
    idx: index + 1,
    rowId: `row-${index + 1}`
  }));
  const rowsA = operations.map((item, index) => ({
    id: `row-${item.idx}`,
    type: 'send',
    status: index === 0 ? TxStatus.Failed : TxStatus.Completed,
    transactionId: index === 0 ? undefined : `tx-${item.idx}`
  }));

  const audit = auditStressSends(operations, { A: rowsA, B: [] });
  expect(audit.confirmedPrimary).toBe(19);

  const guardianEval = evaluateStressSendAudit(audit, { conservationStrict: true, maxFailedSendRate: 0.05 });
  expect(guardianEval.ok).toBe(true);
  expect(guardianEval.failedAcceptedRate).toBe(0.05);
  expect(guardianEval.expectedConfirmedPrimary).toBe(19);
  expect(guardianEval.violations).toEqual([]);

  const strictEval = evaluateStressSendAudit(audit, { conservationStrict: true, maxFailedSendRate: 0 });
  expect(strictEval.ok).toBe(false);
  expect(strictEval.expectedConfirmedPrimary).toBe(20);
});

test('tolerates pending sends only when conservationStrict is false', () => {
  const audit = auditStressSends(
    [
      { ...op, idx: 1, rowId: 'done' },
      { ...op, idx: 2, rowId: 'in-flight' }
    ],
    {
      A: [
        { id: 'done', type: 'send', status: TxStatus.Completed, transactionId: 'tx-done' },
        { id: 'in-flight', type: 'send', status: TxStatus.Unconfirmed }
      ],
      B: []
    }
  );

  expect(audit.confirmedPrimary).toBe(1);

  const degradedEval = evaluateStressSendAudit(audit, { conservationStrict: false, maxFailedSendRate: 0 });
  expect(degradedEval.ok).toBe(true);
  expect(degradedEval.disallowedPendingLinks).toEqual([]);
  expect(degradedEval.expectedConfirmedPrimary).toBe(1);

  const strictEval = evaluateStressSendAudit(audit, { conservationStrict: true, maxFailedSendRate: 0 });
  expect(strictEval.ok).toBe(false);
  expect(strictEval.disallowedPendingLinks).toHaveLength(1);
  expect(strictEval.expectedConfirmedPrimary).toBe(2);
});

test('rejects unlinked or duplicate concurrent secondary sends and counts confirmed secondary legs', () => {
  const missingSecondary = auditStressSends(
    [{ ...op, idx: 1, rowId: 'p1', concurrent: true, secondaryStatus: 'ok', secondaryRowId: 'missing-sec' }],
    {
      A: [{ id: 'p1', type: 'send', status: TxStatus.Completed, transactionId: 'tx-p1' }],
      B: []
    }
  );
  const missingEval = evaluateStressSendAudit(missingSecondary, { conservationStrict: true, maxFailedSendRate: 0 });
  expect(missingEval.ok).toBe(false);
  expect(missingEval.unlinkedLinks).toHaveLength(1);
  expect(missingEval.expectedConfirmedSecondary).toBe(1);
  expect(missingSecondary.confirmedSecondary).toBe(0);

  const duplicateSecondary = auditStressSends(
    [{ ...op, idx: 1, rowId: 'p1', concurrent: true, secondaryStatus: 'ok', secondaryRowId: 's1' }],
    {
      A: [{ id: 'p1', type: 'send', status: TxStatus.Completed, transactionId: 'shared-tx' }],
      B: [{ id: 's1', type: 'send', status: TxStatus.Completed, transactionId: 'shared-tx' }]
    }
  );
  const dupEval = evaluateStressSendAudit(duplicateSecondary, { conservationStrict: true, maxFailedSendRate: 0 });
  expect(dupEval.ok).toBe(false);
  expect(dupEval.duplicateLinks).toHaveLength(1);
  expect(dupEval.expectedConfirmedSecondary).toBe(1);
  expect(duplicateSecondary.confirmedSecondary).toBe(0);

  const failedPrimaryWithAcceptedSecondary: StressOpRecord = {
    ...op,
    idx: 20,
    status: 'fail',
    concurrent: true,
    secondaryStatus: 'ok',
    secondaryRowId: 's-fail'
  };
  const validWithGuardianSecondaryFailure = auditStressSends(
    [
      ...Array.from({ length: 19 }, (_, index) => ({
        ...op,
        idx: index + 1,
        rowId: `p-${index + 1}`
      })),
      failedPrimaryWithAcceptedSecondary
    ],
    {
      A: Array.from({ length: 19 }, (_, index) => ({
        id: `p-${index + 1}`,
        type: 'send',
        status: TxStatus.Completed,
        transactionId: `tx-p-${index + 1}`
      })),
      B: [{ id: 's-fail', type: 'send', status: TxStatus.Failed }]
    }
  );
  const guardianSecondaryEval = evaluateStressSendAudit(validWithGuardianSecondaryFailure, {
    conservationStrict: true,
    maxFailedSendRate: 0.05
  });
  expect(guardianSecondaryEval.ok).toBe(true);
  expect(validWithGuardianSecondaryFailure.confirmedPrimary).toBe(19);
  expect(validWithGuardianSecondaryFailure.confirmedSecondary).toBe(0);
});
