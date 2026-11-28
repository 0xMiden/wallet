import type { Address } from 'viem';

import { RelayMismatchError, RelayRefusedError } from './errors';
import {
  assertFeeWithinCap,
  assertRelayAccountMatches,
  assertRelayJobMatches,
  assertRelayQuoteMatches,
  assertRelayTakesFeeToken,
  deductFeeRecipient,
  relayFeeToken
} from './guards';
import {
  CHAIN,
  EXECUTOR,
  FEE_RECIPIENT,
  JOB_ID,
  NATIVE,
  QUOTE_PROOF,
  RELAY_ADDRESS,
  SALT,
  TX_HASH,
  USDC,
  upperHex
} from './testing';
import type { RelayAccount, RelayJob, RelayQuote } from './types';

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
    feeTokens: [],
    allowedTargets: null,
    balances: [],
    ...overrides
  };
}

function deduct(feeTokens: Address[] = [NATIVE, USDC]): RelayAccount {
  return account({ mode: 'deduct', feeRecipient: FEE_RECIPIENT, feeTokens });
}

describe('assertRelayAccountMatches', () => {
  it('accepts a matching sponsor account, in any address case', () => {
    expect(() => assertRelayAccountMatches(account(), CHAIN, RELAY_ADDRESS)).not.toThrow();
    expect(() => assertRelayAccountMatches(account(), CHAIN, upperHex(RELAY_ADDRESS))).not.toThrow();
  });

  it('accepts a matching deduct account, with or without fee tokens', () => {
    expect(() => assertRelayAccountMatches(deduct(), CHAIN, RELAY_ADDRESS)).not.toThrow();
    const noFees = account({ mode: 'deduct', feeRecipient: FEE_RECIPIENT });
    expect(() => assertRelayAccountMatches(noFees, CHAIN, RELAY_ADDRESS)).not.toThrow();
  });

  it.each([
    ['another chain', account({ chainId: 1 })],
    ['another address', account({ address: FEE_RECIPIENT })],
    ['another executor', account({ executor: FEE_RECIPIENT })],
    ['a sponsor account with a fee recipient', account({ feeRecipient: FEE_RECIPIENT })],
    ['a sponsor account with a fee token', account({ feeTokens: [NATIVE] })],
    ['a deduct account without a fee recipient', account({ mode: 'deduct' })],
    ['a deduct account with the zero fee recipient', account({ mode: 'deduct', feeRecipient: NATIVE })],
    ['a deduct account with another fee recipient', account({ mode: 'deduct', feeRecipient: EXECUTOR })]
  ])('refuses %s', (_name, value) => {
    expect(() => assertRelayAccountMatches(value, CHAIN, RELAY_ADDRESS)).toThrow(RelayMismatchError);
  });

  it('takes the executor as the fee recipient on a chain without a configured fee recipient', () => {
    const chain = { ...CHAIN, feeRecipient: undefined };
    const toExecutor = account({ mode: 'deduct', feeRecipient: upperHex(EXECUTOR), feeTokens: [NATIVE, USDC] });
    expect(() => assertRelayAccountMatches(toExecutor, chain, RELAY_ADDRESS)).not.toThrow();
    // Another recipient is refused, also the one that another config names.
    expect(() => assertRelayAccountMatches(deduct(), chain, RELAY_ADDRESS)).toThrow(RelayMismatchError);
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

  it('gives the executor on a chain without a configured fee recipient, and refuses another recipient', () => {
    const chain = { ...CHAIN, feeRecipient: undefined };
    expect(deductFeeRecipient(account({ mode: 'deduct', feeRecipient: EXECUTOR }), chain)).toBe(EXECUTOR);
    expect(() => deductFeeRecipient(deduct(), chain)).toThrow('the fee recipient is not the configured fee recipient');
  });
});

/** The thrown value of `run`, or undefined. */
function thrown(run: () => void): unknown {
  try {
    run();
  } catch (caught) {
    return caught;
  }
  return undefined;
}

describe('assertRelayQuoteMatches', () => {
  const NOW = 1_800_000_000;
  function quote(overrides: Partial<RelayQuote> = {}): RelayQuote {
    return {
      chainId: 8453,
      token: USDC,
      recipient: FEE_RECIPIENT,
      fee: 1000n,
      ...QUOTE_PROOF,
      ...overrides
    };
  }

  it.each([
    ['below the limit', 1n],
    ['at the limit', 50_000n]
  ])('accepts a fee %s, for the asked token and the configured recipient in any case', (_name, fee) => {
    const value = quote({ fee, token: USDC, recipient: upperHex(FEE_RECIPIENT) });
    expect(() => assertRelayQuoteMatches(value, CHAIN, upperHex(USDC), NOW)).not.toThrow();
  });

  it('accepts a quote that is valid for one more second', () => {
    expect(() => assertRelayQuoteMatches(quote({ validUntil: NOW + 1 }), CHAIN, USDC, NOW)).not.toThrow();
  });

  it.each<[string, RelayQuote, Address, string]>([
    ['another chain', quote({ chainId: 1 }), USDC, 'the quote is for another chain'],
    [
      'another recipient',
      quote({ recipient: EXECUTOR }),
      USDC,
      'the fee recipient is not the configured fee recipient'
    ],
    ['another token', quote({ token: NATIVE }), USDC, 'the quote is for another fee token']
  ])('refuses a quote for %s as a mismatch', (_name, value, token, message) => {
    const error = thrown(() => assertRelayQuoteMatches(value, CHAIN, token, NOW));
    expect(error).toBeInstanceOf(RelayMismatchError);
    expect(error).toMatchObject({ message: `relay: ${message}` });
  });

  it('accepts only a quote that pays the executor on a chain without a configured fee recipient', () => {
    const chain = { ...CHAIN, feeRecipient: undefined };
    expect(() => assertRelayQuoteMatches(quote({ recipient: EXECUTOR }), chain, USDC, NOW)).not.toThrow();
    expect(() => assertRelayQuoteMatches(quote(), chain, USDC, NOW)).toThrow(
      'the fee recipient is not the configured fee recipient'
    );
  });

  it.each<[string, RelayQuote, Address, string]>([
    ['a fee above the limit', quote({ fee: 50_001n }), USDC, 'fee-not-accepted'],
    ['a fee of 0', quote({ fee: 0n }), USDC, 'fee-not-accepted'],
    ['a token without a maxFee entry', quote({ token: NATIVE }), NATIVE, 'fee-not-accepted'],
    ['a quote whose validUntil is now', quote({ validUntil: NOW }), USDC, 'quote-expired'],
    ['a quote whose validUntil is past', quote({ validUntil: NOW - 1 }), USDC, 'quote-expired']
  ])('refuses %s', (_name, value, token, reason) => {
    const error = thrown(() => assertRelayQuoteMatches(value, CHAIN, token, NOW));
    expect(error).toBeInstanceOf(RelayRefusedError);
    expect(error).toMatchObject({ reason });
  });

  it('refuses a fee token that is not an address with a TypeError', () => {
    expect(() => assertRelayQuoteMatches(quote(), CHAIN, '0x12', NOW)).toThrow(TypeError);
  });
});

describe('assertRelayTakesFeeToken', () => {
  it('accepts a token of the account, in any case', () => {
    expect(() => assertRelayTakesFeeToken(deduct(), upperHex(USDC))).not.toThrow();
    expect(() => assertRelayTakesFeeToken(deduct(), NATIVE)).not.toThrow();
  });

  it('refuses a token that the account does not name', () => {
    expect(thrown(() => assertRelayTakesFeeToken(deduct([NATIVE]), USDC))).toMatchObject({
      name: 'RelayRefusedError',
      reason: 'no-fee'
    });
  });
});

describe('assertFeeWithinCap and relayFeeToken', () => {
  it('reads the cap with the token in any case', () => {
    expect(() => assertFeeWithinCap(CHAIN, upperHex(USDC), 50_000n)).not.toThrow();
    expect(() => assertFeeWithinCap({ ...CHAIN, maxFee: { [upperHex(USDC)]: '5' } }, USDC, 5n)).not.toThrow();
  });

  it('gives the token in lower case and refuses a value that is not an address', () => {
    expect(relayFeeToken(upperHex(USDC))).toBe(USDC);
    expect(() => relayFeeToken('0x12')).toThrow(TypeError);
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
