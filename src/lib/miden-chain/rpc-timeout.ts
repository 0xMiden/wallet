/**
 * Hard timeout + one retry for one-shot RPC reads.
 *
 * The stateful WebClient sync has its own watchdog, but the direct `RpcClient`
 * reads (native fee-faucet discovery, Epoch chain-head, faucet metadata) awaited
 * one shot with NO bound: an accept-then-blackhole node (connection accepted, no
 * bytes, no close) leaves the awaiting consumer hung indefinitely — the reclaim
 * gate never opens, MIDEN branding never renders, a deposit spinner never
 * settles. Wrapping the read here means the worst case is a bounded, typed
 * failure the caller can surface + retry (resilience gap 9).
 */

const DEFAULT_RPC_TIMEOUT_MS = 15_000;

export class RpcTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`RPC "${label}" timed out after ${ms}ms`);
    this.name = 'RpcTimeoutError';
  }
}

function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError(label, ms)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Run a one-shot RPC read with a per-attempt timeout and (by default) one retry,
 * so a wedged node can never hang the caller forever. Rejects with the last error
 * (an {@link RpcTimeoutError} if every attempt timed out).
 */
export async function withRpcTimeout<T>(
  fn: () => Promise<T>,
  label: string,
  { timeoutMs = DEFAULT_RPC_TIMEOUT_MS, retries = 1 }: { timeoutMs?: number; retries?: number } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await raceTimeout(fn(), timeoutMs, label);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
