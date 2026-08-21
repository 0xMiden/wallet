import { DEFAULT_TOKEN_METADATA } from './defaults';
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
  // Absent metadata is not a wrong scale — it is no claim at all, and every
  // caller already has its own fallback for that case (`formatAmount` reads
  // MIDEN's decimals, alongside the symbol falling back to MIDEN). This
  // predicate exists to catch metadata that STATES a scale it does not know,
  // so it must not also swallow the case where nothing was stated.
  if (metadata === undefined) return true;
  if (metadata.scaleIsUnknown === true) return false;
  return !isUnmarkedPlaceholder(metadata);
}

function isUnmarkedPlaceholder(metadata: AssetMetadata): boolean {
  return (
    metadata.symbol === DEFAULT_TOKEN_METADATA.symbol &&
    metadata.name === DEFAULT_TOKEN_METADATA.name &&
    metadata.decimals === DEFAULT_TOKEN_METADATA.decimals
  );
}
