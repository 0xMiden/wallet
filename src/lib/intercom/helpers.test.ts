import { DEFAULT_ERROR_MESSAGE, deserializeError, IntercomError, serializeError } from './helpers';

describe('intercom helpers', () => {
  it('serializes plain errors and arrays', () => {
    expect(serializeError(new Error('boom'))).toBe('boom');
    expect(serializeError({})).toBe(DEFAULT_ERROR_MESSAGE);
    expect(serializeError({ message: 'bad', errors: ['x'] })).toEqual(['bad', ['x']]);
  });

  it('deserializes into IntercomError', () => {
    const err1 = deserializeError('oops');
    expect(err1).toBeInstanceOf(IntercomError);
    expect(err1.message).toBe('oops');

    const err2 = deserializeError(['oops', ['y']]);
    expect(err2.errors).toEqual(['y']);
  });

  it('produces a REAL Error, so callers can read the reason off it', () => {
    // Every consumer of a rejected intercom request narrows with
    // `e instanceof Error ? e.message : String(e)` (ForgotPassword.tsx:94 and
    // ~25 other sites). While IntercomError only `implements Error` — a
    // compile-time contract TypeScript erases — that test was false and the
    // fallback printed the literal "[object Object]" instead of the reason.
    // On the forgot-password route that string is the ONLY thing a user gets
    // after a failed recovery has already wiped their wallet (#630).
    const err = deserializeError('No Guardian accounts found for this seed');

    expect(err).toBeInstanceOf(Error);
    // The consumer expression itself, verbatim — this is what the screens run.
    expect(err instanceof Error ? err.message : String(err)).toBe('No Guardian accounts found for this seed');
  });
});
