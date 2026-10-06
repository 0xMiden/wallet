// Wire format between the offscreen document and its prove worker (#945), and the
// rayon thread cap both of their WASM instances use.
//
// Imports nothing, on purpose: Vite bundles the worker in a separate pass that runs
// none of the extension's plugins (no wasm, node-polyfill or SVG transforms), so
// every module the worker reaches has to survive that pass untouched.

/** Parent to worker. `txResult.buffer` travels in the transfer list. */
export interface ProveRequestMessage {
  type: 'prove';
  id: number;
  txResult: Uint8Array;
}

export type ProveWorkerInitFailure = 'not-cross-origin-isolated' | 'wasm-load' | 'thread-pool';

// A Record over the union, not a string[]: if `ProveWorkerInitFailure` ever gains or
// loses a member, a missing or stale key here is a tsc error, not a silent drift that
// only a test could catch.
const INIT_FAILURES: Record<ProveWorkerInitFailure, true> = {
  'not-cross-origin-isolated': true,
  'wasm-load': true,
  'thread-pool': true
};

/** Worker to parent. A successful result's `proven.buffer` travels in the transfer list. */
export type ProveWorkerMessage =
  | { type: 'ready'; threads: number; crossOriginIsolated: true }
  | { type: 'init-failed'; reason: ProveWorkerInitFailure; message: string }
  | { type: 'result'; id: number; ok: true; proven: Uint8Array; durationMs: number }
  | { type: 'result'; id: number; ok: false; message: string };

/**
 * Threads for a rayon pool: one per logical core, capped at 6 (#847).
 *
 * Spawning one per logical core is counter-productive: the pool competes with its
 * realm's own thread and the browser compositor, and on Apple Silicon
 * `hardwareConcurrency` counts efficiency cores that are ~2-3x slower than the
 * performance ones. rayon splits work evenly, so a chunk landing on an E-core becomes
 * the critical path the whole proof waits on.
 *
 * Measured, web-sdk proving benchmark (single-sig ECDSA consume, MT dist, quiet
 * machine, 4P+6E so hardwareConcurrency = 10), three sweeps:
 *    threads   2      4      6      8      10
 *    ms      7280   5428   5386   5802   6424   (sweep 1)
 *                   5530   5524   5860          (sweep 2)
 *                   5367   5401   5742          (sweep 3)
 * 4 and 6 are indistinguishable (ranges overlap); 8 is consistently worse with no
 * overlap; 10 is ~19% worse than 6. Scaling saturates at the performance-core count
 * and goes NEGATIVE beyond it.
 *
 * 6 rather than 4 because the error is asymmetric - too high measurably hurts, too
 * low costs nothing here - and 6 leaves headroom on machines with more fast cores.
 * CAVEAT: this curve is from ONE heterogeneous machine. A homogeneous many-core
 * desktop is untested and might prefer more.
 */
export function proveThreadCount(hardwareConcurrency: number | undefined): number {
  return Math.min(hardwareConcurrency ?? 4, 6);
}

/**
 * `bytes` as a message payload plus its transfer list. A view into a larger or shared
 * buffer is copied first: transferring would move (or, for a SharedArrayBuffer, refuse)
 * memory the caller still owns.
 */
export function transferable(bytes: Uint8Array): { bytes: Uint8Array; transfer: Transferable[] } {
  const { buffer } = bytes;
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return { bytes, transfer: [buffer] };
  }
  const copy = bytes.slice();
  return { bytes: copy, transfer: [copy.buffer] };
}

export function isProveRequestMessage(data: unknown): data is ProveRequestMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === 'prove' &&
    'id' in data &&
    typeof data.id === 'number' &&
    'txResult' in data &&
    data.txResult instanceof Uint8Array
  );
}

export function isProveWorkerMessage(data: unknown): data is ProveWorkerMessage {
  if (typeof data !== 'object' || data === null || !('type' in data)) return false;
  switch (data.type) {
    case 'ready':
      return (
        'threads' in data &&
        typeof data.threads === 'number' &&
        'crossOriginIsolated' in data &&
        data.crossOriginIsolated === true
      );
    case 'init-failed':
      return (
        'reason' in data &&
        typeof data.reason === 'string' &&
        // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a reason of
        // 'constructor' or 'toString' would read as present even though it is not
        // one of the object's own keys.
        Object.hasOwn(INIT_FAILURES, data.reason) &&
        'message' in data &&
        typeof data.message === 'string'
      );
    case 'result':
      if (!('id' in data) || typeof data.id !== 'number' || !('ok' in data)) return false;
      if (data.ok === true) {
        return (
          'proven' in data &&
          data.proven instanceof Uint8Array &&
          'durationMs' in data &&
          typeof data.durationMs === 'number'
        );
      }
      return data.ok === false && 'message' in data && typeof data.message === 'string';
    default:
      return false;
  }
}
