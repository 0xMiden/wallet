/**
 * The relay fee of a batch in `deduct` mode, for a caller that reviews it: ask the relay for a quote, check it
 * against the wallet config, show it, then give it to `submit` (or to the provider's `feeFor`) as the reviewed fee.
 * This module knows no bridge and signs nothing.
 */
import type { Address } from 'viem';

import { getRelayChain } from 'lib/remote-config/values';

import type { BatchCall } from './batch';
import { fetchRelayQuote, type RelayQuoteQuery } from './client';
import { RelayRefusedError, RelayUnavailableError } from './errors';
import { relayFeeTokenPriceMicroUsd } from './fee-price';
import { assertRelayQuoteMatches, type RelayFeeTokenValue, type RelayReviewedFee } from './guards';
import type { RelaySource } from './source';
import type { RelayQuote } from './types';

/**
 * The fee token of a quote as the caller knows it: its address (the zero address is the native coin) and its
 * decimals. The decimals come from the caller's own token record, never from the relay service.
 */
export interface RelayFeeAsset {
  address: Address;
  decimals: number;
}

/** A quote that passed `assertRelayQuoteMatches`, with the wallet's value of the fee token that the check used. */
export interface RelayCheckedQuote extends RelayQuote {
  tokenValue: RelayFeeTokenValue;
}

export interface QuoteRelayFeeOptions {
  /** Whether the batch carries the EIP-7702 authorization. Without it, the relay reads the chain. */
  authorization?: boolean;
  /** Tests replace the service call, the price read and the clock (ms). */
  fetchQuote?: (query: RelayQuoteQuery) => Promise<RelayQuote>;
  priceMicroUsd?: (chainId: number, token: Address) => Promise<bigint | undefined>;
  now?: () => number;
}

/**
 * The checked quote of a batch of `calls` (without the fee call) from the relay address `from` on `chainId`, paid in
 * `feeToken`. The wallet reads its own USD price of the fee token first, and checks the USD value of the quoted fee
 * against the fee limit of the chain. It throws:
 * - `RelayUnavailableError` (`not_configured`) when the config has no relay entry for the chain;
 * - `RelayRefusedError` (`fee-price-unavailable`) when the wallet has no fresh price of the fee token. The relay is
 *   not asked then;
 * - the errors of `fetchRelayQuote` (`RelayApiError` such as `fee_not_needed` in `sponsor` mode,
 *   `fee_token_not_accepted`, `simulation_failed` or `price_unavailable`; `RelayUnavailableError`; a `TypeError` for a
 *   bad argument);
 * - the errors of `assertRelayQuoteMatches` (`RelayMismatchError`, `RelayRefusedError` `fee-not-accepted` or
 *   `quote-expired`).
 * Submit the signed quote before its `validUntil` time. The relay checks the gas estimate against the quote.
 */
export async function quoteRelayFee(
  from: RelaySource | Address,
  chainId: number,
  calls: readonly BatchCall[],
  feeToken: RelayFeeAsset,
  options: QuoteRelayFeeOptions = {}
): Promise<RelayCheckedQuote> {
  const chain = getRelayChain(chainId);
  if (chain === null) throw new RelayUnavailableError('not_configured', `relay: chain ${chainId} is not served`);
  const evmAddress = typeof from === 'string' ? from : from.address;
  const query: RelayQuoteQuery = { chainId, evmAddress, calls, feeToken: feeToken.address };
  if (options.authorization !== undefined) query.authorization = options.authorization;
  const fetchQuote = options.fetchQuote ?? (request => fetchRelayQuote(request));
  const priceOf = options.priceMicroUsd ?? relayFeeTokenPriceMicroUsd;
  const now = options.now ?? (() => Date.now());
  const priceMicroUsd = await priceOf(chainId, feeToken.address);
  if (priceMicroUsd === undefined) throw new RelayRefusedError('fee-price-unavailable');
  const tokenValue: RelayFeeTokenValue = { decimals: feeToken.decimals, priceMicroUsd };
  const quote = await fetchQuote(query);
  assertRelayQuoteMatches(quote, chain, feeToken.address, tokenValue, Math.floor(now() / 1000));
  return { ...quote, tokenValue };
}

/** The reviewed fee of a checked quote: give it to `submit` as `options.fee`, or return it from a `feeFor`. */
export function relayQuoteFee(quote: RelayCheckedQuote): RelayReviewedFee {
  const { token, fee, tokenValue, gas, sequence, validUntil, signature } = quote;
  return { token, amount: fee, tokenValue, quote: { gas, sequence, validUntil, signature } };
}

/**
 * The part of a typed send amount of the fee token that is left for the bridge calls after the quoted fee:
 * `amount - fee`. Null when the fee is not below the amount (nothing is left to send). Both are base units of the fee
 * token. A negative fee is a `TypeError`.
 */
export function amountAfterRelayFee(amount: bigint, fee: bigint): bigint | null {
  if (fee < 0n) throw new TypeError('relay: the fee is not valid');
  return fee < amount ? amount - fee : null;
}
