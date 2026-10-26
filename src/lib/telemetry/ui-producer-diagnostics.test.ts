import { annotateCrash, snapshotCrashDiagnostics } from './crash-diagnostics';
import {
  annotateUiProducer,
  snapshotUiProducer,
  validateUiEvidence,
  annotatePendingRetry,
  snapshotPendingRetry,
  annotateRecipientValidation,
  snapshotRecipientValidation
} from './ui-producer-diagnostics';
const evidence = { kind: 'pending_retry', pendingRetryReason: 'row_missing' } as const;
it('binds the exact reporting root and pair, clearing invalid reused evidence', () => {
  const error = new Error('private');
  annotateCrash(error, { userErrorId: 'raw_pending_activity_retry_failed', userErrorSurface: 'notice' });
  annotateUiProducer(error, 'raw_pending_activity_retry_failed', 'notice', evidence);
  expect(snapshotCrashDiagnostics(error)).toHaveProperty('pendingRetryReason', 'row_missing');
  expect(snapshotCrashDiagnostics(new Error('wrapper', { cause: error }))).not.toHaveProperty('pendingRetryReason');
  expect(
    snapshotUiProducer(new Error('wrapper', { cause: error }), 'raw_pending_activity_retry_failed', 'notice')
  ).toBeUndefined();
  annotateCrash(error, { userErrorId: 'invalidAmount', userErrorSurface: 'field' });
  annotateCrash(error, { userErrorId: 'raw_pending_activity_retry_failed', userErrorSurface: 'notice' });
  expect(snapshotCrashDiagnostics(error)).not.toHaveProperty('pendingRetryReason');
  annotateUiProducer(error, 'raw_pending_activity_retry_failed', 'notice', evidence);
  annotateUiProducer(error, 'raw_pending_activity_retry_failed', 'notice', {
    ...evidence,
    pendingRetryReason: 'private'
  });
  expect(snapshotUiProducer(error, 'raw_pending_activity_retry_failed', 'notice')).toBeUndefined();
});
it('does not invoke getters, coercion, cause or hostile descriptor traps outside containment', () => {
  const getter = jest.fn(() => 'pending_retry');
  const values = [
    Object.defineProperty({}, 'kind', { get: getter }),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('private');
        }
      }
    ),
    { ...evidence, raw: 'private' },
    null,
    'private'
  ];
  for (const value of values)
    expect(validateUiEvidence('raw_pending_activity_retry_failed', 'notice', value)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
});
it('keeps service and validator roots separate from causes and clears invalid reannotations', () => {
  const error = new Error('private');
  annotatePendingRetry(error, 'guardian_hold');
  annotateRecipientValidation(error, 'decoder_throw');
  expect(snapshotPendingRetry(error)).toBe('guardian_hold');
  expect(snapshotRecipientValidation(error)).toBe('decoder_throw');
  expect(snapshotPendingRetry(new Error('wrapper', { cause: error }))).toBeUndefined();
  annotatePendingRetry(error, 'private');
  annotateRecipientValidation(error, undefined);
  expect(snapshotPendingRetry(error)).toBeUndefined();
  expect(snapshotRecipientValidation(error)).toBeUndefined();
});
