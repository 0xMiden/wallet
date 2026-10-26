/**
 * The one construction site of the offscreen document's prove worker (#945).
 *
 * Vite bundles a worker only when `new Worker(new URL('<literal>', import.meta.url))`
 * is spelled out in one expression, so the URL stays a literal here. Its own module so
 * the client's tests can hand it a fake worker.
 */
export function spawnProveWorker(): Worker {
  return new Worker(new URL('./prove-worker.ts', import.meta.url), { type: 'module' });
}
