import type { TokenPriceInfo } from './binance';

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

/** The position when tracking starts: what the wallet already holds has no known cost. */
export const openPosition = (_held: bigint): TrackedPosition => EMPTY_POSITION;

/** For an event whose amount cannot be trusted or applied, such as a fee row with no fee data. */
export const markIncomplete = (position: TrackedPosition): TrackedPosition => position;

/**
 * `amount` is what was credited. `eventAt` is in milliseconds. A quote that cannot price the arrival then (stale,
 * retrieved later, nominal, basket, or unknown decimals) leaves the cost unknown.
 */
export const recordArrival = (
  position: TrackedPosition,
  _arrival: Pricing & { amount: bigint; eventAt: number }
): TrackedPosition => position;

/** Sends, fees, swap offers, Earn deposits and bridge exits: each removes its share of the cost. */
export const recordDeparture = (position: TrackedPosition, _amount: bigint): TrackedPosition => position;

/** `held` is the vault balance in base units. A number is shown only when the events explain all of it. */
export const valuePosition = (
  _position: TrackedPosition,
  _current: Pricing & { held: bigint; now: number }
): PositionPnl => ({ status: 'unknown', reason: 'no-value' });
