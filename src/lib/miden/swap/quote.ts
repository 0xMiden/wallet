import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { withRequestTimeout } from 'lib/remote-json';

import { BPS_DENOMINATOR, isValidSlippageBps } from './slippage-bounds';
import type { SwapToken } from './tokens';

/**
 * The Swap Quote API v2 client (the PSWAP solver's `/v2/pair-price` and `/v2/swap-eta`).
 *
 * The swap flow asks two questions before the user signs:
 * 1. `getSwapPairPrice`: the most the order can ask per offered token and still fill (`fillPrice`).
 * 2. `getSwapEta`: what the solver does with the exact order right now, and how long it takes.
 *
 * `quoteSwap` runs them in order and builds the ask between them. Every amount is a `bigint` in
 * base units; every price is the decimal string the service sends. Nothing here goes through a
 * float: the ask is `floor(offered × fillPrice × (1 − slippage))` in integer arithmetic.
 */

/** Abort a quote request whose response and body have not both arrived within this window. */
const SWAP_QUOTE_FETCH_TIMEOUT_MS = 10_000;

export {
  BPS_DENOMINATOR,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  isValidSlippageBps,
  MAX_SWAP_SLIPPAGE_BPS,
  MIN_SWAP_SLIPPAGE_BPS
} from './slippage-bounds';

/** A quote older than this is rebuilt before it is shown again or signed. */
export const SWAP_QUOTE_REFRESH_MS = 30_000;

/** The `error` codes the service names. `message` is for people and may change; `code` is stable. */
export type SwapQuoteErrorCode =
  | 'bad_faucet_id'
  | 'bad_amount'
  | 'bad_request'
  | 'unknown_faucet'
  | 'no_market'
  | 'no_price'
  | 'overloaded'
  | 'timeout'
  | 'decimals_mismatch'
  | 'unavailable'
  | 'unknown';

const KNOWN_CODES: readonly SwapQuoteErrorCode[] = [
  'bad_faucet_id',
  'bad_amount',
  'bad_request',
  'unknown_faucet',
  'no_market',
  'no_price',
  'overloaded'
];

function isKnownCode(value: unknown): value is SwapQuoteErrorCode {
  return typeof value === 'string' && KNOWN_CODES.some(code => code === value);
}

/** A quote request the service refused, with the stable `code` it gave and the HTTP status. */
export class SwapQuoteError extends Error {
  readonly code: SwapQuoteErrorCode;
  readonly status: number | undefined;

  constructor(code: SwapQuoteErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SwapQuoteError';
    this.code = code;
    this.status = status;
  }
}

/** The `code` a quote failure carries, or `unknown` for an error that is not a `SwapQuoteError`. */
export function swapQuoteErrorCode(error: unknown): SwapQuoteErrorCode {
  return error instanceof SwapQuoteError ? error.code : 'unknown';
}

/** Thrown while the accepted document names no quote service (`swap.etaUrl`). */
export class SwapEtaUnavailableError extends SwapQuoteError {
  constructor() {
    super('unavailable', 'The bridge config names no swap quote service (swap.etaUrl).');
    this.name = 'SwapEtaUnavailableError';
  }
}

/** `GET /v2/pair-price`: the pair's clearing price per whole OFFERED token. */
export interface SwapPairPrice {
  offeredFaucet: string;
  requestedFaucet: string;
  /** Binance mid, in whole requested tokens per whole offered token. */
  marketPrice: string;
  /** The most an ask can name per offered token and still fill now; the fee is already in it. Build the ask from this. */
  fillPrice: string;
  /** The clearing fee in parts per million. */
  feePpm: number;
  offeredDecimals: number;
  requestedDecimals: number;
  /** Unix seconds when the solver received the Binance quote. */
  asOf: number;
}

export type SwapPriceBand = 'at_market' | 'tolerated' | 'off_market';
export type SwapFillStatus = 'full' | 'partial' | 'none';
export type SwapFillReason = 'price' | 'liquidity' | 'no_market' | 'no_price';

/** `GET /v2/swap-eta`: what the solver would do with the order right now. Optional fields are `null`, never left out. */
export interface SwapEta {
  offeredFaucet: string;
  requestedFaucet: string;
  offeredAmount: string;
  requestedAmount: string;
  /** How the ask compares with `fillPrice`; `null` without a price. */
  priceBand: SwapPriceBand | null;
  fillStatus: SwapFillStatus;
  /** Why a `none` fill; `null` otherwise. */
  reason: SwapFillReason | null;
  fillableOfferedAmount: string;
  fillableRequestedAmount: string;
  /** The most of the offered token an order at this rate fills now; `null` when off market or without a price. */
  maxOfferedAmount: string | null;
  /** What a full fill pays at the current price, never less than `requestedAmount`; `null` without a price. */
  expectedRequestedAmount: string | null;
  feePpm: number;
  feeAmount: string | null;
  marketPrice: string | null;
  fillPrice: string | null;
  /** `false` while the solver cannot settle; orders wait. */
  settlementsRunning: boolean;
  /** Time to the next batch when the order is `at_market` and fills fully or partly. */
  estimatedSeconds: number | null;
  /** The pair's median settlement time over the last 24 hours. */
  median24hSeconds: number | null;
}

