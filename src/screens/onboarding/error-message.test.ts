import { GUARDIAN_ACCOUNT_NOT_FOUND } from 'lib/miden/sdk/guardian-recovery-errors';

import { errorToMessage, isGuardianNotFound } from './error-message';

describe('errorToMessage', () => {
  it.each([
    ['an Error with a message', new Error('boom'), 'boom'],
    ['a non-empty string', 'nope', 'nope'],
    ['a structured object', { code: 'registration_failed' }, '{"code":"registration_failed"}'],
    ['a number', 42, '42'],
    ['a boolean', false, 'false']
  ])('returns the text of %s', (_label, error, expected) => {
    expect(errorToMessage(error)).toBe(expected);
  });

  const circular: { self?: unknown } = {};
  circular.self = circular;

  // Callers show translated fallback copy for these, so none may produce text of its own.
  it.each([
    ['an Error without a message', new Error('')],
    ['an empty string', ''],
    ['an empty object', {}],
    ['an object JSON cannot serialize', circular],
    ['null', null],
    ['undefined', undefined]
  ])('returns undefined for %s', (_label, error) => {
    expect(errorToMessage(error)).toBeUndefined();
  });
});

describe('isGuardianNotFound', () => {
  it('is true for an error carrying the not-found code', () => {
    expect(isGuardianNotFound({ code: GUARDIAN_ACCOUNT_NOT_FOUND })).toBe(true);
  });

  it.each([
    ['an error with a different code', { code: 'TIMEOUT' }],
    ['an Error with no code', new Error('This key is no longer active for the account.')],
    ['a string', 'guardian not found'],
    ['null', null],
    ['undefined', undefined]
  ])('is false for %s', (_label, error) => {
    expect(isGuardianNotFound(error)).toBe(false);
  });
});
