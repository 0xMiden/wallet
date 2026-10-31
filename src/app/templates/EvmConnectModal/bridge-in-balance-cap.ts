import { useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { valuedBalanceTotal } from 'lib/miden/front/fiat-total';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { priceSymbolFor, tokenQuote } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';
import { quoteExpiryMs, usdQuoteStatus } from 'lib/prices/amount';
import { isNominalQuote, quotedPrice } from 'lib/prices/binance';
import { usdMarketPending } from 'lib/prices/feed';
import { useQuoteClock } from 'lib/prices/use-quote-clock';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectBridgeInMaxBalanceUsd } from 'lib/remote-config/values';
import { useWalletStore } from 'lib/store';

import { type DepositToken, epochTokenKey, type OfferedErc20 } from './deposit-token';

/**
 * Where a bridge-in stands against the document's balance ceiling (`limits.bridgeInMaxBalanceUsd`).
 *
 * - `none`: the document sets no ceiling, so nothing is held.
 * - `loading`: a ceiling is set and the account's holdings or the price feed are not in yet; Continue waits.
 * - `unpriced`: a ceiling is set and the feed has ruled out a price for the deposit token, so the deposit cannot be
 *   weighed against it; the deposit is refused rather than let through unvalued.
 * - `clear`: the account's valued holdings plus this deposit stay at or under the ceiling.
 * - `exceeded`: they would pass it; the deposit is refused.
 */
export type BridgeInBalanceCapVerdict =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'unpriced'; capUsd: number }
  | { state: 'clear'; capUsd: number; heldUsd: number; depositUsd: number }
  | { state: 'exceeded'; capUsd: number; heldUsd: number; depositUsd: number };

export interface BridgeInBalanceCapInput {
  /** The ceiling, or null when the document sets none. */
  capUsd: number | null;
  /** The receiving account's valued holdings in US dollars, or null while they are not in yet. */
  heldUsd: number | null;
  /** The deposit as typed, in whole tokens, or null while no valid amount is typed. */
  depositAmount: number | null;
  /** The deposit token's price in US dollars per whole token, or undefined when the feed has none. */
  depositPriceUsd: number | undefined;
  /** True while the feed may still quote a deposit token it has no price for (`usdMarketPending`). */
  depositPricePending?: boolean;
}

// Two floats summed can land a hair over an exact ceiling; anything further over is past it.
const FLOAT_NOISE_USD = 1e-9;

/** Pure: the verdict for one set of inputs. */
export function bridgeInBalanceCapVerdict({
  capUsd,
  heldUsd,
  depositAmount,
  depositPriceUsd,
  depositPricePending = false
}: BridgeInBalanceCapInput): BridgeInBalanceCapVerdict {
  if (capUsd === null) return { state: 'none' };
  if (heldUsd === null || depositAmount === null) return { state: 'loading' };
  if (depositPriceUsd === undefined || !(depositPriceUsd > 0)) {
    return depositPricePending ? { state: 'loading' } : { state: 'unpriced', capUsd };
  }
  const depositUsd = depositAmount * depositPriceUsd;
  const verdict = { capUsd, heldUsd, depositUsd };
  return heldUsd + depositUsd > capUsd + FLOAT_NOISE_USD
    ? { state: 'exceeded', ...verdict }
    : { state: 'clear', ...verdict };
}

/** A deposit token's US dollar price per whole token, and whether the feed may still quote one it has none for. */
export interface DepositTokenPrice {
  priceUsd: number | undefined;
  pending: boolean;
  /** First millisecond the quote behind `priceUsd` is stale, when it can expire. */
  expiresAt?: number;
}

/** A deposit token as the ceiling prices it: its symbol and the Miden faucet that delivers it, once one is known. */
export type DeliveredToken = Pick<OfferedErc20, 'symbol'> & { delivery?: { midenFaucetId: string } };

/**
 * Pure: the price the ceiling weighs a deposit of `token` at. USDC (Circle's, or the Epoch route's) is at par; ETH,
 * another Epoch token and an offered ERC-20 (`delivered`, the pick resolved from the offered list or the Epoch route)
 * take the feed's quote, an Epoch token's and an ERC-20's under the price symbol of the faucet that delivers it. A
 * missing or stale quote is pending until the feed supplies a fresh one or rules its market out; a token with no
 * delivery faucet or price symbol, and the nominal $1 a test network gives an unquoted token, leave it unpriced.
 */
