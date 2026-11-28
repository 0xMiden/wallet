/**
 * The send amount of an EVM to Miden deposit from a deposit address. The user sends a fixed amount to the address, but
 * the Epoch allocator quotes only in reverse: it takes the amount to receive (`minTokenOut`, in the Miden token's base
 * units) and answers the deposit (`tokenIn`, in the source token's base units). This module finds, with at most
 * `EPOCH_SEND_SEARCH_MAX_QUOTES` reverse quotes, the largest amount to receive whose quoted deposit is not above the
 * send amount. The deposit is then the `tokenIn` of the accepted quote: at most the send amount.
 */

/** The most reverse quotes that one search asks for. */
export const EPOCH_SEND_SEARCH_MAX_QUOTES = 3;

function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new TypeError('epoch: the decimals are not valid');
  }
}

/**
 * `units` at `fromDecimals` as base units at `toDecimals`. A conversion to fewer decimals rounds down (`down`) or up
 * (`up`); a conversion to more decimals is exact.
 */
export function convertUnits(units: bigint, fromDecimals: number, toDecimals: number, rounding: 'down' | 'up'): bigint {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);
  if (toDecimals >= fromDecimals) return units * 10n ** BigInt(toDecimals - fromDecimals);
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  const quotient = units / divisor;
  return rounding === 'up' && quotient * divisor < units ? quotient + 1n : quotient;
}

export interface EpochSendSearchInput {
  /** What the user sends to the deposit address, in the source token's base units. */
  sendUnits: bigint;
  /** The decimals of the source token (`sendUnits` and every `tokenIn`). */
  sourceDecimals: number;
  /** The decimals of the Miden token that arrives (`minTokenOut`). */
  receiveDecimals: number;
  /** One reverse quote: the deposit (`tokenIn`, source base units) for `receiveUnits` out. Rejects when it fails. */
  quote: (receiveUnits: bigint) => Promise<bigint>;
}

export interface EpochSendSearchResult {
  /** What arrives, in the Miden token's base units: the `minTokenOut` of the accepted quote. */
  receiveUnits: bigint;
  /** The deposit of the accepted quote, in source base units. Never above `sendUnits`. */
  tokenIn: bigint;
  /** How many quotes the search asked for. The accepted quote is always the last one. */
  quotes: number;
}

/**
 * The largest amount to receive, found with at most three reverse quotes, whose quoted deposit is not above
 * `sendUnits`:
 * 1. Quote the send amount as the amount to receive. The deposit above the send amount is the fee.
 * 2. Quote the send amount less that fee.
 * 3. When that deposit is still above the send amount, take the difference off once more and quote again.
 *
 * A quote whose deposit is not above the send amount ends the search, so the accepted quote is always the last one
 * asked for (a caller that keeps only the last quote keeps the accepted one). Resolves null when no quote fits in three
 * tries, or when the fee takes the whole amount. Rejects with the error of a quote that fails.
 */
export async function searchEpochSendQuote({
  sendUnits,
  sourceDecimals,
  receiveDecimals,
  quote
}: EpochSendSearchInput): Promise<EpochSendSearchResult | null> {
  let receiveUnits = convertUnits(sendUnits, sourceDecimals, receiveDecimals, 'down');
  for (let quotes = 1; quotes <= EPOCH_SEND_SEARCH_MAX_QUOTES; quotes += 1) {
    if (receiveUnits <= 0n) return null;
    const tokenIn = await quote(receiveUnits);
    if (tokenIn <= sendUnits) return { receiveUnits, tokenIn, quotes };
    receiveUnits -= convertUnits(tokenIn - sendUnits, sourceDecimals, receiveDecimals, 'up');
  }
  return null;
}
