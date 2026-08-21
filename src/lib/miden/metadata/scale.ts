import { AssetMetadata } from './types';

/**
 * Whether `metadata.decimals` can be trusted to convert base units into a
 * displayed quantity. False for the unknown-token placeholder, whose 6 is a
 * guess — display the symbol and withhold the number in that case.
 *
 * This lives apart from the metadata lookups on purpose: it is the semantic
 * pair of the `scaleIsUnknown` field, so display code can ask the question
 * without pulling in the fetch/store machinery.
 */
export function hasKnownScale(metadata: AssetMetadata | undefined): boolean {
  return metadata !== undefined && metadata.scaleIsUnknown !== true;
}
