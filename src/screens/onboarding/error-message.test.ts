import { errorToMessage } from './error-message';

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
