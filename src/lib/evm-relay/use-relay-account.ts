import useSWR from 'swr';
import type { Address } from 'viem';

import { usePageActive } from 'app/layouts/page-active';
import type { RelayChainConfig } from 'lib/remote-config/schema';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectRelayChain } from 'lib/remote-config/values';

import { fetchRelayAccount } from './client';
import { assertRelayAccountMatches } from './guards';
import type { RelayAccount } from './types';

/** The time between two reads while the page is on screen. */
export const RELAY_ACCOUNT_REFRESH_MS = 10_000;

export interface RelayAccountTarget {
  /** Null or undefined while the page has no chain yet: then nothing is read. */
  chainId: number | null | undefined;
  /** The account's `relayEvmAddress`. Null or undefined: nothing is read. */
  address: Address | null | undefined;
  /** The tokens to read balances of (1 to 16); the zero address is the native coin. */
  tokens?: readonly Address[];
}

export interface RelayAccountState {
  /** The last answer that passed the guards. */
  account: RelayAccount | undefined;
  error: unknown;
  isLoading: boolean;
  /** Reads now. */
  refresh(): Promise<RelayAccount | undefined>;
}

/**
 * The relay state of a deposit address (`GET /v1/account`), for a page that shows the address and waits for funds.
 * It reads every 10 seconds while the page is on screen and the relay serves the chain. Off screen the SWR key is
 * null (never `isPaused`, see `usePageActive`), so nothing is read. Each answer must pass `assertRelayAccountMatches`.
 */
export function useRelayAccount({ chainId, address, tokens = [] }: RelayAccountTarget): RelayAccountState {
  const pageActive = usePageActive();
  const snapshot = useBridgeConfigSnapshot({ load: false });
  const chain = typeof chainId === 'number' ? selectRelayChain(snapshot, chainId) : null;
  const target = pageActive && chain !== null && address ? { chain, address } : null;
  const tokenKey = tokens.map(token => token.toLowerCase()).join(',');
  const { data, error, isLoading, mutate } = useSWR(
    target ? ['relay-account', target.chain.chainId, target.address.toLowerCase(), tokenKey] : null,
    target ? () => readRelayAccount(target.chain, target.address, tokens) : null,
    { refreshInterval: RELAY_ACCOUNT_REFRESH_MS, revalidateOnFocus: false }
  );
  return { account: data, error, isLoading, refresh: () => mutate() };
}

async function readRelayAccount(
  chain: RelayChainConfig,
  address: Address,
  tokens: readonly Address[]
): Promise<RelayAccount> {
  const account = await fetchRelayAccount({ chainId: chain.chainId, address, tokens });
  assertRelayAccountMatches(account, chain, address);
  return account;
}
