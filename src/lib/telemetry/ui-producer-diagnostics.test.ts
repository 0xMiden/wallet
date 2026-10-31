import { annotateCrash, snapshotCrashDiagnostics } from './crash-diagnostics';
import { SUBMIT_ENDPOINTS, SUBMIT_GRPC_STATUSES } from './transaction-failure';
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

it('accepts only closed endpoint and gRPC status evidence for the network rejection notice', () => {
  const evidence = {
    kind: 'submission_rejected',
    submissionRejectedEndpoint: 'submit_proven_transaction',
    submissionRejectedStatus: 'invalid_argument'
  } as const;
  const root = new Error(
    'private account mtst1private transaction 0x1234567890abcdef amount 4200 host private.example'
  );
  annotateCrash(root, { userErrorId: 'submissionRejectedByNetwork', userErrorSurface: 'notice' });
  annotateUiProducer(root, 'submissionRejectedByNetwork', 'notice', evidence);

  expect(snapshotCrashDiagnostics(root)).toEqual({
    userErrorId: 'submissionRejectedByNetwork',
    userErrorSurface: 'notice',
    submissionRejectedEndpoint: 'submit_proven_transaction',
    submissionRejectedStatus: 'invalid_argument'
  });
  expect(validateUiEvidence('submissionRejectedByNetwork', 'notice', evidence)).toEqual(evidence);
  expect(validateUiEvidence('submissionUnanswered', 'status_screen', evidence)).toBeUndefined();
  expect(
    validateUiEvidence('submissionRejectedByNetwork', 'notice', {
      ...evidence,
      submissionRejectedEndpoint: 'https://private.example/rpc'
    })
  ).toBeUndefined();
  expect(validateUiEvidence('submissionRejectedByNetwork', 'notice', { ...evidence, raw: 'private' })).toBeUndefined();
  expect(SUBMIT_ENDPOINTS).toContain(evidence.submissionRejectedEndpoint);
  expect(SUBMIT_GRPC_STATUSES).toContain(evidence.submissionRejectedStatus);
  expect(JSON.stringify(snapshotCrashDiagnostics(root))).not.toMatch(
    /mtst1private|1234567890abcdef|4200|private\.example/
  );
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

it.each(['declared_network', 'genesis_header'])('retains only the exact backup %s producer category', stage => {
  const value = { kind: 'backup_network_failure', backupNetworkFailureStage: stage };
  const root = new Error('private account 0x1234 password amount 123.45');
  annotateCrash(root, { userErrorId: 'encryptedWalletFileWrongNetwork', userErrorSurface: 'field' });
  annotateUiProducer(root, 'encryptedWalletFileWrongNetwork', 'field', value);
  expect(snapshotCrashDiagnostics(root)).toEqual({
    userErrorId: 'encryptedWalletFileWrongNetwork',
    userErrorSurface: 'field',
    backupNetworkFailureStage: stage
  });
  expect(
    snapshotUiProducer(new Error('wrapper', { cause: root }), 'encryptedWalletFileWrongNetwork', 'field')
  ).toBeUndefined();
});

it('refuses private, inherited, accessor and trapped backup evidence and clears reused roots', () => {
  const canary = 'private-file-network-genesis-password-identifier';
  const valid = { kind: 'backup_network_failure', backupNetworkFailureStage: 'declared_network' };
  const getter = jest.fn(() => canary);
  const hostile = [
    { ...valid, backupNetworkFailureStage: canary },
    { ...valid, file: canary },
    Object.create(valid),
    Object.defineProperty({ kind: valid.kind }, 'backupNetworkFailureStage', { get: getter }),
    new Proxy(valid, {
      ownKeys() {
        throw new Error(canary);
      }
    })
  ];
  const root = new Error(canary);
  for (const value of hostile) {
    annotateUiProducer(root, 'encryptedWalletFileWrongNetwork', 'field', valid);
    annotateUiProducer(root, 'encryptedWalletFileWrongNetwork', 'field', value);
    expect(snapshotUiProducer(root, 'encryptedWalletFileWrongNetwork', 'field')).toBeUndefined();
  }
  for (const [id, surface] of [
    ['encryptedWalletFileMalformed', 'field'],
    ['encryptedWalletFileWrongNetwork', 'inline'],
    ['encryptedWalletFileWrongNetwork', 'notice']
  ])
    expect(validateUiEvidence(id, surface, valid)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  annotateUiProducer(root, 'encryptedWalletFileWrongNetwork', 'field', valid);
  expect(snapshotUiProducer(root, 'encryptedWalletFileWrongNetwork', 'inline')).toBeUndefined();
  annotateCrash(root, { userErrorId: 'encryptedWalletFileMalformed', userErrorSurface: 'field' });
  annotateCrash(root, { userErrorId: 'encryptedWalletFileWrongNetwork', userErrorSurface: 'field' });
  expect(snapshotCrashDiagnostics(root)).not.toHaveProperty('backupNetworkFailureStage');
  expect(JSON.stringify(snapshotCrashDiagnostics(root))).not.toContain(canary);
});
