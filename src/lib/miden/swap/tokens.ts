import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import {
  getNativeAssetIdSync,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync
} from 'lib/miden-chain/native-asset';
// The pure module, not the lib/prices index: the index reaches the store, which reaches this file.
import { quotedPrice, type TokenPriceInfo, type TokenPrices } from 'lib/prices/binance';
import { isE2eFixtureSymbol } from 'lib/prices/constant';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { SwapPairsToken } from 'lib/remote-config/swap-pairs';
import { selectSwapPairs } from 'lib/remote-config/values';
import { peekTokenPriceAssets } from 'lib/token-list/runtime';

import { bridgePriceAllowlist, type PricedFaucet } from './bridge-price-allowlist';
import { canonicalFaucetId, normalizedFaucetId } from './faucet-ids';

export { _resetNormalizedFaucetIdsForTest, canonicalFaucetId, normalizedFaucetId } from './faucet-ids';

/**
 * The swap registry: the tokens the DEX solver lists (`GET /v2/pairs` on the host the network's
 * bridge config names under `swap.etaUrl`, read with the config's derived values), with the
 * network's discovered native asset prepended at runtime. Nothing is compiled in: a network
 * whose document names no solver, or whose solver lists no pair, has no swap registry, and the
 * swap entry point reads as unavailable (`swapAvailability`).
 *
 * The user enters a human-readable amount and `stringToBigInt(amount, token.decimals)` converts
 * it to base units, so each entry's `decimals` must be the faucet's real on-chain decimals: a
 * mismatch would scale its offered/requested amount by `10^(diff)`. The native entry instead
 * uses its discovered metadata.
 *
 * Shared between the swap flow (token picker + amount/quote logic) and the
 * Generating-transaction summary badge (resolving symbol/logo/decimals for a
 * persisted swap tx, whose `faucetId`/`extraInputs.requestedFaucetId` are the bech32
 * strings the registry carried when the swap was made).
 */
export interface SwapToken {
  symbol: string;
  /**
   * The SDK's bech32 form of the faucet id, the form every persisted row and balance key
   * carries. The solver spells a faucet in hex, so until the SDK's WASM can convert it the
   * entry carries the hex; `getSwapTokenByFaucetId` compares canonically for that reason.
   */
  faucetId: string;
  decimals: number;
  /**
   * The asset this token stands for, as the price feed names it. Set only where the feed prices
   * that asset; absent means unpriced. Never inferred from the ticker.
   */
  priceSymbol?: string;
}

let _swapTokensOverride: SwapToken[] | undefined;
let swapTokensVersion = 0;
const swapTokenListeners = new Set<() => void>();

export const getSwapTokensVersion = (): number => swapTokensVersion;

/** Subscribe to override changes even when the bridge-config snapshot stays the same. */
export const subscribeSwapTokens = (listener: () => void): (() => void) => {
  swapTokenListeners.add(listener);
  return () => {
    swapTokenListeners.delete(listener);
  };
};

// A faucet the reviewed document prices (bridged ETH, the Earn USDC) keeps the document's symbol: the solver's
// assets can be stand-ins, and every reader of a token's price must agree with the spending cap.
function listedSwapToken(token: SwapPairsToken, allowlist: readonly PricedFaucet[]): SwapToken {
  const faucetId = normalizedFaucetId(token.faucetId);
  const priceSymbol =
    allowlist.find(entry => normalizedFaucetId(entry.faucetId) === faucetId)?.priceSymbol ?? token.binanceAsset;
  return {
    symbol: token.ticker,
    faucetId,
    decimals: token.decimals,
    ...(priceSymbol === undefined ? {} : { priceSymbol })
  };
}

/** The solver's tokens in its order, or an E2E suite's override; never the native asset. */
function listedSwapTokens(): SwapToken[] {
  if (_swapTokensOverride) return _swapTokensOverride;
  const tokens = selectSwapPairs(getBridgeConfigSnapshot())?.tokens ?? [];
  const allowlist = bridgePriceAllowlist();
  return tokens.map(token => listedSwapToken(token, allowlist));
}

