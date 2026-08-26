/**
 * A decoded WASM `ChainAnchor`, reduced to the only member its owner calls.
 * Structural rather than the SDK class so the offscreen realm — which reaches
 * the SDK through an untyped lazy namespace — can share this helper.
 */
export interface FreeableChainAnchor {
  free: () => void;
}

/**
 * Release a decoded `ChainAnchor`, swallowing a failure to do so (#784).
 *
 * The anchor is BORROWED by `executeRequest` (the generated glue passes
 * `anchor.__wbg_ptr` without `__destroy_into_raw`), so the caller must free it,
 * and it carries a partial blockchain — leaving it to the finalizer is what the
 * SDK explicitly warns against. That free belongs in a `finally`, which is
 * where the hazard comes from: wasm-bindgen's generated `free()` calls into the
 * wasm module with no null-pointer guard, so if the module is gone — the exact
 * state a poisoned/disposed client leaves behind after a #775 eviction — it
 * throws, and a throw inside `finally` REPLACES the in-flight exception.
 *
 * Losing the executor's reason is the expensive outcome: a guardian failure's
 * whole diagnostic value is that message. Reclaiming a few hundred kilobytes is
 * not worth it, so a failed free is reported and dropped.
 */
export function freeChainAnchor(anchor: FreeableChainAnchor | undefined): void {
  if (!anchor) return;
  try {
    anchor.free();
  } catch (freeError) {
    console.warn('[Guardian] failed to free the decoded chain anchor (#784)', { error: freeError });
  }
}
