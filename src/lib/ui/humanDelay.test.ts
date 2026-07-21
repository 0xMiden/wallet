import { withErrorHumanDelay } from './humanDelay';

// `withErrorHumanDelay` logs the error and then pauses for a fixed 300ms
// "human" delay (so error UI does not flash instantly) before invoking the
// callback. We drive the delay deterministically with fake timers and silence
// the deliberate console.error so it does not pollute the test output.
describe('withErrorHumanDelay', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    consoleErrorSpy.mockRestore();
  });

  it('logs the provided error before waiting', async () => {
    const err = new Error('boom');
    const callback = jest.fn();

    const promise = withErrorHumanDelay(err, callback);

    // console.error runs synchronously, ahead of the awaited delay.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(err);

    await jest.advanceTimersByTimeAsync(300);
    await promise;
  });

  it('does not invoke the callback before the 300ms delay elapses', async () => {
    const callback = jest.fn();

    const promise = withErrorHumanDelay('some-error', callback);

    // Just short of the delay: the callback must still be pending.
    await jest.advanceTimersByTimeAsync(299);
    expect(callback).not.toHaveBeenCalled();

    // Crossing the 300ms boundary triggers it exactly once.
    await jest.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);

    await promise;
  });

  it('resolves after invoking the callback', async () => {
    const callback = jest.fn();

    const promise = withErrorHumanDelay(new Error('nope'), callback);

    await jest.advanceTimersByTimeAsync(300);
    await expect(promise).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('supports an async callback that returns a Promise', async () => {
    const order: string[] = [];
    const callback = jest.fn(async () => {
      order.push('callback');
    });

    const promise = withErrorHumanDelay('async-error', callback);

    await jest.advanceTimersByTimeAsync(300);
    await promise;

    expect(callback).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['callback']);
  });

  it('accepts non-Error error values and still logs and delays', async () => {
    const callback = jest.fn();
    const errValue = { code: 42, message: 'plain object error' };

    const promise = withErrorHumanDelay(errValue, callback);

    expect(consoleErrorSpy).toHaveBeenCalledWith(errValue);
    expect(callback).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(300);
    await promise;

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