/**
 * A price, the ask built from it (or the user's own), and the solver's verdict on that ask. It
 * carries the inputs it was built from, so a caller can tell a quote for the inputs on screen from
 * one the hook kept on screen while a newer set reloads.
 */
export interface SwapQuote {
  price: SwapPairPrice;
  /** The offered amount the quote was built for, in offered base units. */
  offeredAmount: bigint;
  /** The ask `eta` was checked with, in requested base units. */
  requestedAmount: bigint;
  /** The wallet built `requestedAmount` from the price at `slippageBps`; false for a user's own ask. */
  builtAsk: boolean;
  slippageBps: number;
  eta: SwapEta;
  /** `Date.now()` when the price was fetched; the refresh timer counts from it. */
  fetchedAt: number;
}

/**
 * The verdict the review screen shows, in the service's priority order: the first row that
 * matches wins. `full` is the one that fills now at the current price.
 */
export type SwapVerdict =
  | 'settlement-delayed'
  | 'no-market'
  | 'no-price'
  | 'off-market'
  | 'no-liquidity'
  | 'tolerated'
  | 'partial'
  | 'full';

export function swapVerdict(eta: SwapEta): SwapVerdict {
  if (!eta.settlementsRunning) return 'settlement-delayed';
  switch (eta.reason) {
    case 'no_market':
      return 'no-market';
    case 'no_price':
      return 'no-price';
    default:
      break;
  }
  if (eta.priceBand === 'off_market') return 'off-market';
  if (eta.fillStatus === 'none') return 'no-liquidity';
  if (eta.priceBand === 'tolerated') return 'tolerated';
  if (eta.fillStatus === 'partial') return 'partial';
  return 'full';
}

/** The i18n key for each verdict. */
export const SWAP_VERDICT_LABEL_KEYS: Record<SwapVerdict, string> = {
  'settlement-delayed': 'swapVerdictSettlementDelayed',
  'no-market': 'swapVerdictNoMarket',
  'no-price': 'swapVerdictNoPrice',
  'off-market': 'swapVerdictOffMarket',
  'no-liquidity': 'swapVerdictNoLiquidity',
  tolerated: 'swapVerdictTolerated',
  partial: 'swapVerdictPartial',
  full: 'swapVerdictFull'
};

/** A verdict the flow refuses to sign on. The rest are advisory: on testnet `no-liquidity` is the usual pre-sign answer. */
export const swapVerdictBlocksSubmit = (verdict: SwapVerdict): boolean => {
  switch (verdict) {
    case 'no-market':
    case 'no-price':
    case 'off-market':
      return true;
    default:
      return false;
  }
};

/** `"2489.52051775"` → `2489520517750000000000n`: the decimal scaled by 10^18, extra digits dropped. */
export function scale18(decimal: string): bigint {
  const match = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(decimal);
  if (!match) throw new SwapQuoteError('bad_amount', `Cannot scale "${decimal}" as a price`);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18));
}

/**
 * The ask: `floor(offered × fillPrice × (1 − slippage) × 10^requestedDecimals / 10^offeredDecimals)`,
 * all in integers, as the integration guide specifies. The price's own decimals are used, not the
 * registry's, and `quoteSwap` has already refused a price whose decimals disagree with the tokens.
 */
export function buildRequestedAmount(offeredAmount: bigint, price: SwapPairPrice, slippageBps: number): bigint {
  if (!isValidSlippageBps(slippageBps)) {
    throw new SwapQuoteError('bad_amount', `Slippage ${slippageBps} bps is outside the accepted range`);
  }
  const numerator =
    offeredAmount *
    scale18(price.fillPrice) *
    (BPS_DENOMINATOR - BigInt(slippageBps)) *
    10n ** BigInt(price.requestedDecimals);
  const denominator = 10n ** 18n * BPS_DENOMINATOR * 10n ** BigInt(price.offeredDecimals);
  return numerator / denominator;
}

function quoteBaseUrl(): string {
  const etaUrl = getBridgeConfigSnapshot().config?.swap?.etaUrl;
  if (etaUrl === undefined) throw new SwapEtaUnavailableError();
  return etaUrl;
}

