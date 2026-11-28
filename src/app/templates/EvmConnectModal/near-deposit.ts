/**
 * The parts of a NEAR Intents deposit that the Deposit flow shares: the quote request rules (the slippage, the
 * deadline, the route key), the refund address of the account, and what a 1Click quote shows on the deposit views.
 * The binding checks of a quote are in `lib/one-click` (`requestOneClickQuote`, `persistNearIntentsDeposit`).
 */
import BigNumber from 'bignumber.js';

import { isValidNearIntentsRefundAddress } from 'lib/one-click/address';
import type { NearIntentsAddressKind, OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';
import type { WalletAccount } from 'lib/shared/types';
import type { DepositRouteOption } from 'screens/deposit-flow/DepositRouteSheet';
import type { DepositAmountValue, DepositFee } from 'screens/deposit-flow/types';
import { isPreviewRefundAddress } from 'screens/near-intents-flow/preview-refund';

import { NEAR_ROUTE_ID } from './deposit-routes';

/** The life of a quote request: the deadline that the wallet asks 1Click for. */
export const NEAR_QUOTE_LIFETIME_MS = 5 * 60_000;
/** The preview deadline moves forward at this interval, before the 5 minutes run out. */
export const NEAR_PREVIEW_DEADLINE_REFRESH_MS = 240_000;
/** Each quote allows 1% of slippage, in basis points, as the Receive form did. */
export const NEAR_SLIPPAGE_BPS = 100;
/** A fee that the views cannot show yet: no amount, or no quote. */
export const NO_FEE_YET = '–';

/** A quote deadline `NEAR_QUOTE_LIFETIME_MS` from now. */
export const nearQuoteDeadline = (): string => new Date(Date.now() + NEAR_QUOTE_LIFETIME_MS).toISOString();

/** The parts of a request that make the route, without the deadline that moves on each refresh. */
export function nearQuoteRouteKey(request: OneClickQuoteRequest): string {
  return JSON.stringify([
    request.amount,
    request.originAsset.assetId,
    request.destinationAsset.assetId,
    request.refundTo,
    request.recipient
  ]);
}

/** True when 1Click refused the quote because it has no liquidity for the amount (`OneClickHttpError.code`). */
export function isNearNoLiquidity(error: Error | undefined): boolean {
  return error !== undefined && 'code' in error && error.code === 'no_liquidity';
}

/** True when `value` (trimmed) can be the refund address of a deposit from a chain of `kind`. */
export function isUsableRefundAddress(kind: NearIntentsAddressKind, value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && isValidNearIntentsRefundAddress(kind, trimmed) && !isPreviewRefundAddress(trimmed);
}

/**
 * The refund address that the wallet gives for a deposit from a chain of `kind`, with no field: on an EVM chain the
 * account's relay address (`relayEvmAddress`), else its EVM address (`evmAddress`). Undefined on another chain kind, and
 * for an account with no usable EVM address: the user then types the address.
 */
export function nearRefundAddressOf(
  account: Pick<WalletAccount, 'relayEvmAddress' | 'evmAddress'>,
  kind: NearIntentsAddressKind
): string | undefined {
  if (kind !== 'evm') return undefined;
  return [account.relayEvmAddress, account.evmAddress].find(
    (candidate): candidate is string => candidate !== undefined && isUsableRefundAddress(kind, candidate)
  );
}

/** A base-unit integer text as a bigint, or undefined when it is not one. */
function baseUnitsOf(text: string): bigint | undefined {
  return /^\d+$/.test(text) ? BigInt(text) : undefined;
}

/** A 1Click USD text as a number, or undefined when it is not a finite number. */
export function quoteUsdOf(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** What the quote delivers, in the base units of the Miden token. */
export function nearQuoteReceived(quote: OneClickQuoteResponse, decimals: number): DepositAmountValue | undefined {
  const units = baseUnitsOf(quote.quote.amountOut);
  return units === undefined ? undefined : { amount: units, decimals };
}

/**
 * The bridge fee of a quote in the source token, and its share of the deposit. 1Click quotes an exact input, so the fee
 * comes out of the amount: it is the share of the input's USD value that does not arrive (`amountInUsd` less
 * `amountOutUsd`), applied to the input amount. Undefined when the quote has no USD values to compare.
 */
export function nearQuoteFee(
  quote: OneClickQuoteResponse,
  sourceDecimals: number
): { fee: DepositFee; share: number } | undefined {
  const amountIn = baseUnitsOf(quote.quote.amountIn);
  if (quoteUsdOf(quote.quote.amountOutUsd) === undefined || amountIn === undefined) return undefined;
  // Decimal arithmetic on the texts: a float share can put the fee one base unit over.
  const inUsd = new BigNumber(quote.quote.amountInUsd);
  if (!inUsd.isFinite() || !inUsd.gt(0)) return undefined;
  const share = BigNumber.min(1, BigNumber.max(0, inUsd.minus(quote.quote.amountOutUsd).div(inUsd)));
  const units = new BigNumber(amountIn.toString()).times(share).integerValue(BigNumber.ROUND_CEIL);
  if (units.lte(0)) return { fee: { kind: 'none' }, share: 0 };
  return {
    fee: { kind: 'amount', value: { amount: BigInt(units.toFixed(0)), decimals: sourceDecimals } },
    share: share.toNumber()
  };
}

/** The fee that the views show for a quote state: the quote's fee, "Loading" while it is on its way, else "–". */
export function nearFeeOf(
  quote: OneClickQuoteResponse | undefined,
  sourceDecimals: number,
  waiting: boolean,
  loadingText: string
): DepositFee {
  if (quote !== undefined) return nearQuoteFee(quote, sourceDecimals)?.fee ?? { kind: 'rate', text: NO_FEE_YET };
  return { kind: 'rate', text: waiting ? loadingText : NO_FEE_YET };
}

/**
 * The deposit as the balance cap weighs it: the USD value that arrives (`amountOutUsd`) at a price of 1. A quote with
 * no USD value cannot be weighed (no price); no quote is no amount yet.
 */
export function nearCapInput(quote: OneClickQuoteResponse | undefined): {
  depositAmount: number | null;
  depositPriceUsd: number | undefined;
} {
  if (quote === undefined) return { depositAmount: null, depositPriceUsd: undefined };
  const usd = quoteUsdOf(quote.quote.amountOutUsd);
  return usd === undefined || usd < 0
    ? { depositAmount: 1, depositPriceUsd: undefined }
    : { depositAmount: usd, depositPriceUsd: 1 };
}

export interface NearRouteRowInput {
  /** The route's name and arrival time, translated. */
  name: string;
  arrivesIn: string;
  /** The text of a fee that is on its way. */
  loadingText: string;
  quote: OneClickQuoteResponse | undefined;
  /** True while a quote for a typed amount is on its way. */
  waiting: boolean;
  sourceDecimals: number;
  outputDecimals: number;
  selected: boolean;
}

/** The NEAR Intents row of the route sheet, from its real quote. The sheet sets the tags. */
export function nearRouteOption({
  name,
  arrivesIn,
  loadingText,
  quote,
  waiting,
  sourceDecimals,
  outputDecimals,
  selected
}: NearRouteRowInput): DepositRouteOption {
  return {
    id: NEAR_ROUTE_ID,
    name,
    arrivesIn,
    received: quote === undefined ? undefined : nearQuoteReceived(quote, outputDecimals),
    fee: nearFeeOf(quote, sourceDecimals, waiting, loadingText),
    best: false,
    fastest: false,
    selected
  };
}