export function depositTokenPrice(
  token: DepositToken,
  delivered: DeliveredToken | null,
  tokenPrices: TokenPrices,
  now = Date.now()
): DepositTokenPrice {
  if (token === 'CIRCLE_USDC' || epochTokenKey(token) === 'USDC') return { priceUsd: 1, pending: false };
  const priceSymbol = (() => {
    if (token === 'ETH') return 'ETH';
    if (!delivered?.delivery) return undefined;
    return priceSymbolFor(delivered.delivery.midenFaucetId, delivered.symbol);
  })();
  if (priceSymbol === undefined) return { priceUsd: undefined, pending: false };
  const quote = quotedPrice(tokenPrices, priceSymbol);
  if (quote === undefined) return { priceUsd: undefined, pending: usdMarketPending(priceSymbol) };
  // An expired quote can sit far below the market; weighing a deposit at it would clear a deposit over the ceiling.
  if (usdQuoteStatus(quote, now) === 'stale') return { priceUsd: undefined, pending: true };
  if (isNominalQuote(quote)) return { priceUsd: undefined, pending: false };
  return { priceUsd: quote.price, pending: false, expiresAt: quoteExpiryMs(quote, now) };
}

/**
 * Pure: the holdings as the Home card values them (`valuedBalanceTotal`), or null while a token that valuation would
 * price (held, known scale) still waits for its quote. A total summed before then counts that token at nothing and
 * would wave a deposit through against a balance the next quote values; a token whose market the feed has ruled out
 * at both providers has nothing to wait for.
 */
export function settledHeldUsd(
  balances: readonly TokenBalanceData[],
  tokenPrices: TokenPrices,
  now = Date.now()
): number | null {
  const pending = balances.some(token => {
    if (!(token.balance > 0) || !hasKnownScale(token.metadata)) return false;
    const quote = tokenQuote(tokenPrices, token.tokenId, token.metadata.symbol);
    // A stale quote undervalues the holdings just as a missing one does, so it waits for a fresh read too.
    if (quote) return usdQuoteStatus(quote, now) === 'stale';
    return usdMarketPending(priceSymbolFor(token.tokenId, token.metadata.symbol));
  });
  return pending ? null : valuedBalanceTotal(balances, tokenPrices).totalFiat;
}

const earliest = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/** First millisecond a quote that values a held token goes stale, if any can. */
function heldQuoteExpiry(balances: readonly TokenBalanceData[], tokenPrices: TokenPrices): number | undefined {
  let first: number | undefined;
  for (const token of balances) {
    if (!(token.balance > 0) || !hasKnownScale(token.metadata)) continue;
    first = earliest(first, quoteExpiryMs(tokenQuote(tokenPrices, token.tokenId, token.metadata.symbol)));
  }
  return first;
}

export interface UseBridgeInBalanceCapOptions {
  /** The Miden account the deposit lands in. */
  accountPublicKey: string;
  /** The deposit as typed, in whole tokens, or null while no valid amount is typed. */
  depositAmount: number | null;
  /** The deposit token's price in US dollars per whole token, or undefined when the feed has none. */
  depositPriceUsd: number | undefined;
  /** True while the feed may still quote a deposit token it has no price for (`usdMarketPending`). */
  depositPricePending: boolean;
  /** When the deposit token's quote goes stale (`DepositTokenPrice.expiresAt`), so the verdict re-checks on time. */
  depositQuoteExpiresAt?: number;
}

/**
 * The bridge-in ceiling verdict for a deposit into `accountPublicKey`, from the document's ceiling, the account's
 * holdings as the Home card values them (`valuedBalanceTotal`) and the store's price feed. The holdings read is the
 * same polled read Home makes, so a cap-less document pays for one more reader of balances already in the store.
 */
export function useBridgeInBalanceCap({
  accountPublicKey,
  depositAmount,
  depositPriceUsd,
  depositPricePending,
  depositQuoteExpiresAt
}: UseBridgeInBalanceCapOptions): BridgeInBalanceCapVerdict {
  const bridgeConfig = useBridgeConfigSnapshot();
  const capUsd = selectBridgeInMaxBalanceUsd(bridgeConfig);
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balances = [], isLoading } = useAllBalances(accountPublicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  // Quotes expire with the clock, not with a store write: wake at the first expiry among the quotes the verdict
  // reads, and read the time on every render so a verdict never outlives the quote behind it.
  useQuoteClock(earliest(heldQuoteExpiry(balances, tokenPrices), depositQuoteExpiresAt));
  if (capUsd === null) return { state: 'none' };
  const heldUsd = isLoading ? null : settledHeldUsd(balances, tokenPrices);
  return bridgeInBalanceCapVerdict({ capUsd, heldUsd, depositAmount, depositPriceUsd, depositPricePending });
}
