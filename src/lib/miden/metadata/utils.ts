import { getFaucetIdSetting, getTokensBaseMetadata } from '../front';
import { DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from './defaults';
import { AssetMetadata, DetailedAssetMetdata } from './types';

export function getAssetSymbol(metadata: AssetMetadata | null, short = false) {
  if (!metadata) return '???';
  if (!short) return metadata.symbol;
  return metadata.symbol === 'aleo' ? 'aleo' : metadata.symbol.substr(0, 5);
}

export function getAssetName(metadata: AssetMetadata | null) {
  return metadata ? metadata.symbol : 'Unknown Token';
}

export function toBaseMetadata(data: DetailedAssetMetdata | AssetMetadata): AssetMetadata {
  return {
    decimals: data.decimals,
    symbol: data.symbol,
    name: data.name,
    shouldPreferSymbol: data.shouldPreferSymbol,
    thumbnailUri: data.thumbnailUri,
    displayUri: data.displayUri,
    artifactUri: data.artifactUri,
    // Carried through deliberately: this whitelist is what gets persisted, and
    // dropping the marker here would launder the placeholder's guessed
    // `decimals` into a stored record that reads as fact.
    scaleIsUnknown: data.scaleIsUnknown
  };
}

export async function getTokenMetadata(tokenId: string | null): Promise<AssetMetadata> {
  const midenFaucetId = await getFaucetIdSetting();
  if (!tokenId || tokenId === midenFaucetId) return MIDEN_METADATA;
  const tokenMetadata = await getTokensBaseMetadata(tokenId);
  // A real, non-native token whose metadata we couldn't resolve is Unknown —
  // not MIDEN. Falling back to MIDEN would mislabel it and misformat its amount
  // (MIDEN's 6 decimals).
  return tokenMetadata ?? DEFAULT_TOKEN_METADATA;
}