/**
 * One bounded request to the service. A refused request becomes a `SwapQuoteError` carrying the
 * body's `error` code; a 408 has no body and reads as `timeout`.
 */
async function getQuoteJson<T>(path: string, params: URLSearchParams): Promise<T> {
  const url = `${quoteBaseUrl()}${path}?${params.toString()}`;
  return withRequestTimeout(SWAP_QUOTE_FETCH_TIMEOUT_MS, async signal => {
    const res = await fetch(url, { signal });
    if (res.ok) {
      const json: T = await res.json();
      return json;
    }
    const body: { error?: unknown; message?: unknown } = await res.json().catch(() => ({}));
    const code: SwapQuoteErrorCode = isKnownCode(body.error) ? body.error : res.status === 408 ? 'timeout' : 'unknown';
    const message = typeof body.message === 'string' ? body.message : `Swap quote request failed: ${res.status}`;
    throw new SwapQuoteError(code, message, res.status);
  });
}

const faucetParam = (token: SwapToken): string => accountIdStringToSdk(token.faucetId).toString();

/** `GET /v2/pair-price` for an offered → requested pair. Rejects with `no_market` or `no_price` as the service does. */
export async function getSwapPairPrice(offerToken: SwapToken, requestToken: SwapToken): Promise<SwapPairPrice> {
  const params = new URLSearchParams({
    offered_faucet: faucetParam(offerToken),
    requested_faucet: faucetParam(requestToken)
  });
  return getQuoteJson<SwapPairPrice>('/v2/pair-price', params);
}

/** `GET /v2/swap-eta` for the exact order the wallet is about to sign. Answers 200 even without a price. */
export async function getSwapEta(
  offerToken: SwapToken,
  offerAmountRaw: bigint,
  requestToken: SwapToken,
  requestAmountRaw: bigint
): Promise<SwapEta> {
  const params = new URLSearchParams({
    offered_faucet: faucetParam(offerToken),
    offered_amount: offerAmountRaw.toString(),
    requested_faucet: faucetParam(requestToken),
    requested_amount: requestAmountRaw.toString()
  });
  return getQuoteJson<SwapEta>('/v2/swap-eta', params);
}

/** A price whose decimals disagree with the registry would scale the ask by 10^(diff), so it is refused. */
function assertDecimalsMatch(price: SwapPairPrice, offerToken: SwapToken, requestToken: SwapToken): void {
  if (price.offeredDecimals !== offerToken.decimals || price.requestedDecimals !== requestToken.decimals) {
    throw new SwapQuoteError(
      'decimals_mismatch',
      `The quote service reports ${price.offeredDecimals}/${price.requestedDecimals} decimals for ` +
        `${offerToken.symbol}/${requestToken.symbol}; the registry says ${offerToken.decimals}/${requestToken.decimals}`
    );
  }
}

export interface QuoteSwapOptions {
  /**
   * The user's own ask, in requested base units, when they edited the receive field. Absent, the
   * ask is built from the price and `slippageBps`.
   */
  requestedAmount?: bigint;
  slippageBps: number;
  /** Injected clock for tests. */
  now?: () => number;
}

/**
 * The flow's quote: fetch the price, build (or take) the ask, check it with the solver.
 *
 * A wallet-built ask that the solver reads as `off_market` means the price moved between the two
 * calls. The price is fetched ONCE more and the ask rebuilt from it, which converges in one round
 * trip; a second `off_market` is returned as it is and the review screen shows it. A user-edited
 * ask is never rebuilt: an above-market limit order is the user's choice, and the verdict says so.
 */
export async function quoteSwap(
  offerToken: SwapToken,
  offerAmountRaw: bigint,
  requestToken: SwapToken,
  { requestedAmount, slippageBps, now = Date.now }: QuoteSwapOptions
): Promise<SwapQuote> {
  const fetchPrice = async (): Promise<SwapPairPrice> => {
    const price = await getSwapPairPrice(offerToken, requestToken);
    assertDecimalsMatch(price, offerToken, requestToken);
    return price;
  };
  const check = async (): Promise<SwapQuote> => {
    const fetchedAt = now();
    const price = await fetchPrice();
    const ask = requestedAmount ?? buildRequestedAmount(offerAmountRaw, price, slippageBps);
    const eta = await getSwapEta(offerToken, offerAmountRaw, requestToken, ask);
    return {
      price,
      offeredAmount: offerAmountRaw,
      requestedAmount: ask,
      builtAsk: requestedAmount === undefined,
      slippageBps,
      eta,
      fetchedAt
    };
  };
  const first = await check();
  if (requestedAmount !== undefined || first.eta.priceBand !== 'off_market') return first;
  return check();
}
