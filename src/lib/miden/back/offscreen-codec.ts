// Shared IPC codec for the offscreen-document bus (issue #260, slice 1).
//
// The offscreen prover already ships binary payloads across
// `chrome.runtime.sendMessage` as base64 because raw typed-array
// structured-clone proved unreliable ("unexpected end of file" on the
// receiver — see `offscreen-prover.ts`). Slice 1 generalizes that prove-only
// channel to a method-dispatch channel (`OFFSCREEN_CALL`) that can carry
// arbitrary WASM-client calls. This module is the single, shared definition
// of the wire format so the two ends — the SW-side `MidenClientProxy` and the
// offscreen dispatch table (`src/offscreen/main.ts`) — agree byte-for-byte.
//
// It has ZERO runtime dependencies (only `btoa`/`atob`, present in both the SW
// and offscreen-document globals) so it is safe to import from either realm.

/** Discriminator kept on every offscreen-bound message; the offscreen listener
 * ignores anything whose `target` is not this. */
export const OFFSCREEN_TARGET = 'offscreen' as const;

/** Discriminator for the REVERSE direction (offscreen → SW). The offscreen
 * keystore's `sign` stub cannot reach the SW-resident vault directly, so a
 * mid-op sign reverses across the bus: the offscreen doc posts an
 * {@link OffscreenSignRequest} tagged for the SW, and the SW's reverse-IPC
 * handler (which gates on this target) signs and responds. Tagging it `'sw'`
 * keeps the offscreen doc's own `target === 'offscreen'` listener from ever
 * picking it up (issue #260, slice 5, design §2.3). */
export const SW_TARGET = 'sw' as const;

/** Message family for a generalized WASM-client method call. Distinct from the
 * existing `OFFSCREEN_PROVE` family, which keeps working unchanged. */
export const OFFSCREEN_CALL = 'OFFSCREEN_CALL' as const;

/** Message family for a mid-op sign round-trip (offscreen → SW → offscreen).
 * The offscreen client is a singleton whose `keystore.sign` cannot be re-bound
 * per call and has no access to the SW's decrypted vault, so signing reverses
 * across the bus: only raw pubkey / signing-inputs / signature BYTES cross —
 * never an un-serializable SDK handle (issue #260, slice 5, design §2). */
export const OFFSCREEN_SIGN_REQUEST = 'OFFSCREEN_SIGN_REQUEST' as const;

/**
 * SW → offscreen request envelope (§1.1 of the design doc).
 *
 * `argsB64` carries the positional arguments, each encoded with
 * {@link encodeArg} (binary → base64 bytes, scalar → JSON). `deadline_ms` is
 * the per-op deadline the SW enforces; `null` means "no deadline".
 */
export interface OffscreenCallRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_CALL;
  op_id: string;
  method: string;
  argsB64: string[];
  deadline_ms: number | null;
}

/**
 * offscreen → SW response envelope (§1.1). Delivered via `sendResponse`.
 *
 * `resultB64` is the method's serialized result (base64) or `null` when the
 * method returned nothing (e.g. `getAccount` for an unknown id). A response of
 * `undefined` on the wire (doc closed/reaped) is treated by the SW as an
 * {@link OperationAbortedError}, and is therefore intentionally NOT part of this
 * type.
 */
export type OffscreenCallResponse =
  | { ok: true; op_id: string; resultB64: string | null; durationMs: number }
  | { ok: false; op_id: string; error: string; errorCode?: string };

/**
 * offscreen → SW reverse-IPC sign request (issue #260, slice 5, design §2.3).
 *
 * Posted from the offscreen client's `keystore.sign` stub while a write op is
 * mid-execute. `op_id` names the write op this sign belongs to (so the SW can
 * PAUSE that op's deadline for the round-trip, §2.5); `sign_id` correlates this
 * one sign to its response. Only raw bytes cross — `publicKeyB64` /
 * `signingInputsB64` are base64 of the exact `(pubkey, signingInputs)` bytes the
 * SDK handed the stub, and the SW returns the raw signature bytes. No SDK handle
 * is ever involved (contrast the `TransactionResult` result of a call).
 */
export interface OffscreenSignRequest {
  target: typeof SW_TARGET;
  type: typeof OFFSCREEN_SIGN_REQUEST;
  op_id: string;
  sign_id: string;
  publicKeyB64: string;
  signingInputsB64: string;
}

/**
 * SW → offscreen reverse-IPC sign response, delivered via `sendResponse`.
 *
 * On failure `reason` carries the SW-classified sign-callback reason (the same
 * union as `transaction/sign-callback.ts`'s `SignCallbackReason`; kept as a
 * string literal here to preserve this module's zero-runtime-dependency role).
 * The offscreen stub throws on `ok:false` (so the SDK's execute fails); the
 * classified reason is authoritative on the SW side, where it is recorded so a
 * locked-mid-sign consume DEFERS rather than Fails (issue #313, design §2.6).
 */
export type OffscreenSignResponse =
  | { ok: true; sign_id: string; signatureB64: string }
  | { ok: false; sign_id: string; error: string; reason?: 'locked' | 'rejected' | 'not_found' | 'internal' };

/**
 * Chunked base64 encoder for binary payloads. Chunked to stay under the
 * argument-count limit of `String.fromCharCode.apply` on large arrays; `0x8000`
 * keeps each call well under any sane limit. Mirrors the encoder the prove path
 * has shipped since the offscreen prover landed.
 */
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

/** Inverse of {@link bytesToB64}. */
export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Encode a single positional argument to a self-describing wire string (§1.4).
 *
 * The result is tagged so the decoder is unambiguous:
 *   - `b:<base64>` — a `Uint8Array`/`ArrayBuffer`, base64 of the raw bytes.
 *   - `s:<json>`   — any scalar / plain-JSON value (`getAccount`'s string id is
 *     the only shape slice 1 uses).
 *
 * Binary is kept as base64 (never structured-cloned) for the same reason the
 * prove path does — see the module header.
 */
export function encodeArg(value: unknown): string {
  if (value instanceof Uint8Array) return `b:${bytesToB64(value)}`;
  if (value instanceof ArrayBuffer) return `b:${bytesToB64(new Uint8Array(value))}`;
  // `?? null` so `undefined` (which `JSON.stringify` would drop) round-trips
  // deterministically as JSON `null`.
  return `s:${JSON.stringify(value ?? null)}`;
}

/** Inverse of {@link encodeArg}. */
export function decodeArg(encoded: string): unknown {
  const tag = encoded.slice(0, 2);
  const body = encoded.slice(2);
  if (tag === 'b:') return b64ToBytes(body);
  if (tag === 's:') return JSON.parse(body);
  throw new Error(`decodeArg: unrecognized argument tag in "${encoded.slice(0, 8)}…"`);
}

/**
 * Rejection raised on the SW side when an offscreen op is torn down by the
 * per-op deadline kill (§3): the SW `closeDocument()`s the offscreen realm —
 * taking the wedged WASM call down with it — and rejects the in-flight op(s)
 * with this error. It is a *retryable* classification (§3.5): the op never
 * observably completed, so the caller may re-queue it.
 */
export class OperationAbortedError extends Error {
  readonly op_id: string;
  readonly reason: string;

  constructor(op_id: string, reason: string) {
    super(`Offscreen operation ${op_id} aborted (${reason})`);
    this.name = 'OperationAbortedError';
    this.op_id = op_id;
    this.reason = reason;
  }
}
