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

import { recordProveMarker } from 'lib/miden/sdk/prove-telemetry';

export type ProveWorkerErrorKind =
  | 'spawn-failed'
  | 'init-failed'
  | 'init-timeout'
  | 'crashed'
  | 'prove-failed'
  | 'unsupported-prover';

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

export interface LocalProveRequest {
  /** `TransactionResult.serialize()`. The transport may transfer its buffer. */
  txResult: Uint8Array;
  /** Only `'local'` is accepted; anything else rejects with `unsupported-prover`. */
  proverDescriptor: string;
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
// every other realm's marker helper.
const PROVE_TIMING_ENABLED = process.env.MIDEN_E2E_TEST === 'true';

export function recordProveTiming(message: string): void {
  if (!PROVE_TIMING_ENABLED) return;
  const line = `[prove-timing] ${message}`;
  console.log(line);
  recordProveMarker(line);
}
