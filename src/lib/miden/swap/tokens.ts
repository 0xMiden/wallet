import { MIDEN_AGGLAYER_FAUCET_ID } from 'lib/agglayer/b2agg/constant';
import { getEarnCollateralFaucet } from 'lib/epoch/collateral';
import { toFixedRoundedDown } from 'lib/i18n/numbers';
import { MIDEN_METADATA } from 'lib/miden/metadata/defaults';
import { accountIdStringToSdk, accountRefToSdk, getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';
// The pure module, not the lib/prices index: the index reaches the store, which reaches this file.
import { quotedPrice, type TokenPriceInfo, type TokenPrices } from 'lib/prices/binance';
import { isE2eFixtureSymbol } from 'lib/prices/constant';
import { withRequestTimeout } from 'lib/remote-json';

/**
 * Swap starts with this fixed set of Miden testnet 0.16 DEX tokens and prepends the
 * network's discovered native asset at runtime. The fixed test tokens use
 * 8 decimals (`SWAP_TOKEN_DECIMALS`): the user enters a human-readable amount
 * and `stringToBigInt(amount, token.decimals)` converts it to base units.
 *
 * INVARIANT: `SWAP_TOKEN_DECIMALS` must match each fixed test faucet's real
 * on-chain decimals. A mismatch would scale its offered/requested amount by
 * `10^(diff)`. The native entry instead uses its discovered metadata (falling
 * back to the wallet's native metadata).
 *
 * Shared between the swap flow (token picker + amount/quote logic) and the
 * Generating-transaction summary badge (resolving symbol/logo/decimals for a
 * persisted swap tx, whose `faucetId`/`extraInputs.requestedFaucetId` are the
 * `mtst1…` strings below).
 */
export interface SwapToken {
  symbol: string;
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

export const SWAP_TOKEN_DECIMALS = 8;

export const TOKEN_IMIDEN: SwapToken = {
  symbol: 'IMIDEN',
  faucetId: 'mtst1arqxg9er3xclayt95nud82jnpggl9azj',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'MIDEN'
};
export const TOKEN_IETH: SwapToken = {
  symbol: 'IETH',
  faucetId: 'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'ETH',
  priceSymbol: 'ETH'
};
export const TOKEN_IBTC: SwapToken = {
  symbol: 'IBTC',
  faucetId: 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'BTC',
  priceSymbol: 'BTC'
};
export const TOKEN_IUSDT: SwapToken = {
  symbol: 'IUSDT',
  faucetId: 'mtst1arvdwvzllvg3s5fzjle7nkljeuhkcufr',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'USDC'
};

export const SWAP_TOKENS: SwapToken[] = [TOKEN_IMIDEN, TOKEN_IETH, TOKEN_IUSDT, TOKEN_IBTC];

let _swapTokensOverride: SwapToken[] | undefined;

/**
 * Live registry read — all consumers use this so an E2E override takes effect.
 *
 * The native asset ID is network-derived and may not be available during the
 * first render. Once discovery populates the synchronous cache, put MIDEN ahead
 * of the fixed DEX test tokens. Callers naturally re-read this accessor
 * on their next render (for example, when opening the token drawer).
 */
export const getSwapTokens = (): SwapToken[] => {
  if (_swapTokensOverride) return _swapTokensOverride;

  const nativeAssetId = getNativeAssetIdSync();
  if (!nativeAssetId || SWAP_TOKENS.some(token => token.faucetId === nativeAssetId)) return SWAP_TOKENS;

  const nativeMetadata = getNativeAssetMetadataSync();
  return [
    {
      symbol: nativeMetadata?.symbol ?? MIDEN_METADATA.symbol,
      faucetId: nativeAssetId,
      decimals: nativeMetadata?.decimals ?? MIDEN_METADATA.decimals,
      logoSymbol: 'MIDEN'
    },
    ...SWAP_TOKENS
  ];
};

/**
 * The pair the swap form opens on. Chosen by SYMBOL, never by list position:
 * `getSwapTokens()` puts the discovered native asset first once discovery has
 * landed, so seeding from index 0/1 gave a cold start into /swap a different
 * default pair than a warm one - same build, same user, different defaults on a
 * money screen. Falls back to the fixed list when a symbol is not present.
 */
export const getDefaultSwapPair = (): { offer: SwapToken; request: SwapToken } => {
  const tokens = getSwapTokens();
  const bySymbol = (symbol: string) => tokens.find(token => token.symbol === symbol);
  const offer = bySymbol(TOKEN_IMIDEN.symbol) ?? tokens[0]!;
  const request = bySymbol(TOKEN_IETH.symbol) ?? tokens[1]!;
  return { offer, request };
};

/** Test-only setter (also driven via the E2E window hook). Pass undefined to reset. */
export const _setSwapTokensForTest = (tokens: SwapToken[] | undefined): void => {
  _swapTokensOverride = tokens;
};

export const getSwapTokenByFaucetId = (faucetId?: string): SwapToken | undefined =>
  faucetId ? getSwapTokens().find(token => token.faucetId === faucetId) : undefined;

export const getSwapTokenBySymbol = (symbol: string): SwapToken | undefined =>
  getSwapTokens().find(token => token.symbol === symbol);

// Keyed by the network name getNetworkId derives from: the NetworkId object itself does not
// stringify. Only a parsed id is stored, so a failed parse is retried once the SDK can parse the id.
const normalizedFaucetIds = new Map<string, string>();

/** Test-only: forget every cached conversion. */
export const _resetNormalizedFaucetIdsForTest = (): void => normalizedFaucetIds.clear();

/**
 * The SDK's bech32 form of a faucet id in any encoding (hex, bech32 or the composite
 * `<address>_<suffix>`), so every spelling of one faucet reduces to one id. Throws when the SDK
 * cannot parse the id, as it does for every id until its WASM has loaded.
 */
export function canonicalFaucetId(faucetId: string): string {
  const key = `${getEffectiveNetworkName()}:${faucetId}`;
  const cached = normalizedFaucetIds.get(key);
  if (cached !== undefined) return cached;
  const canonical = getBech32AddressFromAccountId(accountRefToSdk(faucetId));
  normalizedFaucetIds.set(key, canonical);
  return canonical;
}

/** The balance store's key for a faucet id: its canonical id, or the raw id if the SDK cannot parse it yet. */
export function normalizedFaucetId(faucetId: string): string {
  try {
    return canonicalFaucetId(faucetId);
  } catch {
    return faucetId;
  }
}

/**
 * The faucets the wallet knows stand for a quoted asset, each with the symbol the feed prices it
 * under: the swap registry's priced tokens (IETH at ETH, IBTC at BTC), the Earn collateral USDC and
 * the Agglayer-bridged ETH. Identity comes from the faucet id, never from the symbol a faucet gives
 * itself, which anyone minting a token can set (#1131).
 */
function pricedFaucets(): { faucetId: string; priceSymbol: string }[] {
  return [
    ...getSwapTokens().flatMap(token =>
      token.priceSymbol ? [{ faucetId: token.faucetId, priceSymbol: token.priceSymbol }] : []
    ),
    { faucetId: getEarnCollateralFaucet(), priceSymbol: 'USDC' },
    { faucetId: MIDEN_AGGLAYER_FAUCET_ID, priceSymbol: 'ETH' }
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
 * `priceSymbolFor` for the spending cap, over an id `canonicalFaucetId` produced. An allowlist entry
 * the SDK cannot parse throws rather than dropping out of the match, since its raw text would miss
 * the spend and count a priced spend as nothing.
 */
export function strictPriceSymbolFor(canonicalId: string, symbol: string): string | undefined {
  return matchPriceSymbol(canonicalId, symbol, canonicalFaucetId);
}

/**
 * The distinct price symbols the allowlist matches faucets against - read by a test to catch a
 * registry token whose `priceSymbol` the feed does not quote before it ships; the spending cap
 * would otherwise refuse every spend of that faucet, and display surfaces would show it no price
 * (#1131).
 */
export function allowlistedPriceSymbols(): string[] {
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
 * Fetch a `SwapEta` for an offered → requested pair. Amounts are raw base units
 * (bigint); faucets are converted to their canonical hex account ids. The
 * oracle `marketPrice` is amount-independent, so passing `0n` for
 * `requestAmountRaw` still returns a usable rate to seed the receive field.
 *
 * TODO: hardcoded devnet host — move to per-network config before any
 * non-devnet use so quotes point at the correct feed for the active network.
 */
const SWAP_ETA_BASE_URL = 'https://35-175-40-181.sslip.io';

/** Abort a quote request whose response and body have not both arrived within this window. */
const SWAP_ETA_FETCH_TIMEOUT_MS = 10_000;

export async function getSwapEta(
  offerToken: SwapToken,
  offerAmountRaw: bigint,
  requestToken: SwapToken,
  requestAmountRaw: bigint
): Promise<SwapEta> {
  const params = new URLSearchParams({
    offered_faucet: accountIdStringToSdk(offerToken.faucetId).toString(),
    offered_amount: offerAmountRaw.toString(),
    requested_faucet: accountIdStringToSdk(requestToken.faucetId).toString(),
    requested_amount: requestAmountRaw.toString()
  });

  return withRequestTimeout(SWAP_ETA_FETCH_TIMEOUT_MS, async signal => {
    const res = await fetch(`${SWAP_ETA_BASE_URL}/v1/swap-eta?${params.toString()}`, { signal });
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
