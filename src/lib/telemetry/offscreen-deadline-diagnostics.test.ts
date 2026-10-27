import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';

import { snapshotCrashDiagnostics } from './crash-diagnostics';
import {
  OFFSCREEN_DEADLINE_METHODS,
  isOwnStartedWriteDeadline,
  annotateOffscreenDeadline,
  snapshotOffscreenDeadline,
  validateOffscreenDeadlineDiagnostics
} from './offscreen-deadline-diagnostics';

it('requires closed own data and replaces reused-root evidence without following causes', () => {
  const payload = { offscreenDeadlineMethod: 'guardianPipeline', offscreenDeadlineStage: 'proving' };
  const error = new Error('private-canary');
  annotateOffscreenDeadline(error, payload);
  expect(snapshotOffscreenDeadline(error)).toEqual(payload);
  expect(snapshotOffscreenDeadline(new Error('wrapper', { cause: error }))).toBeUndefined();
  expect(snapshotOffscreenDeadline(Object.assign(new Error('forged'), payload))).toBeUndefined();
  for (const value of [
    {},
    { ...payload, extra: 'private' },
    Object.create(payload),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('private');
        }
      }
    )
  ]) {
    annotateOffscreenDeadline(error, value);
    expect(snapshotOffscreenDeadline(error)).toBeUndefined();
    expect(validateOffscreenDeadlineDiagnostics(value)).toBeUndefined();
    annotateOffscreenDeadline(error, payload);
  }
  const getter = jest.fn();
  const hostile = Object.defineProperty({}, Object.keys(payload)[0]!, { get: getter });
  expect(validateOffscreenDeadlineDiagnostics(hostile)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  expect(() => annotateOffscreenDeadline('primitive', payload)).not.toThrow();
});

it.each(OFFSCREEN_DEADLINE_METHODS)('validates method %s only with canonical stage', method => {
  expect(
    validateOffscreenDeadlineDiagnostics({ offscreenDeadlineMethod: method, offscreenDeadlineStage: 'submitting' })
  ).toEqual({ offscreenDeadlineMethod: method, offscreenDeadlineStage: 'submitting' });
  expect(
    validateOffscreenDeadlineDiagnostics({ offscreenDeadlineMethod: method, offscreenDeadlineStage: 'private' })
  ).toBeUndefined();
});

it.each([
  ['deadline', true, 'own', 'started', 'write', true],
  ['deadline', true, 'collateral', 'started', 'write', false],
  ['deadline', true, 'own', 'resumed', 'write', false],
  ['deadline', true, 'own', 'backstop', 'write', false],
  ['deadline', true, 'own', 'dispatch', 'write', false],
  ['deadline', false, 'own', 'started', 'write', false],
  ['deadline', true, 'own', 'started', 'read', false],
  ['deadline-no-kill', true, 'own', 'started', 'write', false],
  ['doc-closed', true, 'own', 'started', 'write', false],
  ['transport', true, 'own', 'started', 'write', false]
] as const)(
  'requires exact own started-write eligibility %s %s %s %s %s',
  (reason, started, owner, timer, killer, eligible) => {
    const error = new OperationAbortedError('private-operation', reason, {
      started,
      deadline: { owner, timer, killer }
    });
    annotateOffscreenDeadline(error, { offscreenDeadlineMethod: 'newTransaction', offscreenDeadlineStage: 'proving' });
    expect(isOwnStartedWriteDeadline(error)).toBe(eligible);
    expect(snapshotCrashDiagnostics(error)).toEqual(
      eligible
        ? {
            offscreenDeadlineMethod: 'newTransaction',
            offscreenDeadlineStage: 'proving'
          }
        : {}
    );
  }
);
