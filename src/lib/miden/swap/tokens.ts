import { toFixedRoundedDown } from 'lib/i18n/numbers';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import {
  getNativeAssetIdSync,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync
} from 'lib/miden-chain/native-asset';
// The pure module, not the lib/prices index: the index reaches the store, which reaches this file.
import { quotedPrice, type TokenPriceInfo, type TokenPrices } from 'lib/prices/binance';
import { isE2eFixtureSymbol } from 'lib/prices/constant';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { SwapTokenConfig } from 'lib/remote-config/schema';
import { withRequestTimeout } from 'lib/remote-json';

import { bridgePriceAllowlist } from './bridge-price-allowlist';
import { canonicalFaucetId, normalizedFaucetId } from './faucet-ids';

export { _resetNormalizedFaucetIdsForTest, canonicalFaucetId, normalizedFaucetId } from './faucet-ids';

/**
 * The swap registry: the tokens the network's bridge config lists under `swap.tokens`
 * (`0xMiden/wallet-config`, `<network>.json`), with the network's discovered native asset
 * prepended at runtime. Nothing is compiled in: a network whose document names no tokens has
 * no swap registry, and the swap entry point reads as unavailable (`swapAvailability`).
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
   * carries. The document spells a faucet in hex, so until the SDK's WASM can convert it the
   * entry carries the hex; `getSwapTokenByFaucetId` compares canonically for that reason.
   */
  faucetId: string;
  decimals: number;
  /** Symbol understood by `TokenLogo` (MIDEN/ETH/USDC/BTC) for the round logo. */
  logoSymbol: string;
  /**
   * The asset this token stands for, as the price feed names it. Set only where the feed prices
   * that asset; absent means unpriced. Never inferred from `logoSymbol`, which is only a logo.
   */
  priceSymbol?: string;
}

let _swapTokensOverride: SwapToken[] | undefined;

function configuredSwapToken(token: SwapTokenConfig): SwapToken {
  return {
    symbol: token.symbol,
    faucetId: normalizedFaucetId(token.faucetId),
    decimals: token.decimals,
    logoSymbol: token.logo ?? token.symbol,
    ...(token.priceSymbol === undefined ? {} : { priceSymbol: token.priceSymbol })
  };
}

/** The document's tokens in its order, or an E2E suite's override; never the native asset. */
function listedSwapTokens(): SwapToken[] {
  if (_swapTokensOverride) return _swapTokensOverride;
  const tokens = getBridgeConfigSnapshot().config?.swap?.tokens ?? [];
  return tokens.map(configuredSwapToken);
}

const sameFaucet = (a: string, b: string): boolean => normalizedFaucetId(a) === normalizedFaucetId(b);

/**
 * Live registry read — all consumers use this so a loaded document, and an E2E override, take
 * effect. A component reads it through `useSwapTokens`, which re-renders when the document lands.
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
      decimals: nativeMetadata.decimals,
      logoSymbol: nativeMetadata.symbol === 'USDCX' ? 'USDC' : 'MIDEN'
    },
    ...listed
  ];
};

export interface SwapPair {
  offer: SwapToken;
  request: SwapToken;
}

/**
 * The pair the swap form opens on: the document's first two tokens, in its order. Read from the
 * listed tokens and never from `getSwapTokens()`, which puts the discovered native asset first
 * once discovery has landed: seeding from that list gave a cold start into /swap a different
 * default pair than a warm one - same build, same user, different defaults on a money screen.
 * Null while the document is not loaded or names fewer than two tokens.
 */
export const getDefaultSwapPair = (): SwapPair | null => {
  const [offer, request] = listedSwapTokens();
  return offer && request ? { offer, request } : null;
};

/** Test-only setter (also driven via the E2E window hook). Pass undefined to reset. */
export const _setSwapTokensForTest = (tokens: SwapToken[] | undefined): void => {
  _swapTokensOverride = tokens;
};

/** The registry token for a faucet in any spelling of its id (a persisted row's bech32, the document's hex). */
export const getSwapTokenByFaucetId = (faucetId?: string): SwapToken | undefined =>
  faucetId ? getSwapTokens().find(token => sameFaucet(token.faucetId, faucetId)) : undefined;

export const getSwapTokenBySymbol = (symbol: string): SwapToken | undefined =>
  getSwapTokens().find(token => token.symbol === symbol);

/**
 * The faucets the wallet knows stand for a quoted asset, each with the symbol the feed prices it
 * under: the swap registry's priced tokens (IETH at ETH, IBTC at BTC), and the Earn collateral USDC and
 * the Agglayer-bridged ETH the bridge config names. Identity comes from the faucet id, never from the
 * symbol a faucet gives itself, which anyone minting a token can set (#1131).
 */
function pricedFaucets(): { faucetId: string; priceSymbol: string }[] {
  const nativeId = getNativeAssetIdSync();
  const metadata = getNativeAssetMetadataSync();
  const syncedId = !metadata || metadata.symbol === 'USDCX' ? getSdkSyncedNativeAssetIdSync() : null;
  const fixedNative =
    nativeId && syncedId && normalizedFaucetId(nativeId) === normalizedFaucetId(syncedId)
      ? [{ faucetId: nativeId, priceSymbol: 'USDCX' }]
      : [];
  return [
    ...fixedNative,
    ...getSwapTokens().flatMap(token =>
      token.priceSymbol ? [{ faucetId: token.faucetId, priceSymbol: token.priceSymbol }] : []
    ),
    ...bridgePriceAllowlist()
  ];
}

