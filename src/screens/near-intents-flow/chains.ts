import type {
  NearIntentsCatalog,
  NearIntentsCatalogChain,
  NearIntentsCatalogToken,
  OneClickAsset
} from 'lib/one-click/types';

/**
 * The `NetworkLogo` slug of a 1Click origin chain. The 1Click `blockchain` names are short ("eth",
 * "sol"); the shared logo map uses the bridge network names.
 */
export function chainLogoNetwork(chainId: string): string {
  switch (chainId) {
    case 'eth':
      return 'ethereum';
    case 'arb':
      return 'arbitrum';
    case 'op':
      return 'optimism';
    case 'sol':
      return 'solana';
    case 'btc':
      return 'bitcoin';
    default:
      return chainId;
  }
}

/** The ids of the three selections on the form. An undefined id selects the first entry. */
export interface NearIntentsSelection {
  chainId?: string;
  tokenAssetId?: string;
  outputAssetId?: string;
}

export interface ResolvedNearIntentsSelection {
  chain: NearIntentsCatalogChain;
  token: NearIntentsCatalogToken;
  output: OneClickAsset;
}

/**
 * Finds the selected chain, token and output in the catalog. An id that the catalog does not have
 * (or no id) falls back to the first entry, so the form always has a full route. Returns undefined
 * when the catalog has no complete route.
 */
export function resolveSelection(
  catalog: NearIntentsCatalog,
  selection: NearIntentsSelection
): ResolvedNearIntentsSelection | undefined {
  const chain = catalog.chains.find(entry => entry.id === selection.chainId) ?? catalog.chains[0];
  if (!chain) return undefined;
  const token = chain.tokens.find(entry => entry.asset.assetId === selection.tokenAssetId) ?? chain.tokens[0];
  if (!token) return undefined;
  const output = token.outputs.find(entry => entry.assetId === selection.outputAssetId) ?? token.outputs[0];
  if (!output) return undefined;
  return { chain, token, output };
}

/** True when the catalog has at least one chain with a token that has an output. */
export function catalogHasRoute(catalog: NearIntentsCatalog): boolean {
  return resolveSelection(catalog, {}) !== undefined;
}
