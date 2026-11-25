import type { Address } from 'viem';

import { RelayMismatchError } from './errors';
import { acceptedFee, assertRelayAccountMatches, assertRelayJobMatches, relayableAmount } from './guards';
import { CHAIN, EXECUTOR, FEE_RECIPIENT, JOB_ID, NATIVE, RELAY_ADDRESS, SALT, TX_HASH, USDC } from './testing';
import type { RelayAccount, RelayJob, RelayTokenBalance } from './types';

function account(overrides: Partial<RelayAccount> = {}): RelayAccount {
  return {
    chainId: 8453,
    address: RELAY_ADDRESS,
    mode: 'sponsor',
    executor: EXECUTOR,
    feeRecipient: null,
    needsAuthorization: false,
    authorizationNonce: 4,
    salt: SALT,
    kinds: { 'agglayer-deposit': { sequence: 0n } },
    balances: [{ token: USDC, balance: 1_000_000n, minAmount: 100_000n, fee: 0n }],
    ...overrides
  };
}

function deduct(fee: bigint, token: Address = USDC): RelayAccount {
  return account({
    mode: 'deduct',
    feeRecipient: FEE_RECIPIENT,
    balances: [{ token, balance: 1_000_000n, minAmount: 100_000n, fee }]
  });
}

describe('assertRelayAccountMatches', () => {
  it('accepts a matching sponsor account, in any address case', () => {
    expect(() => assertRelayAccountMatches(account(), CHAIN, RELAY_ADDRESS)).not.toThrow();
    const upper: Address = `0x${RELAY_ADDRESS.slice(2).toUpperCase()}`;
    expect(() => assertRelayAccountMatches(account(), CHAIN, upper)).not.toThrow();
  });

  it('accepts a matching deduct account', () => {
    expect(() => assertRelayAccountMatches(deduct(10n), CHAIN, RELAY_ADDRESS)).not.toThrow();
  });

  it.each([
    ['another chain', account({ chainId: 1 })],
    ['another address', account({ address: FEE_RECIPIENT })],
    ['another executor', account({ executor: FEE_RECIPIENT })],
    ['a sponsor account with a fee recipient', account({ feeRecipient: FEE_RECIPIENT })],
    ['a sponsor account with a fee', account({ balances: [{ token: USDC, balance: 1n, minAmount: 1n, fee: 1n }] })],
    ['a deduct account without a fee recipient', account({ mode: 'deduct' })],
    ['a deduct account with the zero fee recipient', account({ mode: 'deduct', feeRecipient: NATIVE })]
  ])('refuses %s', (_name, value) => {
    expect(() => assertRelayAccountMatches(value, CHAIN, RELAY_ADDRESS)).toThrow(RelayMismatchError);
  });
});

describe('acceptedFee', () => {
  it('gives 0 for a sponsored token', () => {
    expect(acceptedFee(account(), CHAIN, USDC)).toBe(0n);
  });

  it('refuses a sponsored token that asks for a fee', () => {
    const value = account({ balances: [{ token: USDC, balance: 1n, minAmount: 1n, fee: 1n }] });
    expect(acceptedFee(value, CHAIN, USDC)).toBeNull();
  });

  it('refuses a token that is not in the balances', () => {
    expect(acceptedFee(account(), CHAIN, NATIVE)).toBeNull();
  });

  it.each([
    ['below the limit', 1n, 1n],
    ['at the limit', 50_000n, 50_000n],
    ['above the limit', 50_001n, null],
    ['of 0', 0n, null]
  ])('in deduct mode, takes a fee %s', (_name, fee, expected) => {
    expect(acceptedFee(deduct(fee), CHAIN, `0x${USDC.slice(2).toUpperCase()}`)).toBe(expected);
  });

  it('in deduct mode, refuses a token without a maxFee entry', () => {
    expect(acceptedFee(deduct(1n, NATIVE), CHAIN, NATIVE)).toBeNull();
  });
});

describe('relayableAmount', () => {
  const balance = (value: bigint, minAmount = 100n): RelayTokenBalance => ({
    token: USDC,
    balance: value,
    minAmount,
    fee: 0n
  });

  it.each([
    ['a balance above the minimum', balance(1000n), 10n, 990n],
    ['a balance at the minimum', balance(100n), 0n, 100n],
    ['a balance below the minimum', balance(99n), 0n, null],
    ['a fee equal to the balance', balance(100n), 100n, null],
    ['a fee above the balance', balance(100n), 101n, null],
    ['a negative fee', balance(1000n), -1n, null],
    ['a zero balance with a zero minimum', balance(0n, 0n), 0n, null]
  ])('handles %s', (_name, value, fee, expected) => {
    expect(relayableAmount(value, fee)).toBe(expected);
  });
});

describe('assertRelayJobMatches', () => {
  const job: RelayJob = { id: JOB_ID, state: 'pending', txHash: TX_HASH };

  it('accepts the expected id in any case', () => {
    expect(() => assertRelayJobMatches(job, `0x${JOB_ID.slice(2).toUpperCase()}`)).not.toThrow();
  });

  it('refuses another id', () => {
    expect(() => assertRelayJobMatches({ ...job, id: TX_HASH }, JOB_ID)).toThrow(RelayMismatchError);
  });
});