const sameFaucet = (a: string, b: string): boolean => normalizedFaucetId(a) === normalizedFaucetId(b);

/**
 * Live registry read — all consumers use this so a loaded registry, and an E2E override, take
 * effect. A component reads it through `useSwapTokens`, which re-renders when the registry lands.
 *
 * The native asset ID is network-derived and may not be available during the
 * first render. Once discovery populates the synchronous cache, put MIDEN ahead
 * of the listed tokens. Callers naturally re-read this accessor on their next
 * render (for example, when opening the token drawer).
 */
export const getSwapTokens = (): SwapToken[] => {
  const listed = listedSwapTokens();
  if (_swapTokensOverride) return listed;

  const nativeAssetId = getNativeAssetIdSync();
  if (!nativeAssetId || listed.some(token => sameFaucet(token.faucetId, nativeAssetId))) return listed;

  const nativeMetadata = getNativeAssetMetadataSync();
  if (!nativeMetadata || !hasKnownScale({ ...nativeMetadata, name: nativeMetadata.symbol })) return listed;
  return [
    {
      symbol: nativeMetadata.symbol,
      faucetId: nativeAssetId,
      decimals: nativeMetadata.decimals
    },
    ...listed
  ];
};

/**
 * The tokens `faucetId` swaps with: every token that shares a solver pair with it, in the
 * registry's order. A pair swaps in both directions, so this is the "To" list for a "From" token
 * and the reverse. A token in no pair (a native asset the solver does not list) has none. An E2E
 * override has no pairs, so there every other token is a partner.
 */
export const getSwapPartners = (faucetId: string): SwapToken[] => {
  const others = getSwapTokens().filter(token => !sameFaucet(token.faucetId, faucetId));
  if (_swapTokensOverride) return others;
  const pairs = selectSwapPairs(getBridgeConfigSnapshot())?.pairs ?? [];
  const partnerIds = pairs
    .filter(pair => pair.faucetIds.some(id => sameFaucet(id, faucetId)))
    .flatMap(pair => pair.faucetIds.filter(id => !sameFaucet(id, faucetId)));
  return others.filter(token => partnerIds.some(id => sameFaucet(id, token.faucetId)));
};

/** Whether the solver lists a pair of these two faucets, in any spelling of either id. */
export const isSwapPair = (faucetId: string, otherFaucetId: string): boolean =>
  getSwapPartners(faucetId).some(token => sameFaucet(token.faucetId, otherFaucetId));

export interface SwapPair {
  offer: SwapToken;
  request: SwapToken;
}

/**
 * The pair the swap form opens on. The pay side is the network's native asset (USDCX on testnet,
 * discovered in `lib/miden-chain/native-asset`) and the receive side its first partner, when the
 * solver lists a pair of the native asset. Else it is the solver's first pair, in the order the
 * pair names its faucets: that is also the pair a cold start shows until discovery of the native
 * asset has landed, which happens once per network, since the id is stored. An E2E override has
 * no pairs, so there it is the override's first two tokens.
 * Null while the registry is not loaded or lists no pair.
 */
export const getDefaultSwapPair = (): SwapPair | null => {
  const listed = listedSwapTokens();
  if (_swapTokensOverride) {
    const [offer, request] = listed;
    return offer && request ? { offer, request } : null;
  }
  const nativeId = getNativeAssetIdSync();
  const native = nativeId ? getSwapTokenByFaucetId(nativeId) : undefined;
  const [nativePartner] = nativeId ? getSwapPartners(nativeId) : [];
  if (native && nativePartner) return { offer: native, request: nativePartner };
  const firstPair = selectSwapPairs(getBridgeConfigSnapshot())?.pairs[0];
  const [offer, request] = (firstPair?.faucetIds ?? []).map(faucetId =>
    listed.find(token => sameFaucet(token.faucetId, faucetId))
  );
  return offer && request ? { offer, request } : null;
};

/** Test-only setter (also driven via the E2E window hook). Pass undefined to reset. */
export const _setSwapTokensForTest = (tokens: SwapToken[] | undefined): void => {
  _swapTokensOverride = tokens;
  swapTokensVersion++;
  for (const listener of swapTokenListeners) listener();
};

