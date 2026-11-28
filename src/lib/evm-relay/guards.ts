/**
 * Checks of the relay service's answers against the request, the review and the wallet config. The service is not
 * trusted for anything that decides where funds go or what they cost: the executor, the fee recipient and the fee
 * limits come from the wallet-config document, the fee comes from the user's review of a checked quote, and the job
 * id is the digest that the wallet computed itself.
 */
import type { Address, Hex } from 'viem';

import type { RelayChainConfig } from 'lib/remote-config/schema';

import { RelayMismatchError, RelayRefusedError } from './errors';
import { lowerAddress } from './parse';
import type { RelayAccount, RelayFeeQuoteProof, RelayJob, RelayQuote } from './types';

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The only recipient that the wallet pays a `deduct` fee to: the `feeRecipient` of the chain config, else its
 * `executor`. The executor is the relayer, which pays the gas, so a config without `feeRecipient` pays the relayer
 * back. Both values come from the wallet config, never from the relay service.
 */
export function configuredFeeRecipient(chain: RelayChainConfig): Address {
  return chain.feeRecipient ?? chain.executor;
}

/**
 * The fee recipient of a `deduct` account: `configuredFeeRecipient` of the chain config. Throws `RelayMismatchError`
 * when the account names another recipient.
 */
export function deductFeeRecipient(account: RelayAccount, chain: RelayChainConfig): Address {
  const configured = configuredFeeRecipient(chain);
  if (account.feeRecipient === null || !sameHex(account.feeRecipient, configured)) {
    throw new RelayMismatchError('relay: the fee recipient is not the configured fee recipient');
  }
  return configured;
}

/**
 * Throws `RelayMismatchError` unless the account echoes the asked chain and address, names the configured executor,
 * and has a fee shape that fits its mode: no fee recipient and no fee in `sponsor` mode, the configured fee recipient
 * of the chain in `deduct` mode (`deductFeeRecipient`).
 */
export function assertRelayAccountMatches(account: RelayAccount, chain: RelayChainConfig, address: Address): void {
  if (account.chainId !== chain.chainId) throw new RelayMismatchError('relay: the account is for another chain');
  if (!sameHex(account.address, address)) throw new RelayMismatchError('relay: the account is for another address');
  if (!sameHex(account.executor, chain.executor)) {
    throw new RelayMismatchError('relay: the executor is not the configured executor');
  }
  switch (account.mode) {
    case 'sponsor':
      if (account.feeRecipient !== null) {
        throw new RelayMismatchError('relay: a sponsored account names a fee recipient');
      }
      if (account.feeTokens.length > 0) throw new RelayMismatchError('relay: a sponsored account asks for a fee');
      return;
    case 'deduct':
      deductFeeRecipient(account, chain);
      return;
    default:
      throw new RelayMismatchError('relay: the gas mode is not known');
  }
}

/** A token in lower case. Throws a `TypeError` for a value that is not an address: it is a defect of the caller. */
export function relayFeeToken(token: Address): Address {
  const lower = lowerAddress(token);
  if (lower === null) throw new TypeError('relay: the fee token is not valid');
  return lower;
}

/** Throws `RelayRefusedError` (`no-fee`) unless the account names the token in its `feeTokens`. */
export function assertRelayTakesFeeToken(account: RelayAccount, token: Address): void {
  if (!account.feeTokens.some(feeToken => sameHex(feeToken, token))) throw new RelayRefusedError('no-fee');
}

/**
 * The fee token as the wallet values it. Both values are wallet data: the decimals come from the caller's own token
 * record, and the price comes from the wallet's price feed. A value from the relay service never goes here.
 */
export interface RelayFeeTokenValue {
  /** The decimals of the token: 0 to 36. */
  decimals: number;
  /** The price of one whole token in micro-dollars (1 USD is 1,000,000). Above 0. */
  priceMicroUsd: bigint;
}

const MAX_FEE_TOKEN_DECIMALS = 36;

/**
 * The USD value of `amount` base units of the fee token, in micro-dollars, rounded up. A negative amount, decimals
 * out of range or a price that is not above 0 is a `TypeError`: it is a defect of the caller.
 */
export function relayFeeMicroUsd(amount: bigint, tokenValue: RelayFeeTokenValue): bigint {
  const { decimals, priceMicroUsd } = tokenValue;
  if (amount < 0n) throw new TypeError('relay: the fee is not valid');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_FEE_TOKEN_DECIMALS) {
    throw new TypeError('relay: the decimals of the fee token are not valid');
  }
  if (priceMicroUsd <= 0n) throw new TypeError('relay: the price of the fee token is not valid');
  const unit = 10n ** BigInt(decimals);
  return (amount * priceMicroUsd + unit - 1n) / unit;
}

/**
 * Throws `RelayRefusedError` (`fee-not-accepted`) unless the amount is above 0 and its USD value is at most the fee
 * limit of the chain (`maxFeeMicroUsd`: the config `maxFee.l1` or `maxFee.l2`). The limit is a USD value, so it
 * applies to every fee token. The batch module refuses a zero fee call.
 */
export function assertFeeWithinCap(chain: RelayChainConfig, amount: bigint, tokenValue: RelayFeeTokenValue): void {
  if (amount <= 0n || relayFeeMicroUsd(amount, tokenValue) > BigInt(chain.maxFeeMicroUsd)) {
    throw new RelayRefusedError('fee-not-accepted');
  }
}

/**
 * A fee that the user reviewed: `amount` base units of `token`, with the wallet's value of the token at the review.
 * The zero address is the native coin. It comes from a checked quote (`relayQuoteFee` in `quote.ts`).
 */
export interface RelayReviewedFee {
  token: Address;
  amount: bigint;
  tokenValue: RelayFeeTokenValue;
  quote: RelayFeeQuoteProof;
}

/**
 * Throws unless the wallet may show the quote to the user and sign its fee:
 * - `RelayMismatchError` when the quote is for another chain, the recipient is not `configuredFeeRecipient` of the
 *   chain, or the token is not the asked `feeToken`;
 * - `RelayRefusedError` (`fee-not-accepted`) when the fee is 0, or its USD value (from `tokenValue`) is above the fee
 *   limit of the chain;
 * - `RelayRefusedError` (`quote-expired`) when `validUntil` is not after `nowSeconds`.
 * A `feeToken` that is not an address, or a `tokenValue` that is not valid, is a `TypeError`.
 */
export function assertRelayQuoteMatches(
  quote: RelayQuote,
  chain: RelayChainConfig,
  feeToken: Address,
  tokenValue: RelayFeeTokenValue,
  nowSeconds: number
): void {
  const token = relayFeeToken(feeToken);
  if (quote.chainId !== chain.chainId) throw new RelayMismatchError('relay: the quote is for another chain');
  if (!sameHex(quote.recipient, configuredFeeRecipient(chain))) {
    throw new RelayMismatchError('relay: the fee recipient is not the configured fee recipient');
  }
  if (!sameHex(quote.token, token)) throw new RelayMismatchError('relay: the quote is for another fee token');
  assertFeeWithinCap(chain, quote.fee, tokenValue);
  if (quote.validUntil <= nowSeconds) throw new RelayRefusedError('quote-expired');
}

/** Throws `RelayMismatchError` unless the job id is the EIP-712 digest that the wallet computed for the batch. */
export function assertRelayJobMatches(job: RelayJob, expectedId: Hex): void {
  if (!sameHex(job.id, expectedId)) throw new RelayMismatchError('relay: the job id is not the digest of the batch');
}
