import PQueue from 'p-queue';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';

import { AssetMetadata } from './types';

/**
 * The display values the user set for a token. Each field is optional: a field that is not set
 * keeps the faucet's value.
 */
export type TokenMetadataOverride = {
  name?: string;
  symbol?: string;
  decimals?: number;
};

/** The overrides by faucet id. They are global to the wallet, not per account. */
export type TokenMetadataOverrides = Record<string, TokenMetadataOverride>;

/**
 * The overrides have their own key. The schema check of `tokens_base_metadata` clears that key,
 * and each fetch writes it again. An override must survive both, so it is applied when the
 * metadata is read and is never merged into the cached chain record.
 */
export const TOKENS_METADATA_OVERRIDES_STORAGE_KEY = 'tokens_metadata_overrides';

export const TOKEN_NAME_MAX_LENGTH = 32;
export const TOKEN_SYMBOL_MAX_LENGTH = 12;
export const TOKEN_DECIMALS_MAX = 18;

const overridesWriteQueue = new PQueue({ concurrency: 1 });

export function isValidTokenName(name: string): boolean {
  return name.length >= 1 && name.length <= TOKEN_NAME_MAX_LENGTH;
}

export function isValidTokenSymbol(symbol: string): boolean {
  return symbol.length >= 1 && symbol.length <= TOKEN_SYMBOL_MAX_LENGTH;
}

export function isValidTokenDecimals(decimals: unknown): decimals is number {
  return typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= TOKEN_DECIMALS_MAX;
}

/**
 * Whether the user can override the metadata of this faucet.
 * The native token pays every fee, and its chain metadata is authoritative, so it is never overridden.
 */
export function canOverrideMetadata(faucetId: string): boolean {
  return faucetId !== '' && faucetId !== getNativeAssetIdSync();
}

/**
 * Applies an override to the faucet's metadata.
 * A set name or symbol replaces the faucet's value.
 * A set decimals value is a fact the user stated, so the result has a known scale.
 * This makes an unknown-placeholder token show a quantity.
 */
export function applyMetadataOverride(base: AssetMetadata, override?: TokenMetadataOverride): AssetMetadata {
  if (!override) return base;
  const result: AssetMetadata = { ...base };
  if (override.name !== undefined) result.name = override.name;
  if (override.symbol !== undefined) result.symbol = override.symbol;
  if (override.decimals !== undefined) {
    result.decimals = override.decimals;
    result.scaleIsUnknown = false;
  }
  return result;
}

/** The override of `faucetId`. Never one for the native token. */
export function overrideFor(overrides: TokenMetadataOverrides, faucetId: string): TokenMetadataOverride | undefined {
  return canOverrideMetadata(faucetId) ? overrides[faucetId] : undefined;
}

/** Applies the override of `faucetId`, if there is one, to `base`. */
export function applyOverrideFor(
  faucetId: string,
  base: AssetMetadata,
  overrides: TokenMetadataOverrides
): AssetMetadata {
  return applyMetadataOverride(base, overrideFor(overrides, faucetId));
}

/** Reads one stored override. Storage is not typed, so a field with a value that is not valid is dropped. */
function parseOverride(value: unknown): TokenMetadataOverride | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const override: TokenMetadataOverride = {};
  if ('name' in value && typeof value.name === 'string' && isValidTokenName(value.name)) override.name = value.name;
  if ('symbol' in value && typeof value.symbol === 'string' && isValidTokenSymbol(value.symbol)) {
    override.symbol = value.symbol;
  }
  if ('decimals' in value && isValidTokenDecimals(value.decimals)) override.decimals = value.decimals;
  return Object.keys(override).length > 0 ? override : undefined;
}

/** Reads the stored overrides map. A missing or malformed value gives an empty map. */
export function parseTokenMetadataOverrides(value: unknown): TokenMetadataOverrides {
  if (typeof value !== 'object' || value === null) return {};
  const overrides: TokenMetadataOverrides = {};
  for (const [faucetId, stored] of Object.entries(value)) {
    const override = parseOverride(stored);
    if (override) overrides[faucetId] = override;
  }
  return overrides;
}

export async function getTokenMetadataOverrides(): Promise<TokenMetadataOverrides> {
  return parseTokenMetadataOverrides(await fetchFromStorage<unknown>(TOKENS_METADATA_OVERRIDES_STORAGE_KEY));
}

/**
 * Stores the override of one faucet, or removes it when `override` is undefined.
 * The writes go through one queue, so two changes cannot write over each other.
 * Resolves with the stored map.
 */
export async function writeTokenMetadataOverride(
  faucetId: string,
  override: TokenMetadataOverride | undefined
): Promise<TokenMetadataOverrides> {
  if (!canOverrideMetadata(faucetId)) {
    throw new Error('The metadata of the native token cannot be overridden');
  }
  return overridesWriteQueue.add(async () => {
    const next = await getTokenMetadataOverrides();
    if (override === undefined) delete next[faucetId];
    else next[faucetId] = override;
    await putToStorage(TOKENS_METADATA_OVERRIDES_STORAGE_KEY, next);
    return next;
  });
}