/** The registry token for a faucet in any spelling of its id (a persisted row's bech32, the solver's hex). */
export const getSwapTokenByFaucetId = (faucetId?: string): SwapToken | undefined =>
  faucetId ? getSwapTokens().find(token => sameFaucet(token.faucetId, faucetId)) : undefined;

export const getSwapTokenBySymbol = (symbol: string): SwapToken | undefined =>
  getSwapTokens().find(token => token.symbol === symbol);

/** The native fixed quote, verified list assets, then bridge entries. Faucet identity sets coverage. */
function pricedFaucets(network: string = getEffectiveNetworkName()): { faucetId: string; priceSymbol: string }[] {
  const nativeId = getNativeAssetIdSync();
  const metadata = getNativeAssetMetadataSync();
  const syncedId = !metadata || metadata.symbol === 'USDCX' ? getSdkSyncedNativeAssetIdSync() : null;
  const fixedNative =
    nativeId && syncedId && normalizedFaucetId(nativeId) === normalizedFaucetId(syncedId)
      ? [{ faucetId: nativeId, priceSymbol: 'USDCX' }]
      : [];
  return [
    ...fixedNative,
    ...Array.from(peekTokenPriceAssets(network) ?? [], ([faucetId, priceSymbol]) => ({
      faucetId,
      priceSymbol
    })),
    ...bridgePriceAllowlist()
  ];
}

function matchPriceSymbol(
  canonicalId: string,
  symbol: string,
  canonicalize: (faucetId: string) => string,
  network?: string
): string | undefined {
  const priced = pricedFaucets(network).find(entry => canonicalize(entry.faucetId) === canonicalId);
  if (priced) return priced.priceSymbol;
  return isE2eFixtureSymbol(symbol) ? symbol : undefined;
}

/**
 * The symbol to look a held token's price up under, when the faucet and an allowlist entry reduce to
 * one canonical id, whichever encoding each is spelled in; none for any other faucet, whatever its
 * own symbol. The one exception is the E2E harness's fixture symbol, priced by symbol in E2E builds
 * only. For display: an id the SDK cannot parse is compared as its raw text.
 */
export function priceSymbolFor(faucetId: string, symbol: string): string | undefined {
  return matchPriceSymbol(normalizedFaucetId(faucetId), symbol, normalizedFaucetId);
}

/**
 * `priceSymbolFor` for the spending cap, over any spelling of the spend's faucet id. The spend's id
 * and every allowlist entry are canonicalized when it runs, under one network, so an id canonicalized
 * before a network switch still matches.
 * Either side the SDK cannot parse throws rather than dropping out of the match, since its raw text
 * would miss and count a priced spend as nothing. `network` names the verified list to match, so a
 * valuation keeps the list of the network it started on.
 */
export function strictPriceSymbolFor(faucetId: string, symbol: string, network?: string): string | undefined {
  return matchPriceSymbol(canonicalFaucetId(faucetId), symbol, canonicalFaucetId, network);
}

/** The distinct assets for the current network. The first entry for each faucet wins. */
export function getPriceAssets(): Map<string, string> {
  const assets = new Map<string, string>();
  for (const entry of pricedFaucets()) {
    const id = normalizedFaucetId(entry.faucetId);
    if (!assets.has(id)) assets.set(id, entry.priceSymbol);
  }
  return assets;
}

export function getPriceSymbols(): string[] {
  return [...new Set(getPriceAssets().values())];
}

export const _allowlistedPriceSymbolsForTest = getPriceSymbols;

/**
 * A held token's quote uses its verified price asset, or none when the feed does not quote it or
 * the faucet is not one the wallet prices. A token without a faucet id has no quote.
 */
export function tokenQuote(
  prices: TokenPrices,
  faucetId: string | undefined,
  symbol: string
): TokenPriceInfo | undefined {
  return faucetId ? quotedPrice(prices, priceSymbolFor(faucetId, symbol)) : undefined;
}
