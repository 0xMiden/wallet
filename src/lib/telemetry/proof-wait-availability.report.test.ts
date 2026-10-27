import { captureCrash } from './crash';
import { annotateCrash, snapshotCrashDiagnostics } from './crash-diagnostics';
import { annotateProofWaitAvailability, PROOF_WAIT_AVAILABILITIES } from './proof-wait-availability-diagnostics';
import { reportTransactionFailure, type TransactionFailure } from './transaction-failure';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));
const input = (overrides: Partial<TransactionFailure> = {}): TransactionFailure => ({
  type: 'consume',
  point: 'node_verdict',
  reason: 'never_committed',
  neverCommittedRule: 'expired',
  proofWaitBlocks: 3,
  expiryWindowBlocks: 600,
  error: 'shared-never-committed-string',
  ...overrides
});
const reported = () => jest.mocked(captureCrash).mock.calls[0]?.[0];
beforeEach(() => jest.clearAllMocks());
it.each(PROOF_WAIT_AVAILABILITIES)(
  'transfers only trusted input-root %s without changing the closed message',
  availability => {
    const failure = input();
    reportTransactionFailure(failure);
    const original = reported();
    jest.clearAllMocks();
    annotateProofWaitAvailability(failure, availability);
    reportTransactionFailure(failure);
    expect(captureCrash).toHaveBeenCalledTimes(1);
    expect(reported()).toMatchObject({ message: original instanceof Error ? original.message : undefined });
    expect(snapshotCrashDiagnostics(reported())).toHaveProperty('proofWaitAvailability', availability);
  }
);
it.each<Partial<TransactionFailure>>([
  { point: undefined },
  { point: 'pipeline' },
  { point: 'guardian_node_verdict' },
  { reason: undefined },
  { reason: 'user_cancelled' },
  { reason: 'queued_expired' },
  { neverCommittedRule: undefined },
  { neverCommittedRule: 'superseded' },
  { neverCommittedRule: 'spent_elsewhere' },
  { neverCommittedRule: 'mixed' }
])('omits availability after an effective scope override %p', overrides => {
  const failure = input(overrides);
  annotateProofWaitAvailability(failure, 'available');
  reportTransactionFailure(failure);
  expect(captureCrash).toHaveBeenCalledTimes(1);
  expect(snapshotCrashDiagnostics(reported())).not.toHaveProperty('proofWaitAvailability');
});
it('ignores causes, prior errors, generic annotations and structurally copied canonical fields', () => {
  const source = new Error('private cause');
  annotateProofWaitAvailability(source, 'available');
  const error = Object.assign(new Error('private wrapper', { cause: source }), { proofWaitAvailability: 'available' });
  expect(snapshotCrashDiagnostics(error)).not.toHaveProperty('proofWaitAvailability');
  annotateCrash(error, { proofWaitAvailability: 'available' });
  const failure = Object.assign(input({ error, priorError: source }), { proofWaitAvailability: 'available' });
  Object.defineProperty(failure, 'diagnostics', { value: { proofWaitAvailability: 'available' } });
  reportTransactionFailure(failure);
  expect(snapshotCrashDiagnostics(reported())).not.toHaveProperty('proofWaitAvailability');
  jest.clearAllMocks();
  reportTransactionFailure(input({ error: source }));
  expect(snapshotCrashDiagnostics(reported())).not.toHaveProperty('proofWaitAvailability');
});
it('does not carry an older input observation through changed scope or invalid reuse', () => {
  const failure = input();
  annotateProofWaitAvailability(failure, 'available');
  reportTransactionFailure(failure);
  expect(snapshotCrashDiagnostics(reported())).toHaveProperty('proofWaitAvailability', 'available');
  jest.clearAllMocks();
  failure.reason = 'user_cancelled';
  reportTransactionFailure(failure);
  expect(snapshotCrashDiagnostics(reported())).not.toHaveProperty('proofWaitAvailability');
  jest.clearAllMocks();
  failure.reason = 'never_committed';
  annotateProofWaitAvailability(failure, 'private-invalid');
  reportTransactionFailure(failure);
  expect(snapshotCrashDiagnostics(reported())).not.toHaveProperty('proofWaitAvailability');
});

it.each([true, false])('uses the rendered rule without adding getter reads (expired=%s)', expired => {
  const failure = input();
  let pointReads = 0,
    reasonReads = 0,
    ruleReads = 0;
  Object.defineProperties(failure, {
    point: {
      enumerable: true,
      get() {
        pointReads++;
        return 'node_verdict';
      }
    },
    reason: {
      enumerable: true,
      get() {
        reasonReads++;
        return 'never_committed';
      }
    },
    neverCommittedRule: {
      enumerable: true,
      get() {
        ruleReads++;
        return !expired && ruleReads === 2 ? 'superseded' : 'expired';
      }
    }
  });
  annotateProofWaitAvailability(failure, 'available');
  reportTransactionFailure(failure);
  expect(pointReads).toBe(1);
  expect(reasonReads).toBe(2);
  expect(ruleReads).toBe(4);
  expect(reported()).toMatchObject({ message: expect.stringContaining(expired ? 'rule expired' : 'rule superseded') });
  expect(snapshotCrashDiagnostics(reported()).proofWaitAvailability).toBe(expired ? 'available' : undefined);
});
