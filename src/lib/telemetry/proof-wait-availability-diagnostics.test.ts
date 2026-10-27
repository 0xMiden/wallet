import {
  annotateProofWaitAvailability,
  snapshotProofWaitAvailability,
  validateProofWaitAvailability
} from './proof-wait-availability-diagnostics';

const values = [
  'current_attempt_missing',
  'current_entry_missing',
  'execution_time_invalid',
  'submit_time_invalid',
  'time_order_invalid',
  'reference_block_missing',
  'expiration_block_missing',
  'reference_block_invalid',
  'expiration_block_invalid',
  'expiry_order_invalid',
  'derived_wait_invalid',
  'derived_window_invalid',
  'available'
];
it.each(values)('keeps only trusted root literal %s without structural or cause promotion', value => {
  const root = {};
  annotateProofWaitAvailability(root, value);
  expect(snapshotProofWaitAvailability(root)).toBe(value);
  expect(snapshotProofWaitAvailability({ proofWaitAvailability: value })).toBeUndefined();
  expect(snapshotProofWaitAvailability(new Error('wrapper', { cause: root }))).toBeUndefined();
});
it.each([undefined, null, false, 0, NaN, {}, [], Object('available'), 'future', 'AVAILABLE'])(
  'rejects invalid observation %p and clears a reused root',
  value => {
    const root = {};
    annotateProofWaitAvailability(root, 'available');
    annotateProofWaitAvailability(root, value);
    expect(snapshotProofWaitAvailability(root)).toBeUndefined();
    expect(validateProofWaitAvailability(value)).toBeUndefined();
  }
);
it('does not inspect targets or invoke input getters/coercion', () => {
  const getter = jest.fn(() => {
    throw new Error('private getter');
  });
  const root = Object.defineProperties({}, { cause: { get: getter }, proofWaitAvailability: { get: getter } });
  const hostile = {
    get toString() {
      return getter;
    }
  };
  annotateProofWaitAvailability(root, 'available');
  expect(snapshotProofWaitAvailability(root)).toBe('available');
  annotateProofWaitAvailability(root, hostile);
  expect(snapshotProofWaitAvailability(root)).toBeUndefined();
  for (const target of [undefined, null, false, 1, 'shared-never-committed-error']) {
    annotateProofWaitAvailability(target, 'available');
    expect(snapshotProofWaitAvailability(target)).toBeUndefined();
  }
  expect(getter).not.toHaveBeenCalled();
});
