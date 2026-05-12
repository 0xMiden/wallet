import { MidenNativeProver } from '@miden/native-prover';
import { isMobile } from 'lib/platform';

// Local prove-timing recorder — mirrors the one in miden-client-interface.ts.
// Writes to globalThis.__PROVE_TIMINGS__ so the E2E harness can poll for
// markers even when console.log doesn't surface through the bridge.
// No-op outside the E2E build (`MIDEN_E2E_TEST=true`) to keep production
// devtools console quiet — the per-step logs are useful for harness
// observability but pure noise for normal users.
const PROVE_TIMING_ENABLED = process.env.MIDEN_E2E_TEST === 'true';

function recordProveTiming(message: string): void {
  if (!PROVE_TIMING_ENABLED) return;
  const line = `[prove-timing] [native-cb] ${message}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    const g = globalThis as unknown as { __PROVE_TIMINGS__?: string[] };
    if (!g.__PROVE_TIMINGS__) g.__PROVE_TIMINGS__ = [];
    g.__PROVE_TIMINGS__.push(`${Date.now()}|${line}`);
  } catch {
    // ignore
  }
}

/**
 * Build the JS callback that the web-sdk's
 * `TransactionProver.newCallbackProver(jsFn)` expects: a function taking
 * the serialized `TransactionInputs` as a `Uint8Array` and returning a
 * `Promise<Uint8Array>` resolving to the serialized `ProvenTransaction`.
 *
 * On the wire we round-trip through base64 because Capacitor's plugin
 * bridge JSON-serializes plugin arguments and return values. The native
 * Swift / Kotlin side decodes the base64 back to bytes before handing
 * to the C ABI, and re-encodes the result for the journey back.
 *
 * Only use this from a context where `isMobile()` is true; on the
 * extension/desktop builds the plugin is not bundled and the call
 * throws "MidenNativeProver has no implementation available."
 */
export function buildNativeProverCallback(): (input: Uint8Array) => Promise<Uint8Array> {
  if (!isMobile()) {
    throw new Error('buildNativeProverCallback called outside a mobile context');
  }
  return async (input: Uint8Array): Promise<Uint8Array> => {
    recordProveTiming(`native callback invoked, input=${input.length} bytes`);
    const tEncode = performance.now();
    const inputBase64 = uint8ArrayToBase64(input);
    recordProveTiming(`base64 encode took ${(performance.now() - tEncode).toFixed(0)}ms`);
    const tCall = performance.now();
    const result = await MidenNativeProver.prove({ input: inputBase64 });
    recordProveTiming(
      `MidenNativeProver.prove returned in ${(performance.now() - tCall).toFixed(0)}ms (native durationMs=${result.durationMs?.toFixed?.(0) ?? '?'})`
    );
    const tDecode = performance.now();
    const out = base64ToUint8Array(result.output);
    recordProveTiming(`base64 decode took ${(performance.now() - tDecode).toFixed(0)}ms, output=${out.length} bytes`);
    return out;
  };
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Avoid the chunked-spread trick — Capacitor inputs can be up to a few
  // MB and `String.fromCharCode(...bytes)` stack-overflows past ~125k
  // arguments. Manual chunked accumulation is safe at all sizes.
  let binary = '';
  const chunkSize = 32_768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
