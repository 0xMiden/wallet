import {
  WasmClientPoisonedError,
  isSyncWatchdogEviction,
  isWasmClientPoisonedError
} from 'lib/miden/sdk/wasm-client-poison';

import {
  DEFAULT_ERROR_MESSAGE,
  deserializeError,
  deserializeInternalError,
  IntercomError,
  serializeError,
  serializeInternalError
} from './helpers';

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

  describe('the wallet-internal envelope', () => {
    // Both classifiers, on the rebuilt error, because they read DIFFERENT fields
    // and the difference is the whole reason the envelope grew: the name decides
    // whether the pass stops taking holds, the reason decides whether the node is
    // recorded as parked. Carrying only the name left the second one
    // unconditionally false for every error that crossed this port, so a backend
    // eviction could not feed the sync fuse at all.
    it.each([
      ['watchdog', true],
      ['realm-error', false]
    ] as const)('carries a %s eviction so both classifiers still answer', (reason, parked) => {
      const original = new WasmClientPoisonedError(reason);
      const revived = deserializeInternalError(serializeInternalError(original));

      expect(isWasmClientPoisonedError(revived)).toBe(true);
      expect(isSyncWatchdogEviction(revived)).toBe(parked);
      expect(revived.message).toBe(original.message);
    });

    // An ARRAY, tested as an array: an object envelope round-trips just as well
    // through the current pair and fails only against the OLD deserializer,
    // which is the one hop this shape exists to survive.
    it('degrades to message and errors under the previous deserializer', () => {
      const wire = serializeInternalError(new WasmClientPoisonedError('watchdog'));
      const legacy = deserializeError(wire);

      expect(legacy.message).toBe(new WasmClientPoisonedError('watchdog').message);
      expect(legacy.message).not.toContain('[object Object]');
    });

    // The other direction of the same skew — a client updated ahead of its
    // server — which turns every backend error into the default message if the
    // shorter legacy array is not recognised.
    it('reads the legacy two-element array from an older server', () => {
      const revived = deserializeInternalError(['bad', ['x']]);

      expect(revived.message).toBe('bad');
      expect(revived.errors).toEqual(['x']);
      expect(isWasmClientPoisonedError(revived)).toBe(false);
    });

    it('falls back to the default message when the envelope carries no string', () => {
      expect(deserializeInternalError([undefined, undefined, undefined, undefined]).message).toBe(
        DEFAULT_ERROR_MESSAGE
      );
      expect(serializeInternalError(undefined)[0]).toBe(DEFAULT_ERROR_MESSAGE);
    });

    // An ordinary error must not come back looking evicted — the classifiers are
    // only useful if they can say no.
    it('leaves an ordinary error unclassified', () => {
      const revived = deserializeInternalError(serializeInternalError(new Error('boom')));

      expect(revived.message).toBe('boom');
      expect(isWasmClientPoisonedError(revived)).toBe(false);
      expect(isSyncWatchdogEviction(revived)).toBe(false);
    });
  });
});
