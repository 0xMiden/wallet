import {
  GUARDIAN_PROVING_SUBSTEPS,
  annotateGuardianProving,
  snapshotGuardianProving,
  validateGuardianProvingDiagnostics
} from './guardian-proving-diagnostics';

it('requires closed own data and replaces reused-root evidence without following causes', () => {
  const payload = { guardianProvingSubstep: 'prove_local' };
  const error = new Error('private-canary');
  annotateGuardianProving(error, payload);
  expect(snapshotGuardianProving(error)).toEqual(payload);
  expect(snapshotGuardianProving(new Error('wrapper', { cause: error }))).toBeUndefined();
  expect(snapshotGuardianProving(Object.assign(new Error('forged'), payload))).toBeUndefined();
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
    annotateGuardianProving(error, value);
    expect(snapshotGuardianProving(error)).toBeUndefined();
    expect(validateGuardianProvingDiagnostics(value)).toBeUndefined();
    annotateGuardianProving(error, payload);
  }
  const getter = jest.fn();
  const hostile = Object.defineProperty({}, Object.keys(payload)[0]!, { get: getter });
  expect(validateGuardianProvingDiagnostics(hostile)).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  expect(() => annotateGuardianProving('primitive', payload)).not.toThrow();
});

it.each(GUARDIAN_PROVING_SUBSTEPS)('validates substep %s', step =>
  expect(validateGuardianProvingDiagnostics({ guardianProvingSubstep: step })).toEqual({ guardianProvingSubstep: step })
);
