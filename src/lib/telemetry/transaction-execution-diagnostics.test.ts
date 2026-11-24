import {
  annotateTransactionExecution,
  EXECUTION_DIAGNOSTIC_KEYS,
  snapshotTransactionExecution,
  unobservedTransactionExecution,
  validateTransactionExecutionDiagnostics
} from './transaction-execution-diagnostics';

const observed = {
  executionRoute: 'ordinary_new_transaction',
  authObservation: 'observed',
  authArgPresence: 'present',
  authLayout: 'fee',
  commitmentMatch: 'fee',
  accountAuthCode: 'unavailable'
};

it('copies the complete finite payload and drops every extra property without reading it', () => {
  expect(
    validateTransactionExecutionDiagnostics({
      ...observed,
      get rawRequest() {
        throw new Error('private request');
      },
      rawHash: '0xabcdef',
      cause: new Error('private account and amount')
    })
  ).toEqual(observed);
});

it.each(EXECUTION_DIAGNOSTIC_KEYS)('rejects unknown or unreadable %s without partial facts', key => {
  expect(validateTransactionExecutionDiagnostics({ ...observed, [key]: 'private 0xabcdef 123456' })).toBeUndefined();
  const payload = { ...observed };
  Object.defineProperty(payload, key, {
    get: () => {
      throw new Error('private getter');
    }
  });
  expect(validateTransactionExecutionDiagnostics(payload)).toBeUndefined();
});

it.each([null, undefined, 'observed', [], {}, { executionRoute: 'ordinary_new_transaction' }])(
  'rejects incomplete or nonrecord payload %j',
  payload => {
    expect(validateTransactionExecutionDiagnostics(payload)).toBeUndefined();
  }
);

it('replaces stale observations on a reused root and clears invalid payloads', () => {
  const original = Object.freeze(new Error('private original failure'));
  annotateTransactionExecution(original, observed);
  expect(snapshotTransactionExecution(original)).toEqual(observed);
  const next = unobservedTransactionExecution('guardian_signed_request');
  annotateTransactionExecution(original, next);
  expect(snapshotTransactionExecution(original)).toEqual(next);
  annotateTransactionExecution(original, { ...observed, authArgPresence: 'wrong' });
  expect(snapshotTransactionExecution(original)).toBeUndefined();
});

it('never infers current facts from a cause and returns independent snapshots', () => {
  const original = new Error('original');
  annotateTransactionExecution(original, observed);
  expect(snapshotTransactionExecution(new Error('next attempt', { cause: original }))).toBeUndefined();
  const snapshot = snapshotTransactionExecution(original);
  if (!snapshot) throw new Error('missing snapshot');
  snapshot.authLayout = 'other';
  expect(snapshotTransactionExecution(original)).toEqual(observed);
  annotateTransactionExecution('primitive rejection', observed);
  expect(snapshotTransactionExecution('primitive rejection')).toBeUndefined();
});

it('rejects contradictory observations rather than inventing a route or auth state', () => {
  expect(validateTransactionExecutionDiagnostics({ ...observed, authObservation: 'not_reached' })).toBeUndefined();
  expect(validateTransactionExecutionDiagnostics({ ...observed, authArgPresence: 'absent' })).toBeUndefined();
  expect(validateTransactionExecutionDiagnostics({ ...observed, authLayout: 'absent' })).toBeUndefined();
});
