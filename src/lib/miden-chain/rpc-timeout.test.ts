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
    const promise = withRpcTimeout(hang, 'wedged', { timeoutMs: 100, retries: 1 });
    const assertion = expect(promise).rejects.toBeInstanceOf(RpcTimeoutError);
    await jest.advanceTimersByTimeAsync(250); // past both attempts
    await assertion;
    jest.useRealTimers();
  });
});
