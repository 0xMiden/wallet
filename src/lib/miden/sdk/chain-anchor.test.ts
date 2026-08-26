import { freeChainAnchor } from './chain-anchor';

// A decoded `ChainAnchor` reduced to the member this helper touches. `as never`
// (the idiom used throughout these suites for WASM handles) rather than a full
// stub: the other members are irrelevant here and faking them would only invite
// the stub to drift from the real class.
const anchorStub = (free: jest.Mock) => ({ free }) as never;

const throwingFree = () =>
  jest.fn(() => {
    throw new Error('null pointer passed to rust');
  });

describe('freeChainAnchor (#784)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('releases the anchor exactly once', () => {
    const free = jest.fn();

    freeChainAnchor(anchorStub(free));

    expect(free).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is a no-op for an absent anchor, so the unanchored path needs no guard of its own', () => {
    expect(() => freeChainAnchor(undefined)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  // The whole reason this helper exists. The call site frees in a `finally`, so
  // a throw here would REPLACE the error in flight — costing both the executor's
  // reason and, worse, the error IDENTITY the guardian catch branches on to
  // decide whether to retract a co-signature. wasm-bindgen's generated `free()`
  // has no null-pointer guard, so a disposed module (a #775 eviction) makes this
  // real rather than theoretical.
  it('swallows and reports a failing free instead of masking the in-flight error', () => {
    const free = throwingFree();

    expect(() => freeChainAnchor(anchorStub(free))).not.toThrow();
    expect(free).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // The reason goes in the FORMAT STRING, not only the object — Chrome
    // truncates strings nested in a logged object's preview.
    expect(warn.mock.calls[0][0]).toContain('null pointer passed to rust');
  });

  it('preserves the original failure when used the way both pipelines use it', () => {
    const free = throwingFree();

    const run = () => {
      try {
        throw new Error('execution failed: unauthorized');
      } finally {
        freeChainAnchor(anchorStub(free));
      }
    };

    expect(run).toThrow('execution failed: unauthorized');
  });

  // The offscreen realm's console is the one the E2E harness cannot attach to,
  // so a failed free there has to reach the realm's own breadcrumb channel too.
  it('reports a failed free to the secondary channel when one is supplied', () => {
    const report = jest.fn();

    freeChainAnchor(anchorStub(throwingFree()), report);

    expect(report).toHaveBeenCalledWith('chain anchor free failed');
  });

  it('does not touch the secondary channel on a successful free', () => {
    const report = jest.fn();

    freeChainAnchor(anchorStub(jest.fn()), report);

    expect(report).not.toHaveBeenCalled();
  });
});
