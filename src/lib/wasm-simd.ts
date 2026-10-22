/**
 * The smallest module that uses fixed-width SIMD (`i32.const 0; i8x16.splat; i8x16.popcnt`). The SDK's WebAssembly
 * needs SIMD and ships no build without it, so a runtime that rejects this module cannot run the wallet (BREAD-WALLET-4H:
 * a Chromium on a CPU without SSE4.1, a VM exposing a reduced CPU model, or SIMD disabled by flag or policy).
 */
export const SIMD_PROBE_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
]);

export function isWasmSimdSupported(): boolean {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') return false;
  try {
    return WebAssembly.validate(SIMD_PROBE_MODULE);
  } catch {
    // A probe that cannot answer must not lock a working runtime out; the SDK's own start reports a real failure.
    return true;
  }
}
