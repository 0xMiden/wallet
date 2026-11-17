import { heldReviewFailureFlags } from './held-review-failure';

const cases: [string, keyof ReturnType<typeof heldReviewFailureFlags>][] = [
  ['Test timeout of 600000ms exceeded.', 'testTimeout'],
  ['locator.waitFor: Timeout 30000ms exceeded.', 'locatorTimeout'],
  ['page.waitForResponse: Timeout 120000ms exceeded.', 'responseTimeout'],
  ['expect(locator).toBeVisible()', 'expectation'],
  ['AssertionError: values differ', 'assertion'],
  ['Target page, context or browser has been closed', 'browserClosed'],
  ['strict mode violation: locator resolved twice', 'strictLocator']
];

test.each(cases)('classifies a fixed public failure indicator: %s', (message, flag) => {
  expect(heldReviewFailureFlags(message)[flag]).toBe(true);
});

test('exports booleans only and never the private message or arbitrary fields', () => {
  const marker = 'synthetic-private-message';
  const flags = heldReviewFailureFlags(marker);
  expect(Object.keys(flags)).toEqual([
    'testTimeout',
    'locatorTimeout',
    'responseTimeout',
    'expectation',
    'assertion',
    'browserClosed',
    'strictLocator'
  ]);
  expect(Object.values(flags).every(value => value === false)).toBe(true);
  expect(JSON.stringify(flags)).not.toContain(marker);
});
