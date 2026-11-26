/**
 * Checks of the relay service's answers against the request and the wallet config. The service is not trusted for
 * anything that decides where funds go or what they cost: the executor and the fee limits come from the
 * wallet-config document, and the job id is the digest that the wallet computed itself.
 */
import { zeroAddress, type Address, type Hex } from 'viem';

import type { RelayChainConfig } from 'lib/remote-config/schema';

import { RelayMismatchError } from './errors';
import type { RelayAccount, RelayJob } from './types';

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Throws `RelayMismatchError` unless the account echoes the asked chain and address, names the configured executor,
 * and has a fee shape that fits its mode: no fee recipient and no fee in `sponsor` mode, a fee recipient that is not
 * the zero address in `deduct` mode.
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
      if (account.feeRecipient === null || sameHex(account.feeRecipient, zeroAddress)) {
        throw new RelayMismatchError('relay: a deduct account names no fee recipient');
      }
      return;
    default:
      throw new RelayMismatchError('relay: the gas mode is not known');
  }
}

/**
 * The fee of `token` that the wallet accepts, or null when the wallet must refuse it. In `sponsor` mode it is 0. In
 * `deduct` mode it is the relayer's fee of the token, and null when the relayer names no fee for the token, the config
 * has no `maxFee` entry for the token, the fee is 0, or the fee is above that entry. Call it after
 * `assertRelayAccountMatches`.
 */
export function acceptedFee(account: RelayAccount, chain: RelayChainConfig, token: Address): bigint | null {
  switch (account.mode) {
    case 'sponsor':
      return 0n;
    case 'deduct': {
      const entry = account.fees.find(fee => sameHex(fee.token, token));
      if (entry === undefined) return null;
      const key = token.toLowerCase();
      const maxFee = Object.entries(chain.maxFee).find(([configured]) => configured.toLowerCase() === key)?.[1];
      if (maxFee === undefined) return null;
      // The batch module refuses a zero fee call.
      return entry.fee > 0n && entry.fee <= BigInt(maxFee) ? entry.fee : null;
    }
    default:
      return null;
  }
}

/** Throws `RelayMismatchError` unless the job id is the EIP-712 digest that the wallet computed for the batch. */
export function assertRelayJobMatches(job: RelayJob, expectedId: Hex): void {
  if (!sameHex(job.id, expectedId)) throw new RelayMismatchError('relay: the job id is not the digest of the batch');
}