function matchPriceSymbol(
  canonicalId: string,
  symbol: string,
  canonicalize: (faucetId: string) => string
): string | undefined {
  const priced = pricedFaucets().find(entry => canonicalize(entry.faucetId) === canonicalId);
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
 * would miss and count a priced spend as nothing.
 */
export function strictPriceSymbolFor(faucetId: string, symbol: string): string | undefined {
  return matchPriceSymbol(canonicalFaucetId(faucetId), symbol, canonicalFaucetId);
}

/**
 * The distinct price symbols the allowlist matches faucets against - read by a test to catch a
 * registry token whose `priceSymbol` the feed does not quote before it ships; the spending cap
 * would otherwise refuse every spend of that faucet, and display surfaces would show it no price
 * (#1131).
 */
export function _allowlistedPriceSymbolsForTest(): string[] {
  return [...new Set(pricedFaucets().map(entry => entry.priceSymbol))];
}

/**
 * A held token's quote: its price symbol's (IETH at ETH), or none when the feed does not quote it or
 * the faucet is not one the wallet prices. A token without a faucet id has no quote.
 */
export function tokenQuote(
  prices: TokenPrices,
  faucetId: string | undefined,
  symbol: string
): TokenPriceInfo | undefined {
  return faucetId ? quotedPrice(prices, priceSymbolFor(faucetId, symbol)) : undefined;
}

/**
 * A single quote for an (offered, requested) pair from the DEX `swap-eta`
 * endpoint. It rolls the oracle fair rate together with live fill signals, so
 * the swap flow needs just this one call instead of two per-token price fetches.
 */
export interface SwapEta {
  /** Does the order cross resting liquidity right now (at the asked price)? */
  canFill: boolean;
  /** Next-batch ETA in seconds, set when `canFill` is true. */
  estimatedSeconds: number | null;
  /** Is the asked price worse than the live oracle? */
  offMarket: boolean;
  /** Oracle fair rate: requested whole tokens per 1 offered whole token. */
  marketPrice: string;
  /** Median settle time (s) for this pair over the last 24h, null if no data. */
  median24hSeconds: number | null;
}

/**
 * Fetch a `SwapEta` for an offered → requested pair from the quote service the
 * network's bridge config names (`swap.etaUrl`). Amounts are raw base units
 * (bigint); faucets are converted to their canonical hex account ids. The
 * oracle `marketPrice` is amount-independent, so passing `0n` for
 * `requestAmountRaw` still returns a usable rate to seed the receive field.
 * Rejects at once, with no request, while the document names no service: the
 * form then reads the quote as unavailable and takes the amounts by hand.
 */

/** Abort a quote request whose response and body have not both arrived within this window. */
const SWAP_ETA_FETCH_TIMEOUT_MS = 10_000;

/** Thrown by `getSwapEta` while the accepted document names no quote service. */
export class SwapEtaUnavailableError extends Error {
  constructor() {
    super('The bridge config names no swap quote service (swap.etaUrl).');
    this.name = 'SwapEtaUnavailableError';
  }
}

export async function getSwapEta(
  offerToken: SwapToken,
  offerAmountRaw: bigint,
  requestToken: SwapToken,
  requestAmountRaw: bigint
): Promise<SwapEta> {
  const etaUrl = getBridgeConfigSnapshot().config?.swap?.etaUrl;
  if (etaUrl === undefined) throw new SwapEtaUnavailableError();
  const params = new URLSearchParams({
    offered_faucet: accountIdStringToSdk(offerToken.faucetId).toString(),
    offered_amount: offerAmountRaw.toString(),
    requested_faucet: accountIdStringToSdk(requestToken.faucetId).toString(),
    requested_amount: requestAmountRaw.toString()
  });

  return withRequestTimeout(SWAP_ETA_FETCH_TIMEOUT_MS, async signal => {
    const res = await fetch(`${etaUrl}/v1/swap-eta?${params.toString()}`, { signal });
    if (!res.ok) {
      throw new Error(`Swap ETA request failed for ${offerToken.symbol}→${requestToken.symbol}: ${res.status}`);
    }
    const json: SwapEta = await res.json();
    return json;
  });
}

/**
 * Fraction shaved off the fair USD-derived quote so a filler/solver that
 * consumes the PSWAP note has margin to do so profitably. The user receives
 * `1 - SOLVER_MARGIN` of the price-fair amount.
 */
export const SOLVER_MARGIN = 0.05;

/**
 * Derive the requested-token amount from the offered amount and the oracle
 * `marketPrice` (requested whole tokens per 1 offered whole token): the fair
 * quote is `offered * marketPrice`, discounted by `SOLVER_MARGIN` so a filler
 * has margin to take the order. Rounded down to the requested token's
 * precision; returns '' when the inputs aren't usable yet (no amount, no rate,
 * or a non-positive result).
 */
export function deriveRequestAmount(offerAmount: string, marketPrice: string | undefined, decimals: number): string {
  const offered = Number(offerAmount);
  const rate = Number(marketPrice);
  if (!offered || !rate || !Number.isFinite(rate)) {
    return '';
  }
  const quote = offered * rate * (1 - SOLVER_MARGIN);
  if (!Number.isFinite(quote) || quote <= 0) {
    return '';
  }
  const formatted = toFixedRoundedDown(quote, decimals).replace(/\.?0+$/, '');
  return formatted === '0' ? '' : formatted;
}
