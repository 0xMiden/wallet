import { usdQuoteStatus } from './amount';
import type { TokenPriceInfo } from './binance';
import { toPriceMicro } from './usd';

/**
 * Since-arrival profit and loss for one token of one account on one network, at average cost.
 *
 * `quantity` is what the recorded events leave, in base units. `costMicro` is what that quantity was worth in
 * micro-dollars as it arrived, and `undefined` while the events cannot say: it stays unknown until the tracked
 * quantity is spent to exactly zero. Callers key positions by canonical faucet id, never by price symbol.
 */
export interface TrackedPosition {
  readonly quantity: bigint;
  readonly costMicro: bigint | undefined;
}

/** A quote and the verified decimals needed to turn base units into micro-dollars. */
export interface Pricing {
  quote: TokenPriceInfo | undefined;
  decimals: number | undefined;
}

export type PositionPnl =
  | { status: 'unknown'; reason: 'history-incomplete' | 'no-value' }
  | {
      status: 'known';
      valueMicro: bigint;
      costMicro: bigint;
      pnlMicro: bigint;
      /** Hundredths of a percent of cost, truncated toward zero; `undefined` when there is no cost. */
      pnlBps: bigint | undefined;
      /** Per whole token; `undefined` when nothing is held. */
      averageCostMicro: bigint | undefined;
    };

export const EMPTY_POSITION: TrackedPosition = { quantity: 0n, costMicro: 0n };

const requireQuantity = (amount: bigint): void => {
  // A static message: quantities must stay out of error text.
  if (amount < 0n) throw new RangeError('Position quantities cannot be negative');
};

/** Micro-dollars for `amount` at `at` (milliseconds), rounded half up; `undefined` when it cannot be priced. */
const valueMicro = (amount: bigint, { quote, decimals }: Pricing, at: number): bigint | undefined => {
  if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
  // A basket's net asset value is for display; `usdQuoteStatus` already refuses nominal and stale quotes.
  if (!quote || quote.kind === 'basket' || usdQuoteStatus(quote, at) !== 'ready') return undefined;
  const priceMicro = toPriceMicro(quote.price);
  if (priceMicro === undefined) return undefined;
  const scale = 10n ** BigInt(decimals);
  return (amount * priceMicro + scale / 2n) / scale;
};

/** The position when tracking starts: what the wallet already holds has no known cost. */
export const openPosition = (held: bigint): TrackedPosition => {
  requireQuantity(held);
  return held === 0n ? EMPTY_POSITION : { quantity: held, costMicro: undefined };
};

/** For an event whose amount cannot be trusted or applied, such as a fee row with no fee data. */
export const markIncomplete = ({ quantity }: TrackedPosition): TrackedPosition => ({ quantity, costMicro: undefined });

/**
 * `amount` is what was credited. `eventAt` is in milliseconds. A quote that cannot price the arrival then (stale,
 * retrieved later, nominal, basket, or unknown decimals) leaves the cost unknown.
 */
export const recordArrival = (
  position: TrackedPosition,
  { amount, eventAt, ...pricing }: Pricing & { amount: bigint; eventAt: number }
): TrackedPosition => {
  requireQuantity(amount);
  if (amount === 0n) return position;
  const arrived = valueMicro(amount, pricing, eventAt);
  const { quantity, costMicro } = position;
  return {
    quantity: quantity + amount,
    costMicro: costMicro === undefined || arrived === undefined ? undefined : costMicro + arrived
  };
};

/** Sends, fees, swap offers, Earn deposits and bridge exits: each removes its share of the cost. */
export const recordDeparture = (position: TrackedPosition, amount: bigint): TrackedPosition => {
  requireQuantity(amount);
  if (amount === 0n) return position;
  const { quantity, costMicro } = position;
  // The events cannot explain this outflow.
  if (amount > quantity) return { quantity: 0n, costMicro: undefined };
  // Sold out: an unknown cost ends here. `valuePosition` still refuses if the vault holds more.
  if (amount === quantity) return EMPTY_POSITION;
  return {
    quantity: quantity - amount,
    // The removed share is floored, so the remainder stays with what is left.
    costMicro: costMicro === undefined ? undefined : costMicro - (costMicro * amount) / quantity
  };
};

/** `held` is the vault balance in base units. A number is shown only when the events explain all of it. */
export const valuePosition = (
  { quantity, costMicro }: TrackedPosition,
  { held, now, ...pricing }: Pricing & { held: bigint; now: number }
): PositionPnl => {
  requireQuantity(held);
  if (costMicro === undefined || held !== quantity) return { status: 'unknown', reason: 'history-incomplete' };
  const value = valueMicro(held, pricing, now);
  if (value === undefined) return { status: 'unknown', reason: 'no-value' };
  const pnlMicro = value - costMicro;
  return {
    status: 'known',
    valueMicro: value,
    costMicro,
    pnlMicro,
    pnlBps: costMicro === 0n ? undefined : (pnlMicro * 10_000n) / costMicro,
    // A held quantity means `valueMicro` already accepted the decimals.
    averageCostMicro: quantity === 0n ? undefined : (costMicro * 10n ** BigInt(pricing.decimals!)) / quantity
  };
};
