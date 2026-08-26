import type { ChainAnchor } from '@miden-sdk/miden-sdk/lazy';

/**
 * Release a `ChainAnchor`, reporting rather than propagating a failure to do so
 * (#784). Used by both the executor realms, which DECODE one off the wire, and
 * the proposal creators, which CAPTURE one and only need its serialized form.
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
    // The reporting is itself wrapped: this whole function runs in a `finally`,
    // so "never throws" has to hold for the failure path too — a throwing
    // console or report channel would destroy the in-flight error just as
    // surely as the `free()` this catch exists to contain.
    try {
      // Message in the FORMAT STRING, not only the object: Chrome truncates
      // strings nested in a logged object's preview.
      console.warn(`[Guardian] failed to free the chain anchor (#784): ${String(freeError)}`, {
        error: freeError
      });
      report?.('chain anchor free failed');
    } catch {
      // best-effort — losing the report is strictly cheaper than losing the
      // error the caller is already carrying.
    }
  }
}
