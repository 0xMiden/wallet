import { renderHook } from '@testing-library/react';

import type { PendingRelayDeposit } from './pending-deposit';
import { EXECUTOR, RELAY_ADDRESS, SALT, upperHex, USDC } from './testing';
import type { RelayAccount } from './types';
import { depositArrivalOf, useDepositArrival } from './use-deposit-arrival';

const mockUseRelayAccount = jest.fn();
jest.mock('./use-relay-account', () => ({
  useRelayAccount: (target: unknown) => mockUseRelayAccount(target)
}));

const DEPOSIT: PendingRelayDeposit = {
  id: 'deposit-1',
  accountPublicKey: 'miden-account',
  address: RELAY_ADDRESS,
  chainId: 8453,
  route: 'agglayer',
  token: { address: USDC, symbol: 'USDC', decimals: 6 },
  amount: '10',
  amountBaseUnits: '10000000',
  createdAt: 1
};

function account(balance: bigint | null, overrides: Partial<RelayAccount> = {}): RelayAccount {
  return {
    chainId: 8453,
    address: RELAY_ADDRESS,
    mode: 'sponsor',
    executor: EXECUTOR,
    feeRecipient: null,
    needsAuthorization: true,
    authorizationNonce: 0,
    salt: SALT,
    sequence: 0n,
    feeTokens: [],
    allowedTargets: null,
    balances: balance === null ? [] : [{ token: USDC, balance }],
    ...overrides
  };
}

beforeEach(() => {
  mockUseRelayAccount.mockReset().mockReturnValue({ account: undefined, error: undefined, isLoading: true });
});

describe('depositArrivalOf', () => {
  it.each<[bigint | null, string]>([
    [null, 'waiting'],
    [0n, 'waiting'],
    [1n, 'partial'],
    [9_999_999n, 'partial'],
    [10_000_000n, 'arrived'],
    [20_000_000n, 'arrived']
  ])('reads a balance of %p as %s', (balance, state) => {
    expect(depositArrivalOf(balance, 10_000_000n)).toEqual({ state, balance });
  });
});

describe('useDepositArrival', () => {
  it('reads the one token of the deposit at its address on its chain', () => {
    renderHook(() => useDepositArrival(DEPOSIT));
    expect(mockUseRelayAccount).toHaveBeenCalledWith({ chainId: 8453, address: RELAY_ADDRESS, tokens: [USDC] });
  });

  it('reads nothing for no deposit', () => {
    const { result } = renderHook(() => useDepositArrival(null));
    expect(mockUseRelayAccount).toHaveBeenCalledWith({ chainId: undefined, address: undefined, tokens: [] });
    expect(result.current).toEqual({
      state: 'waiting',
      balance: null,
      needsAuthorization: null,
      mode: null,
      error: undefined
    });
  });

  it('waits with no balance before the first read that passes, and keeps the error', () => {
    const failure = new Error('offline');
    mockUseRelayAccount.mockReturnValue({ account: undefined, error: failure, isLoading: false });
    const { result } = renderHook(() => useDepositArrival(DEPOSIT));
    expect(result.current).toMatchObject({ state: 'waiting', balance: null, error: failure });
  });

  it('is partial below the reviewed amount and arrived at it, with the account facts', () => {
    mockUseRelayAccount.mockReturnValue({ account: account(4_000_000n), error: undefined, isLoading: false });
    const { result, rerender } = renderHook(() => useDepositArrival(DEPOSIT));
    expect(result.current).toEqual({
      state: 'partial',
      balance: 4_000_000n,
      needsAuthorization: true,
      mode: 'sponsor',
      error: undefined
    });

    mockUseRelayAccount.mockReturnValue({
      account: account(10_000_000n, { needsAuthorization: false, mode: 'deduct' }),
      error: undefined,
      isLoading: false
    });
    rerender();
    expect(result.current).toMatchObject({
      state: 'arrived',
      balance: 10_000_000n,
      needsAuthorization: false,
      mode: 'deduct'
    });
  });

  it('matches the token in any letter case, and waits when the answer has no balance of it', () => {
    mockUseRelayAccount.mockReturnValue({
      account: account(null, { balances: [{ token: upperHex(USDC), balance: 10_000_000n }] }),
      error: undefined,
      isLoading: false
    });
    const { result, rerender } = renderHook(() => useDepositArrival(DEPOSIT));
    expect(result.current.state).toBe('arrived');

    mockUseRelayAccount.mockReturnValue({ account: account(null), error: undefined, isLoading: false });
    rerender();
    expect(result.current).toMatchObject({ state: 'waiting', balance: null });
  });
});
