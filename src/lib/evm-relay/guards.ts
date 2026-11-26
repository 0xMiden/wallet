/**
 * Checks of the relay service's answers against the request, the review and the wallet config. The service is not
 * trusted for anything that decides where funds go or what they cost: the executor, the fee recipient and the fee
 * limits come from the wallet-config document, the fee comes from the user's review, and the job id is the digest
 * that the wallet computed itself.
 */
import type { Address, Hex } from 'viem';

import type { RelayChainConfig, RelayConfig } from 'lib/remote-config/schema';

import { RelayMismatchError, RelayRefusedError } from './errors';
import { lowerAddress } from './parse';
import type { RelayAccount, RelayJob, RelayService, RelayTokenFee } from './types';

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The fee recipient of a `deduct` account: the `feeRecipient` of the chain config. Throws `RelayMismatchError` when the
 * chain configures none (it does not take `deduct` mode) or when the account names another recipient.
 */
export function deductFeeRecipient(account: RelayAccount, chain: RelayChainConfig): Address {
  const configured = chain.feeRecipient;
  if (configured === undefined) throw new RelayMismatchError('relay: the chain does not take deduct mode');
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
      if (account.fees.length > 0) throw new RelayMismatchError('relay: a sponsored account asks for a fee');
      return;
    case 'deduct':
      deductFeeRecipient(account, chain);
      return;
    default:
      throw new RelayMismatchError('relay: the gas mode is not known');
  }
}

/**
 * Throws `RelayMismatchError` unless the service names the configured executor: the same rule that
 * `assertRelayAccountMatches` applies to an account. The executor of the config is the same on every chain.
 */
export function assertRelayServiceMatches(service: RelayService, relay: Pick<RelayConfig, 'executor'>): void {
  if (!sameHex(service.executor, relay.executor)) {
    throw new RelayMismatchError('relay: the executor is not the configured executor');
  }
}

/** A token in lower case. Throws a `TypeError` for a value that is not an address: it is a defect of the caller. */
export function relayFeeToken(token: Address): Address {
  const lower = lowerAddress(token);
  if (lower === null) throw new TypeError('relay: the fee token is not valid');
  return lower;
}

/** The relayer's fee entry of the token. Throws `RelayRefusedError` (`no-fee`) when the relayer names none. */
export function relayerFeeOf(account: RelayAccount, token: Address): RelayTokenFee {
  const entry = account.fees.find(fee => sameHex(fee.token, token));
  if (entry === undefined) throw new RelayRefusedError('no-fee');
  return entry;
}

/**
 * Throws `RelayRefusedError` (`fee-not-accepted`) unless the amount is above 0 and at most the config `maxFee` of the
 * token. A token without a `maxFee` entry is not accepted as a fee. The batch module refuses a zero fee call.
 */
export function assertFeeWithinCap(chain: RelayChainConfig, token: Address, amount: bigint): void {
  const key = token.toLowerCase();
  const maxFee = Object.entries(chain.maxFee).find(([configured]) => configured.toLowerCase() === key)?.[1];
  if (maxFee === undefined || amount <= 0n || amount > BigInt(maxFee)) {
    throw new RelayRefusedError('fee-not-accepted');
  }
}

/** A fee that the user reviewed: `amount` base units of `token`. The zero address is the native coin. */
export interface RelayReviewedFee {
  token: Address;
  amount: bigint;
}

/** What the review shows: no fee (`sponsor`), or the fee that the batch pays (`deduct`). */
export type RelayFeeReview = { mode: 'sponsor' } | { mode: 'deduct'; fee: RelayReviewedFee };

/**
 * The fee that a review shows for a relay paid in `token`. Call it after `assertRelayAccountMatches`. In `sponsor` mode
 * there is no fee. In `deduct` mode the fee is the relayer's current fee of the token; it throws the typed refusals of
 * the submitter: `RelayMismatchError` when the chain configures no fee recipient or the account names another, and
 * `RelayRefusedError` (`no-fee`, `fee-not-accepted`) when the relayer names no fee for the token, or the fee is 0, or
 * the config has no `maxFee` entry for the token, or the fee is above that entry. Give the result's `fee` to
 * `submit` as `options.fee`.
 */
export function reviewRelayFee(account: RelayAccount, chain: RelayChainConfig, token: Address): RelayFeeReview {
  switch (account.mode) {
    case 'sponsor':
      return { mode: 'sponsor' };
    case 'deduct': {
      deductFeeRecipient(account, chain);
      const lower = relayFeeToken(token);
      const amount = relayerFeeOf(account, lower).fee;
      assertFeeWithinCap(chain, lower, amount);
      return { mode: 'deduct', fee: { token: lower, amount } };
    }
    default:
      throw new RelayMismatchError('relay: the gas mode is not known');
  }
}

/** Throws `RelayMismatchError` unless the job id is the EIP-712 digest that the wallet computed for the batch. */
export function assertRelayJobMatches(job: RelayJob, expectedId: Hex): void {
  if (!sameHex(job.id, expectedId)) throw new RelayMismatchError('relay: the job id is not the digest of the batch');
}
