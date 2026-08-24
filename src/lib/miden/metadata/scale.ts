import { AssetMetadata } from './types';

/**
 * The unknown-token placeholder's identifying fields, declared here rather than
 * read off `DEFAULT_TOKEN_METADATA` so that asking this question costs nothing.
 *
 * `defaults.ts` builds its `thumbnailUri` by calling into `lib/platform` at
 * module scope, so importing it has a side effect at load time. This predicate
 * is imported by every screen that displays a quantity; making all of them
 * depend on a platform probe to ask "are these decimals real" is the wrong
 * shape, and it made unrelated suites fail to load. `DEFAULT_TOKEN_METADATA`
 * spreads these fields in, so the two cannot drift.
 */
export const UNKNOWN_TOKEN_IDENTITY = {
  decimals: 6,
  symbol: 'Unknown',
  name: 'Unknown'
} as const;

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
    metadata.symbol === UNKNOWN_TOKEN_IDENTITY.symbol &&
    metadata.name === UNKNOWN_TOKEN_IDENTITY.name &&
    metadata.decimals === UNKNOWN_TOKEN_IDENTITY.decimals
  );
}
