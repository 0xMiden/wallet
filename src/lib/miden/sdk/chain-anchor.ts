import type { ChainAnchor } from '@miden-sdk/miden-sdk/lazy';

/**
 * Release a decoded `ChainAnchor`, reporting rather than propagating a failure
 * to do so (#784).
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
 * Losing that exception is the expensive outcome, and not only for diagnostics:
 * the guardian catch branches on `isWasmClientPoisonedError` to decide whether
 * to retract a co-signature, so a `free()` error substituted for an eviction
 * would abandon a candidate the chain may still consume. Reclaiming a few
 * hundred kilobytes is not worth either cost.
 *
 * Same rationale as `MidenClientSingleton`'s `freeGuarded`, which guards a
 * client dispose the same way; kept separate because that one is a private
 * method on the singleton and this runs in the offscreen realm too.
 *
 * @param report optional secondary channel for the failure. The offscreen realm
 * passes `recordProveTiming`, because a hidden document's `console` is the one
 * the E2E harness cannot attach to.
 */
export function freeChainAnchor(anchor: ChainAnchor | undefined, report?: (message: string) => void): void {
  if (!anchor) return;
  try {
    anchor.free();
  } catch (freeError) {
    // Message in the FORMAT STRING, not only the object: Chrome truncates
    // strings nested in a logged object's preview.
    console.warn(`[Guardian] failed to free the decoded chain anchor (#784): ${String(freeError)}`, {
      error: freeError
    });
    report?.('chain anchor free failed');
  }
}
