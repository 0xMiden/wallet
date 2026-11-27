import { useMemo } from 'react';

import type { Address } from 'viem';

import type { PendingRelayDeposit } from './pending-deposit';
import type { RelayGasMode } from './types';
import { useRelayAccount } from './use-relay-account';

/**
 * Where the funds of a pending deposit are. The rule is only "the balance of the token at the relay address is at
 * least the reviewed amount": a balance that was at the address before the deposit counts too.
 */
export type DepositArrival =
  /** `balance` is null while no read has passed (none done yet, or each one failed). */
  | { state: 'waiting'; balance: bigint | null }
  /** More than zero and less than the reviewed amount. */
  | { state: 'partial'; balance: bigint }
  | { state: 'arrived'; balance: bigint };

export type DepositArrivalState = DepositArrival & {
  /** True while the address does not delegate to Calibur yet. Null before the first read that passed. */
  needsAuthorization: boolean | null;
  /** The gas mode of the relay for the address. Null before the first read that passed. */
  mode: RelayGasMode | null;
  /** The error of the last read, or undefined. The state keeps the last read that passed. */
  error: unknown;
};

/** The arrival state of a balance read against the reviewed amount in base units. */
export function depositArrivalOf(balance: bigint | null, amountBaseUnits: bigint): DepositArrival {
  if (balance === null || balance <= 0n) return { state: 'waiting', balance };
  if (balance < amountBaseUnits) return { state: 'partial', balance };
  return { state: 'arrived', balance };
}

/**
 * Watches the balance of the deposit's token at its relay address on its chain, through `useRelayAccount` (every 10
 * seconds while the page is on screen). It starts nothing: the screen decides what to do when the state is `arrived`.
 * A null deposit reads nothing.
 */
export function useDepositArrival(deposit: PendingRelayDeposit | null): DepositArrivalState {
  const tokenAddress = deposit?.token.address;
  const tokens = useMemo<readonly Address[]>(() => (tokenAddress ? [tokenAddress] : []), [tokenAddress]);
  const { account, error } = useRelayAccount({ chainId: deposit?.chainId, address: deposit?.address, tokens });
  const balance =
    account && tokenAddress
      ? (account.balances.find(entry => entry.token.toLowerCase() === tokenAddress.toLowerCase())?.balance ?? null)
      : null;
  const amount = deposit ? BigInt(deposit.amountBaseUnits) : 0n;
  return {
    ...depositArrivalOf(deposit ? balance : null, amount),
    needsAuthorization: account?.needsAuthorization ?? null,
    mode: account?.mode ?? null,
    error
  };
}
