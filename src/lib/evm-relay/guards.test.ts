import type { Address } from 'viem';

import { RelayMismatchError } from './errors';
import { acceptedFee, assertRelayAccountMatches, assertRelayJobMatches } from './guards';
import {
  CHAIN,
  EXECUTOR,
  FEE_RECIPIENT,
  JOB_ID,
  NATIVE,
  RELAY_ADDRESS,
  SALT,
  TX_HASH,
  USDC,
  upperHex
} from './testing';
import type { RelayAccount, RelayJob } from './types';

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
    sequence: 0n,
    fees: [],
    allowedTargets: null,
    balances: [],
    ...overrides
  };
}

function deduct(fee: bigint, token: Address = USDC): RelayAccount {
  return account({ mode: 'deduct', feeRecipient: FEE_RECIPIENT, fees: [{ token, fee }] });
}

describe('assertRelayAccountMatches', () => {
  it('accepts a matching sponsor account, in any address case', () => {
    expect(() => assertRelayAccountMatches(account(), CHAIN, RELAY_ADDRESS)).not.toThrow();
    expect(() => assertRelayAccountMatches(account(), CHAIN, upperHex(RELAY_ADDRESS))).not.toThrow();
  });

  it('accepts a matching deduct account, with or without fees', () => {
    expect(() => assertRelayAccountMatches(deduct(10n), CHAIN, RELAY_ADDRESS)).not.toThrow();
    const noFees = account({ mode: 'deduct', feeRecipient: FEE_RECIPIENT });
    expect(() => assertRelayAccountMatches(noFees, CHAIN, RELAY_ADDRESS)).not.toThrow();
  });

  it.each([
    ['another chain', account({ chainId: 1 })],
    ['another address', account({ address: FEE_RECIPIENT })],
    ['another executor', account({ executor: FEE_RECIPIENT })],
    ['a sponsor account with a fee recipient', account({ feeRecipient: FEE_RECIPIENT })],
    ['a sponsor account with a fee', account({ fees: [{ token: USDC, fee: 1n }] })],
    ['a deduct account without a fee recipient', account({ mode: 'deduct' })],
    ['a deduct account with the zero fee recipient', account({ mode: 'deduct', feeRecipient: NATIVE })]
  ])('refuses %s', (_name, value) => {
    expect(() => assertRelayAccountMatches(value, CHAIN, RELAY_ADDRESS)).toThrow(RelayMismatchError);
  });

  it('refuses a gas mode that it does not know', () => {
    const value = account();
    Reflect.set(value, 'mode', 'free');
    expect(() => assertRelayAccountMatches(value, CHAIN, RELAY_ADDRESS)).toThrow('the gas mode is not known');
  });
});

describe('acceptedFee', () => {
  it('gives 0 in sponsor mode', () => {
    expect(acceptedFee(account(), CHAIN, USDC)).toBe(0n);
  });

  it.each([
    ['below the limit', 1n, 1n],
    ['at the limit', 50_000n, 50_000n],
    ['above the limit', 50_001n, null],
    ['of 0', 0n, null]
  ])('in deduct mode, takes a fee %s', (_name, fee, expected) => {
    expect(acceptedFee(deduct(fee), CHAIN, upperHex(USDC))).toBe(expected);
  });

  it('in deduct mode, refuses a token without a maxFee entry', () => {
    expect(acceptedFee(deduct(1n, NATIVE), CHAIN, NATIVE)).toBeNull();
  });

  it('in deduct mode, refuses a token for which the relayer names no fee', () => {
    expect(acceptedFee(deduct(1n, NATIVE), CHAIN, USDC)).toBeNull();
  });

  it('refuses a gas mode that it does not know', () => {
    const value = deduct(1n);
    Reflect.set(value, 'mode', 'free');
    expect(acceptedFee(value, CHAIN, USDC)).toBeNull();
  });
});

describe('assertRelayJobMatches', () => {
  const job: RelayJob = { id: JOB_ID, state: 'pending', txHash: TX_HASH };

  it('accepts the expected id in any case', () => {
    expect(() => assertRelayJobMatches(job, upperHex(JOB_ID))).not.toThrow();
  });

  it('refuses another id', () => {
    expect(() => assertRelayJobMatches({ ...job, id: TX_HASH }, JOB_ID)).toThrow(RelayMismatchError);
  });
});
