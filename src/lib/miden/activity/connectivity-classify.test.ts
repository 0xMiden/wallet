import {
  classifySyncError,
  isDefinitelyOffline,
  isLikelyNetworkError,
  isPermanentHttpRejection
} from './connectivity-classify';

describe('isLikelyNetworkError', () => {
  it.each([
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'Load failed',
    'request aborted by user',
    'request was abort',
    'request timed out after 30s',
    'connection refused',
    'transport error: closed stream',
    'rpc error: deadline exceeded',
    'prover responded with status code 502: Bad Gateway',
    'service unavailable 503',
    // 'status code' phrase without a 5xx number — falls past the numeric check
    // to the explicit 'status code' keyword.
    'unexpected status code from the gateway'
  ])('returns true for %p', message => {
    expect(isLikelyNetworkError(new Error(message))).toBe(true);
  });

  it.each([
    'invalid transaction request',
    'note 0xdead has already been consumed',
    'random WASM internal error',
    'something unexpected happened in the prover serializer'
  ])('returns false for %p', message => {
    expect(isLikelyNetworkError(new Error(message))).toBe(false);
  });

  it('handles null/undefined/non-Error values', () => {
    expect(isLikelyNetworkError(null)).toBe(false);
    expect(isLikelyNetworkError(undefined)).toBe(false);
    expect(isLikelyNetworkError('plain string with timeout')).toBe(true);
    expect(isLikelyNetworkError({})).toBe(false);
  });
});

// #788 follow-up (its review's F-235): a permanent HTTP rejection must not be
// allowed to burn the note-import queue's 24h transient budget — ~288 lock-held
// RPC retries — before it dead-letters. The IMPORT path asks this narrower
// question; the banner and the restore fund-loss guard keep the broad
// `isLikelyNetworkError` on purpose (over-inclusion is the safe direction there).
describe('isPermanentHttpRejection', () => {
  it.each([
    // tonic's fallback shape when a gateway answers gRPC-web with a bare HTTP
    // error and no grpc-status trailer — the exact string is in the shipped wasm.
    'grpc-status header missing, mapped from HTTP status code 400',
    'grpc-status header missing, mapped from HTTP status code 401',
    'grpc-status header missing, mapped from HTTP status code 403',
    'grpc-status header missing, mapped from HTTP status code 404',
    'prover responded with status code: 403',
    'unexpected status code 404 from the gateway'
  ])('returns true for %p', message => {
    expect(isPermanentHttpRejection(new Error(message))).toBe(true);
  });

  it.each([
    // Retryable statuses keep their transient verdict.
    'grpc-status header missing, mapped from HTTP status code 408',
    'grpc-status header missing, mapped from HTTP status code 429',
    'prover responded with status code 502: Bad Gateway',
    'grpc-status header missing, mapped from HTTP status code 503',
    // No extractable number → cannot prove permanence; stay transient.
    'unexpected status code from the gateway',
    // Non-HTTP shapes are not this predicate's business at all.
    'Failed to fetch',
    'transport error: closed stream',
    'invalid transaction request'
  ])('returns false for %p', message => {
    expect(isPermanentHttpRejection(new Error(message))).toBe(false);
  });

  it('handles null/undefined/non-Error values', () => {
    expect(isPermanentHttpRejection(null)).toBe(false);
    expect(isPermanentHttpRejection(undefined)).toBe(false);
    expect(isPermanentHttpRejection('mapped from HTTP status code 403')).toBe(true);
    expect(isPermanentHttpRejection({})).toBe(false);
  });
});

describe('isDefinitelyOffline', () => {
  const setOnLine = (value: any) => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      configurable: true,
      get: () => value
    });
  };

  afterEach(() => {
    // Restore the jsdom default (writable boolean true).
    Object.defineProperty(globalThis.navigator, 'onLine', {
      configurable: true,
      get: () => true
    });
  });

  it('returns true only when navigator.onLine === false', () => {
    setOnLine(false);
    expect(isDefinitelyOffline()).toBe(true);
  });

  it('returns false when navigator.onLine === true', () => {
    setOnLine(true);
    expect(isDefinitelyOffline()).toBe(false);
  });

  it('returns false when navigator.onLine is non-boolean', () => {
    setOnLine('yes');
    expect(isDefinitelyOffline()).toBe(false);
  });

  it('returns false when navigator is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: undefined
    });

    expect(isDefinitelyOffline()).toBe(false);

    Object.defineProperty(globalThis, 'navigator', descriptor!);
  });
});

describe('classifySyncError', () => {
  const setOnLine = (value: any) => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      configurable: true,
      get: () => value
    });
  };

  afterEach(() => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      configurable: true,
      get: () => true
    });
  });

  it('returns network when navigator says offline', () => {
    setOnLine(false);
    expect(classifySyncError(new Error('Failed to fetch'))).toBe('network');
  });

  it('returns node when navigator is online (default classification)', () => {
    setOnLine(true);
    expect(classifySyncError(new Error('status code 502'))).toBe('node');
  });

  it('returns node when navigator info is unavailable (non-boolean)', () => {
    setOnLine(null);
    expect(classifySyncError(new Error('rpc error'))).toBe('node');
  });
});
