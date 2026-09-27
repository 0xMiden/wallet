// Dedicated worker the offscreen document proves in (#945).
//
// A wasm-bindgen-rayon prove on a document's main thread cannot `Atomics.wait`, so it
// spins for the whole proof, and every extension page shares that renderer thread: the
// side panel and popup froze for 20 to 75 s. This worker owns a second SDK instance with
// its own rayon pool and does one thing - `TransactionResult` bytes in, `ProvenTransaction`
// bytes out - so the document's thread stays free while it runs.
//
// The import list is the contract: the SDK's MT lazy entry and the protocol module,
// nothing else. Vite's worker pass runs none of the extension's plugins, and the worker
// has no `chrome.*`, so nothing from `lib/` may reach it. The document records every
// marker and telemetry step on its behalf.
import {
  getWasmOrThrow,
  initThreadPool,
  type ProvenTransaction,
  rayonThreadCount,
  TransactionProver,
  TransactionResult,
  WebClient
} from '@miden-sdk/miden-sdk/mt/lazy';

import {
  isProveRequestMessage,
  LOCAL_PROVER_DESCRIPTOR,
  type ProveRequestMessage,
  type ProveWorkerMessage,
  proveThreadCount,
  transferable
} from './prove-worker-protocol';

function post(message: ProveWorkerMessage, transfer: Transferable[] = []): void {
  globalThis.postMessage(message, { transfer });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function boot(): Promise<WebClient | null> {
  if (globalThis.crossOriginIsolated !== true) {
    post({
      type: 'init-failed',
      reason: 'not-cross-origin-isolated',
      message: 'the prove worker is not cross-origin isolated'
    });
    return null;
  }
  try {
    await getWasmOrThrow();
  } catch (error) {
    post({ type: 'init-failed', reason: 'wasm-load', message: messageOf(error) });
    return null;
  }
  // A single-threaded SDK here is a build bug, not a fallback: it would prove on one
  // thread and report success.
  if (typeof initThreadPool !== 'function') {
    post({ type: 'init-failed', reason: 'thread-pool', message: 'initThreadPool is not exported by this SDK build' });
    return null;
  }
  let client: WebClient;
  try {
    await initThreadPool(proveThreadCount(navigator.hardwareConcurrency));
    // A raw client that never runs createClient: with an explicit prover,
    // proveTransaction is a pure computation that needs no store or network.
    client = new WebClient();
  } catch (error) {
    post({ type: 'init-failed', reason: 'thread-pool', message: messageOf(error) });
    return null;
  }
  post({ type: 'ready', threads: rayonThreadCount(), crossOriginIsolated: true });
  return client;
}

const booted = boot();

async function prove(request: ProveRequestMessage): Promise<void> {
  const { id } = request;
  if (request.proverDescriptor !== LOCAL_PROVER_DESCRIPTOR) {
    post({ type: 'result', id, ok: false, message: 'unsupported prover descriptor' });
    return;
  }
  const client = await booted;
  if (!client) {
    post({ type: 'result', id, ok: false, message: 'the prove worker did not start' });
    return;
  }
  let result: TransactionResult | undefined;
  let proven: ProvenTransaction | undefined;
  try {
    const started = performance.now();
    result = TransactionResult.deserialize(request.txResult);
    // proveTransaction borrows the result and consumes the prover.
    proven = await client.proveTransaction(result, TransactionProver.newLocalProver());
    const { bytes, transfer } = transferable(proven.serialize());
    post({ type: 'result', id, ok: true, proven: bytes, durationMs: performance.now() - started }, transfer);
  } catch (error) {
    post({ type: 'result', id, ok: false, message: messageOf(error) });
  } finally {
    result?.free();
    proven?.free();
  }
}

// One prove at a time, behind the client's own FIFO.
let queue: Promise<void> = Promise.resolve();

globalThis.addEventListener('message', event => {
  const data: unknown = event.data;
  if (!isProveRequestMessage(data)) return;
  queue = queue.then(() => prove(data));
});
