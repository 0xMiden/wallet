import { classifyReapStartRelation } from './reap-start-diagnostics';
it.each([
  [9, 10, 'before_realm_cutoff'],
  [10, 10, 'at_or_after_realm_cutoff'],
  [11, 10, 'at_or_after_realm_cutoff']
])('classifies %s against %s only numerically', (start, cutoff, expected) =>
  expect(classifyReapStartRelation(start, cutoff)).toBe(expected)
);
it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', {}, true])(
  'does not coerce invalid timestamps %s',
  value => {
    expect(classifyReapStartRelation(value, 10)).toBe('unavailable');
    expect(classifyReapStartRelation(10, value)).toBe('unavailable');
  }
);
it('never calls a coercion getter', () => {
  const read = jest.fn();
  const value = {
    get valueOf() {
      read();
      return () => 1;
    }
  };
  expect(classifyReapStartRelation(value, 10)).toBe('unavailable');
  expect(read).not.toHaveBeenCalled();
});
