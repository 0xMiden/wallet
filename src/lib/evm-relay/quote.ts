/**
 * The relay fee of a batch in `deduct` mode, for a caller that reviews it: ask the relay for a quote, check it
 * against the wallet config, show it, then give it to `submit` (or to the provider's `feeFor`) as the reviewed fee.
 * This module knows no bridge and signs nothing.
 */
import type { Address } from 'viem';

import { getRelayChain } from 'lib/remote-config/values';

import type { BatchCall } from './batch';
import { fetchRelayQuote, type RelayQuoteQuery } from './client';
import { RelayUnavailableError } from './errors';
import { assertRelayQuoteMatches, type RelayReviewedFee } from './guards';
import type { RelayQuote } from './types';

export interface QuoteRelayFeeOptions {
  /** Whether the batch carries the EIP-7702 authorization. Without it, the relay reads the chain. */
  authorization?: boolean;
  /** Tests replace the service call and the clock (ms). */
  fetchQuote?: (query: RelayQuoteQuery) => Promise<RelayQuote>;
  now?: () => number;
}

/**
 * The checked quote of a batch of `calls` (without the fee call) from the relay address `from` on `chainId`, paid in
 * `feeToken` (the zero address is the native coin). It throws:
 * - `RelayUnavailableError` (`not_configured`) when the config has no relay entry for the chain, and the errors of
 *   `fetchRelayQuote` (`RelayApiError` such as `fee_not_needed` in `sponsor` mode, `fee_token_not_accepted`,
 *   `simulation_failed` or `price_unavailable`; `RelayUnavailableError`; a `TypeError` for a bad argument);
 * - the errors of `assertRelayQuoteMatches` (`RelayMismatchError`, `RelayRefusedError` `fee-not-accepted` or
 *   `quote-expired`).
 * The quote is valid until its `validUntil`. The relay decides again from its own simulation when it gets the batch.
 */
export async function quoteRelayFee(
  from: { address: Address } | Address,
  chainId: number,
  calls: readonly BatchCall[],
  feeToken: Address,
  options: QuoteRelayFeeOptions = {}
): Promise<RelayQuote> {
  const chain = getRelayChain(chainId);
  if (chain === null) throw new RelayUnavailableError('not_configured', `relay: chain ${chainId} is not served`);
  const evmAddress = typeof from === 'string' ? from : from.address;
  const query: RelayQuoteQuery = { chainId, evmAddress, calls, feeToken };
  if (options.authorization !== undefined) query.authorization = options.authorization;
  const fetchQuote = options.fetchQuote ?? (request => fetchRelayQuote(request));
  const now = options.now ?? (() => Date.now());
  const quote = await fetchQuote(query);
  assertRelayQuoteMatches(quote, chain, feeToken, Math.floor(now() / 1000));
  return quote;
}

/** The reviewed fee of a checked quote: give it to `submit` as `options.fee`, or return it from a `feeFor`. */
export function relayQuoteFee(quote: RelayQuote): RelayReviewedFee {
  return { token: quote.token, amount: quote.fee };
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
