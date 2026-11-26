import type { Address } from 'viem';

import { RelayMismatchError, RelayRefusedError } from './errors';
import { assertRelayAccountMatches, assertRelayJobMatches, deductFeeRecipient, reviewRelayFee } from './guards';
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
    ['a deduct account with the zero fee recipient', account({ mode: 'deduct', feeRecipient: NATIVE })],
    ['a deduct account with another fee recipient', account({ mode: 'deduct', feeRecipient: EXECUTOR })]
  ])('refuses %s', (_name, value) => {
    expect(() => assertRelayAccountMatches(value, CHAIN, RELAY_ADDRESS)).toThrow(RelayMismatchError);
  });

  it('refuses a deduct account on a chain without a configured fee recipient', () => {
    const chain = { ...CHAIN, feeRecipient: undefined };
    expect(() => assertRelayAccountMatches(deduct(10n), chain, RELAY_ADDRESS)).toThrow(RelayMismatchError);
    expect(() => assertRelayAccountMatches(account(), chain, RELAY_ADDRESS)).not.toThrow();
  });

  it('refuses a gas mode that it does not know', () => {
    const value = account();
    Reflect.set(value, 'mode', 'free');
    expect(() => assertRelayAccountMatches(value, CHAIN, RELAY_ADDRESS)).toThrow('the gas mode is not known');
  });
});

describe('deductFeeRecipient', () => {
  it('gives the configured fee recipient when the account names it, in any case', () => {
    expect(deductFeeRecipient(account({ mode: 'deduct', feeRecipient: upperHex(FEE_RECIPIENT) }), CHAIN)).toBe(
      FEE_RECIPIENT
    );
  });

  it('refuses a chain without a configured fee recipient', () => {
    expect(() => deductFeeRecipient(deduct(1n), { ...CHAIN, feeRecipient: undefined })).toThrow(
      'the chain does not take deduct mode'
    );
  });
});

describe('reviewRelayFee', () => {
  it('shows no fee in sponsor mode', () => {
    expect(reviewRelayFee(account(), CHAIN, USDC)).toEqual({ mode: 'sponsor' });
  });

  it.each([
    ['below the limit', 1n],
    ['at the limit', 50_000n]
  ])('in deduct mode, shows the relayer fee %s, with the token in lower case', (_name, fee) => {
    expect(reviewRelayFee(deduct(fee), CHAIN, upperHex(USDC))).toEqual({
      mode: 'deduct',
      fee: { token: USDC, amount: fee }
    });
  });

  it.each<[string, RelayAccount, Address, string]>([
    ['a fee above the limit', deduct(50_001n), USDC, 'fee-not-accepted'],
    ['a fee of 0', deduct(0n), USDC, 'fee-not-accepted'],
    ['a token without a maxFee entry', deduct(1n, NATIVE), NATIVE, 'fee-not-accepted'],
    ['a token for which the relayer names no fee', deduct(1n, NATIVE), USDC, 'no-fee']
  ])('in deduct mode, refuses %s', (_name, value, token, reason) => {
    let error: unknown;
    try {
      reviewRelayFee(value, CHAIN, token);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RelayRefusedError);
    expect(error).toMatchObject({ reason });
  });

  it('in deduct mode, refuses a chain without a configured fee recipient', () => {
    expect(() => reviewRelayFee(deduct(1n), { ...CHAIN, feeRecipient: undefined }, USDC)).toThrow(RelayMismatchError);
  });

  it('refuses a fee token that is not an address with a TypeError', () => {
    expect(() => reviewRelayFee(deduct(1n), CHAIN, '0x12')).toThrow(TypeError);
  });

  it('refuses a gas mode that it does not know', () => {
    const value = deduct(1n);
    Reflect.set(value, 'mode', 'free');
    expect(() => reviewRelayFee(value, CHAIN, USDC)).toThrow(RelayMismatchError);
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
