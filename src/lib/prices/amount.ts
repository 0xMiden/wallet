import BigNumber from 'bignumber.js';

import { formatUsd } from 'lib/i18n/numbers';

import { isNominalQuote, type TokenPriceInfo } from './binance';
import { isFixedQuote } from './fixed';

export const USD_QUOTE_MAX_AGE_MS = 10 * 60_000;
export type UsdQuoteStatus = 'ready' | 'loading' | 'unavailable' | 'stale';

export function usdQuoteStatus(quote: TokenPriceInfo | undefined, now = Date.now()): UsdQuoteStatus {
  if (!quote || isNominalQuote(quote) || !Number.isFinite(quote.price) || quote.price <= 0) return 'unavailable';
  if (isFixedQuote(quote)) return 'ready';
  if (quote.observedAt === undefined) return 'unavailable';
  return quote.observedAt > now || now - quote.observedAt > USD_QUOTE_MAX_AGE_MS ? 'stale' : 'ready';
}

/** Exact decimal arithmetic. Only an edited USD amount is quantized to the asset's base units. */
export function usdToToken(value: string, price: number, decimals: number): string {
  if (!/^\d*(?:\.\d*)?$/.test(value) || !value || value === '.' || !(price > 0) || !Number.isFinite(price)) return '';
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return '';
  return new BigNumber(value).shiftedBy(decimals).dividedToIntegerBy(price).shiftedBy(-decimals).toFixed();
}

export function tokenToUsd(value: string, price: number): string {
  const amount = new BigNumber(value);
  return amount.isFinite() && amount.gte(0) && price > 0 && Number.isFinite(price)
    ? amount.multipliedBy(price).toFixed()
    : '';
}

export function usdEstimateText(
  amount: string | number | bigint,
  quote: TokenPriceInfo | undefined,
  decimals?: number
): string | undefined {
  if (usdQuoteStatus(quote) !== 'ready' || !quote) return undefined;
  if (
    typeof amount === 'bigint' &&
    (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
  )
    return undefined;
  const tokens = new BigNumber(amount.toString()).shiftedBy(typeof amount === 'bigint' ? -(decimals ?? 0) : 0);
  const value = tokens.multipliedBy(quote.price);
  if (!value.isFinite()) return undefined;
  // Adaptive display caps precision. Never call a nonzero estimate zero when below that cap.
  const numeric = value.toNumber();
  if (!Number.isFinite(numeric)) return undefined;
  if ((numeric === 0 && !value.isZero()) || (value.abs().gt(0) && value.abs().lt('0.00000000000000000001'))) {
    return `${value.isNegative() ? '−' : ''}<$0.00000000000000000001`;
  }
  return formatUsd(numeric);
}
