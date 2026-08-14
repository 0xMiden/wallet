import { RpcTimeoutError, withRpcTimeout } from './rpc-timeout';

describe('withRpcTimeout (resilience gap 9)', () => {
  it('returns the value when the read resolves in time', async () => {
    await expect(withRpcTimeout(() => Promise.resolve(42), 'x', { timeoutMs: 1000 })).resolves.toBe(42);
  });

  it('retries once on a transient failure then succeeds', async () => {
    const fn = jest.fn<Promise<number>, []>().mockRejectedValueOnce(new Error('blip')).mockResolvedValue(7);
    await expect(withRpcTimeout(fn, 'x', { timeoutMs: 1000 })).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects with RpcTimeoutError when the node blackholes past the timeout (no infinite hang)', async () => {
    jest.useFakeTimers();
    const hang = () => new Promise<number>(() => {}); // never settles
    // Capture the outcome, advance past both attempts' timeouts, then assert.
    const caught = withRpcTimeout(hang, 'wedged', { timeoutMs: 100, retries: 1 }).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(250);
    expect(await caught).toBeInstanceOf(RpcTimeoutError);
    jest.useRealTimers();
  });
});
