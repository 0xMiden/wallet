/**
 * A realm's way to run a LOCAL prove somewhere other than its own thread (#945).
 *
 * Only the offscreen document installs one (its prove worker client), so every other
 * realm - the service worker, mobile, desktop, Firefox - finds none and keeps proving
 * exactly as before. Nothing here needs the DOM; the one extension call is
 * `recordProveTiming`'s guarded marker post (`prove-telemetry`'s `recordProveMarker`),
 * which every realm already imports, so the transaction code can still import this
 * module from any realm.
 */
import { ProvenTransaction, type TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { assertWasmHoldCurrent, type WasmLockHold, withWasmLockWatchdogPaused } from './miden-client';
import { recordProveMarker, recordSdkProveStep } from './prove-telemetry';

export type ProveWorkerErrorKind = 'spawn-failed' | 'init-failed' | 'init-timeout' | 'crashed' | 'prove-failed';

/**
 * A worker prove that failed before anything was submitted.
 *
 * `message` is closed wallet text. The worker's own text rides on `detail`, so no
 * rejection can match the realm's WASM trap predicate (`RuntimeError`, "unreachable
 * executed", ...) if it ever goes unhandled, which would evict a healthy lock holder.
 */
export class ProveWorkerError extends Error {
  readonly kind: ProveWorkerErrorKind;
  readonly detail: string | undefined;

  constructor(kind: ProveWorkerErrorKind, detail?: string) {
    super(`Local prove failed in the prove worker (${kind})`);
    this.name = 'ProveWorkerError';
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * A `ProveWorkerError`'s worker-side text, flattened to one line so a marker built
 * from it still matches the trail's one-line-per-entry format (#945).
 */
export function proveWorkerErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof ProveWorkerError) || typeof error.detail !== 'string') return undefined;
  return error.detail.replace(/\r?\n/g, ' ');
}

export interface LocalProveRequest {
  /** `TransactionResult.serialize()`. The transport may transfer its buffer. */
  txResult: Uint8Array;
}

export interface LocalProveResult {
  /** `ProvenTransaction.serialize()`. */
  proven: Uint8Array;
  /** How long the prove itself took, measured where it ran. */
  durationMs: number;
}

export interface LocalProveOptions {
  /**
   * Rejects when the caller is evicted from the WASM lock. An in-flight prove is then
   * stopped and rejects with this promise's reason; a prove not yet posted never is.
   */
  cancel?: Promise<never>;
}

export interface LocalProveTransport {
  prove(request: LocalProveRequest, options?: LocalProveOptions): Promise<LocalProveResult>;
  /** Start the transport's cold start now, so it overlaps execute and sign. */
  prewarm(): void;
}

let installed: LocalProveTransport | null = null;

/** Install this realm's transport. Only the offscreen document calls it. */
export function installLocalProveTransport(transport: LocalProveTransport | null): void {
  installed = transport;
}

export function getLocalProveTransport(): LocalProveTransport | null {
  return installed;
}

// #945: E2E-only markers for the prove worker client. Defined once here rather than
// in the client, since more than one caller needs it. Gated on the same build flag as
// every other realm's marker helper, and folds away exactly like those per-realm
// copies when the flag is false - being exported to more than one caller costs
// nothing here, since the bundler drops the branch before it ever reaches a caller.
const PROVE_TIMING_ENABLED = process.env.MIDEN_E2E_TEST === 'true';

export function recordProveTiming(message: string): void {
  if (!PROVE_TIMING_ENABLED) return;
  const line = `[prove-timing] ${message}`;
  console.log(line);
  recordProveMarker(line);
}

/**
 * Prove `result` through the realm's transport under the caller's lock hold.
 *
 * The flow keeps the WASM mutex for the whole prove (the staged calls are not atomic
 * per account, so yielding would let a queued write interleave), with the watchdog
 * relaxed exactly as for an in-realm local prove. Eviction cancels the prove: the
 * hold's `aborted` rejection stops the worker, so an abandoned flow can never go on
 * to submit. Every throw here is pre-submit.
 */
export async function proveInWorker(
  result: Pick<TransactionResult, 'serialize'>,
  hold: WasmLockHold
): Promise<ProvenTransaction> {
  const transport = installed;
  if (!transport) throw new Error('proveInWorker called in a realm with no local prove transport');
  assertWasmHoldCurrent(hold, 'before the worker prove');
  const txResult = result.serialize();
  recordProveTiming('local-prove-window open');
  const startedAt = performance.now();
  let outcome: LocalProveResult;
  try {
    outcome = await withWasmLockWatchdogPaused(() => transport.prove({ txResult }, { cancel: hold.aborted }), hold);
  } catch (error) {
    // The SDK observer times `proveTransaction` on this realm's client, which no
    // longer proves, so the #466 step timing is fed from here.
    recordSdkProveStep({ durationMs: performance.now() - startedAt, failed: true });
    throw error;
  } finally {
    recordProveTiming('local-prove-window close');
  }
  recordSdkProveStep({ durationMs: outcome.durationMs, failed: false });
  // The watchdog and the realm trap listener can run during a worker prove, so the
  // mutex may have moved on while it ran.
  assertWasmHoldCurrent(hold, 'after the worker prove, before submit');
  return ProvenTransaction.deserialize(outcome.proven);
}
