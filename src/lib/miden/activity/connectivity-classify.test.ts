import { classifySyncError, isDefinitelyOffline, isLikelyNetworkError } from './connectivity-classify';

describe('isLikelyNetworkError', () => {
  it.each([
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'Load failed',
    'request was abort',
    'request timed out after 30s',
    'connection refused',
    'transport error: closed stream',
    'rpc error: deadline exceeded',
    'prover responded with status code 502: Bad Gateway',
    'service unavailable 503'
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
