import { DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from './defaults';
import { AssetMetadata } from './types';

/**
 * Whether `metadata.decimals` can be trusted to convert base units into a
 * displayed quantity. False for the unknown-token placeholder, whose 6 is a
 * guess — display the symbol and withhold the number in that case.
 *
 * This lives apart from the metadata lookups on purpose: it is the semantic
 * pair of the `scaleIsUnknown` field, so display code can ask the question
 * without pulling in the fetch/store machinery.
 *
 * Two ways to recognise the placeholder, because the flag alone is not enough:
 *
 * - `scaleIsUnknown`, the durable marker, which is what a record written by
 *   this build carries.
 * - The placeholder's literal shape, for records that predate the marker. The
 *   placeholder is PERSISTED under `tokens_base_metadata` (see
 *   `cacheTokenMetadata`), so every wallet that has already met an unresolvable
 *   faucet holds an unmarked copy that no later write will correct. Without
 *   this second test the fix would land for new faucets only, and miss exactly
 *   the users who have already seen the wrong number.
 *
 * A real faucet would have to be named "Unknown", described as "Unknown" and
 * declare 6 decimals to be caught by the shape test — at which point it is
 * indistinguishable from the placeholder anyway.
 */
export function hasKnownScale(metadata: AssetMetadata | undefined): boolean {
  // Absent is unknown. Nothing was stated, so there is nothing to trust — and
  // the fallback callers used to rely on for this case (`formatAmount` reading
  // MIDEN's 6) is the same invented number this predicate exists to prevent,
  // just sourced from the native token instead of the placeholder. Resolve the
  // faucet with `resolveDisplayMetadata` FIRST, which decides deliberately
  // whether an absent record means "native" or "unknown", then ask this.
  if (metadata === undefined) return false;
  if (metadata.scaleIsUnknown === true) return false;
  // An explicit `false` is the faucet's own word, and it outranks the shape
  // test below — which cannot tell a token genuinely named "Unknown" with 6
  // decimals from the placeholder it happens to look like.
  if (metadata.scaleIsUnknown === false) return true;
  return !isUnmarkedPlaceholder(metadata);
}

function isUnmarkedPlaceholder(metadata: AssetMetadata): boolean {
  return (
    metadata.symbol === DEFAULT_TOKEN_METADATA.symbol &&
    metadata.name === DEFAULT_TOKEN_METADATA.name &&
    metadata.decimals === DEFAULT_TOKEN_METADATA.decimals
  );
}

/**
 * The metadata record that governs how a faucet is displayed, resolved the way
 * `getTokenMetadata` resolves it, so a screen reading the in-memory store
 * agrees with an activity row reading persisted metadata.
 *
 * Always returns a record, and the choice it makes for a missing one is the
 * whole point:
 *
 * - No faucet at all — the row is about the native asset, so MIDEN.
 * - A faucet the store has resolved — that record.
 * - The native faucet, not yet in the store — MIDEN, whose scale is fixed and
 *   known regardless of what the store has cached.
 * - Any other unresolved faucet — the unknown-token placeholder, so the caller
 *   sees a record that openly declares its scale a guess.
 *
 * That last case is why this exists. Reading `undefined` straight from the
 * store loses the distinction between "native" and "not resolved yet", and
 * every caller that then reached for a default reached for MIDEN's 6 —
 * rendering an unresolved 18-decimal token a trillion times too large.
 */
export function resolveDisplayMetadata(
  faucetId: string | undefined,
  assetsMetadata: Record<string, AssetMetadata> | undefined,
  nativeFaucetId: string | null
): AssetMetadata {
  if (faucetId === undefined) return MIDEN_METADATA;
  const stored = assetsMetadata?.[faucetId];
  if (stored) return stored;
  return nativeFaucetId !== null && faucetId === nativeFaucetId ? MIDEN_METADATA : DEFAULT_TOKEN_METADATA;
}
