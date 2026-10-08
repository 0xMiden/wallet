import PQueue from 'p-queue';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { midenTokenLabelFor } from 'lib/remote-config/token-labels';

import { hasKnownScale } from './scale';
import { AssetMetadata } from './types';

/**
 * The display values the user set for a token. The name and symbol replace the faucet's.
 * The decimals are set only for a token whose faucet scale is unknown.
 */
export type TokenMetadataOverride = {
  name: string;
  symbol: string;
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
 * Whether `faucetId` is the native token (or no faucet). The native token pays every fee, and its chain metadata is
 * authoritative, so it is never overridden and the store keeps its entry and rows as the reader built them.
 */
export function isNativeFaucetId(faucetId: string): boolean {
  return faucetId === '' || faucetId === getNativeAssetIdSync();
}

/**
 * Whether the user can override the metadata of this faucet: never the native token's.
 * Nor is a token the wallet names itself on this network (Test iETH, Test Epoch USDC, #477): the label would
 * hide the override, so one stored for it is ignored. The bridge config is this realm's, read per call.
 */
export function canOverrideMetadata(faucetId: string): boolean {
  return !isNativeFaucetId(faucetId) && midenTokenLabelFor(getBridgeConfigSnapshot(), faucetId) === null;
}

/**
 * Applies an override to the faucet's metadata. The name and symbol replace the faucet's.
 * Stored decimals apply only where the faucet's scale is unknown, which makes an unknown-placeholder
 * token show a quantity. A known scale is never replaced: send, swap, Earn and the bridge convert
 * amounts with the faucet's decimals, so the balance rows must use them too.
 * Applying the same override to its own result changes nothing: decimals it set are a known scale by then.
 */
export function applyMetadataOverride(base: AssetMetadata, override?: TokenMetadataOverride): AssetMetadata {
  if (!override) return base;
  const result: AssetMetadata = { ...base, name: override.name, symbol: override.symbol };
  if (override.decimals !== undefined && !hasKnownScale(base)) {
    result.decimals = override.decimals;
    result.scaleIsUnknown = false;
    result.scaleFromOverride = true;
  }
  return result;
}

/** The override of `faucetId`. Never one for a faucet that `canOverrideMetadata` refuses. */
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

/**
 * Reads one stored override. Storage is not typed: a record without a valid name and symbol is dropped,
 * and decimals that are not valid are left out.
 */
function parseOverride(value: unknown): TokenMetadataOverride | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const name = 'name' in value ? value.name : undefined;
  const symbol = 'symbol' in value ? value.symbol : undefined;
  if (typeof name !== 'string' || !isValidTokenName(name)) return undefined;
  if (typeof symbol !== 'string' || !isValidTokenSymbol(symbol)) return undefined;
  const override: TokenMetadataOverride = { name, symbol };
  if ('decimals' in value && isValidTokenDecimals(value.decimals)) override.decimals = value.decimals;
  return override;
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
    throw new Error('The metadata of this token cannot be overridden');
  }
  return overridesWriteQueue.add(async () => {
    const next = await getTokenMetadataOverrides();
    if (override === undefined) delete next[faucetId];
    else next[faucetId] = override;
    await putToStorage(TOKENS_METADATA_OVERRIDES_STORAGE_KEY, next);
    return next;
  });
}
