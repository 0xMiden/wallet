/**
 * Runs `run` with a signal that aborts after `ms`, and clears the timer once `run` settles. It stands
 * in for `AbortSignal.timeout`, which iOS 15 WebKit and Safari before 16 lack. The signal ends only
 * what it is passed to, so `run` covers the whole request, its body read included.
 */
export async function withRequestTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
