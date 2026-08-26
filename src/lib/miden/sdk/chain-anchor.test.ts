import { freeChainAnchor } from './chain-anchor';

describe('freeChainAnchor (#784)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('releases the anchor exactly once', () => {
    const anchor = { free: jest.fn() };

    freeChainAnchor(anchor);

    expect(anchor.free).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is a no-op for an absent anchor, so the unanchored path needs no guard of its own', () => {
    expect(() => freeChainAnchor(undefined)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  // The whole reason this helper exists. The call site frees in a `finally`, so
  // a throw here would REPLACE the execute failure that is in flight — and a
  // guardian failure's diagnostic value is entirely in the executor's reason.
  // wasm-bindgen's generated `free()` has no null-pointer guard, so a disposed
  // module (a #775 eviction) makes this a real possibility rather than a
  // theoretical one.
  it('swallows and reports a failing free instead of masking the in-flight error', () => {
    const anchor = {
      free: jest.fn(() => {
        throw new Error('null pointer passed to rust');
      })
    };

    expect(() => freeChainAnchor(anchor)).not.toThrow();
    expect(anchor.free).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('preserves the original failure when used the way both pipelines use it', () => {
    const anchor = {
      free: jest.fn(() => {
        throw new Error('null pointer passed to rust');
      })
    };

    const run = () => {
      try {
        throw new Error('execution failed: unauthorized');
      } finally {
        freeChainAnchor(anchor);
      }
    };

    expect(run).toThrow('execution failed: unauthorized');
  });
});
