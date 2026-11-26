import React, { type ReactNode } from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { Address } from 'viem';

import { PageActiveContext } from 'app/layouts/page-active';
import type { RelayChainConfig } from 'lib/remote-config/schema';

import type { RelayAccountQuery } from './client';
import { RelayMismatchError } from './errors';
import { CHAIN, EXECUTOR, FEE_RECIPIENT, NATIVE, RELAY_ADDRESS, SALT, USDC, upperHex } from './testing';
import type { RelayAccount } from './types';
import { useRelayAccount, type RelayAccountTarget } from './use-relay-account';

const ACCOUNT: RelayAccount = {
  chainId: CHAIN.chainId,
  address: RELAY_ADDRESS,
  mode: 'sponsor',
  executor: EXECUTOR,
  feeRecipient: null,
  needsAuthorization: true,
  authorizationNonce: 0,
  salt: SALT,
  sequence: 0n,
  fees: [],
  allowedTargets: null,
  balances: [{ token: USDC, balance: 5n }]
};

let mockRelayChain: RelayChainConfig | null = CHAIN;
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({
  selectRelayChain: (_snapshot: unknown, chainId: number) =>
    mockRelayChain?.chainId === chainId ? mockRelayChain : null
}));

const mockFetchRelayAccount = jest.fn(async (_query: RelayAccountQuery): Promise<RelayAccount> => ACCOUNT);
jest.mock('./client', () => ({
  fetchRelayAccount: (query: RelayAccountQuery) => mockFetchRelayAccount(query)
}));

function renderRelayAccount(target: RelayAccountTarget, active = true) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PageActiveContext.Provider value={active}>{children}</PageActiveContext.Provider>
    </SWRConfig>
  );
  return renderHook(() => useRelayAccount(target), { wrapper });
}

beforeEach(() => {
  mockRelayChain = CHAIN;
  mockFetchRelayAccount.mockReset().mockResolvedValue(ACCOUNT);
});

describe('useRelayAccount', () => {
  it('reads the account with its tokens while the page is on screen', async () => {
    const tokens: Address[] = [upperHex(USDC), NATIVE];
    const { result } = renderRelayAccount({ chainId: CHAIN.chainId, address: RELAY_ADDRESS, tokens });

    await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));
    expect(mockFetchRelayAccount).toHaveBeenCalledWith({ chainId: CHAIN.chainId, address: RELAY_ADDRESS, tokens });
    expect(result.current.error).toBeUndefined();
  });

  it('reads again on refresh', async () => {
    const { result } = renderRelayAccount({ chainId: CHAIN.chainId, address: RELAY_ADDRESS });
    await waitFor(() => expect(result.current.account).toEqual(ACCOUNT));
    const later = { ...ACCOUNT, balances: [{ token: USDC, balance: 9n }] };
    mockFetchRelayAccount.mockResolvedValue(later);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.account).toEqual(later);
    expect(mockFetchRelayAccount).toHaveBeenCalledWith({ chainId: CHAIN.chainId, address: RELAY_ADDRESS, tokens: [] });
  });

  it('gives an account that fails the guards as an error, never as data', async () => {
    mockFetchRelayAccount.mockResolvedValue({ ...ACCOUNT, executor: FEE_RECIPIENT });
    const { result } = renderRelayAccount({ chainId: CHAIN.chainId, address: RELAY_ADDRESS });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(RelayMismatchError));
    expect(result.current.account).toBeUndefined();
  });

  it.each<[string, RelayAccountTarget, boolean, RelayChainConfig | null]>([
    ['off screen', { chainId: CHAIN.chainId, address: RELAY_ADDRESS }, false, CHAIN],
    ['with no address', { chainId: CHAIN.chainId, address: undefined }, true, CHAIN],
    ['with no chain', { chainId: null, address: RELAY_ADDRESS }, true, CHAIN],
    ['while the relay does not serve the chain', { chainId: CHAIN.chainId, address: RELAY_ADDRESS }, true, null]
  ])('reads nothing %s', async (_name, target, active, chain) => {
    mockRelayChain = chain;
    const { result } = renderRelayAccount(target, active);

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchRelayAccount).not.toHaveBeenCalled();
    expect(result.current.account).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});
