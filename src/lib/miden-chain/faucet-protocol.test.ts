import { faucetCapFromRefusal, faucetGrantAmount, faucetRateLimitSeconds } from './faucet-protocol';

describe('faucetGrantAmount', () => {
  it('asks for the largest offered token amount, in base units', () => {
    expect(faucetGrantAmount({ base_amount: 100_000_000, token_amounts: [1, 10, 100], decimals: 6 })).toBe(
      100_000_000n
    );
    expect(faucetGrantAmount({ base_amount: 100_000_000, token_amounts: [10, 1], decimals: 6 })).toBe(10_000_000n);
  });

  it('keeps the offered amount when base_amount is malformed', () => {
    expect(faucetGrantAmount({ base_amount: '1', token_amounts: [5], decimals: 0 })).toBe(5n);
  });

  it('computes an amount past the safe-integer range exactly', () => {
    expect(faucetGrantAmount({ token_amounts: [1_000_000], decimals: 19 })).toBe(10n ** 25n);
  });

  it.each([
    { name: 'no token amounts (faucet 0.17.0)', metadata: { base_amount: 10_000, decimals: 6 } },
    { name: 'an empty list', metadata: { base_amount: 10_000, token_amounts: [], decimals: 6 } },
    { name: 'a zero amount', metadata: { base_amount: 10_000, token_amounts: [0, 10], decimals: 6 } },
    { name: 'a string amount', metadata: { base_amount: 10_000, token_amounts: ['10'], decimals: 6 } },
    { name: 'a fractional amount', metadata: { base_amount: 10_000, token_amounts: [1.5], decimals: 6 } },
    { name: 'a null list', metadata: { base_amount: 10_000, token_amounts: null, decimals: 6 } },
    { name: 'an object', metadata: { base_amount: 10_000, token_amounts: {}, decimals: 6 } },
    { name: 'no decimals', metadata: { base_amount: 10_000, token_amounts: [10] } },
    { name: 'negative decimals', metadata: { base_amount: 10_000, token_amounts: [10], decimals: -1 } },
    { name: 'fractional decimals', metadata: { base_amount: 10_000, token_amounts: [10], decimals: 1.5 } },
    { name: 'decimals past a u64', metadata: { base_amount: 10_000, token_amounts: [10], decimals: 20 } }
  ])('falls back to base_amount for $name', ({ metadata }) => {
    expect(faucetGrantAmount(metadata)).toBe(10_000n);
  });

  it.each([undefined, null, 'metadata', {}, { base_amount: 0 }, { base_amount: Number.MAX_SAFE_INTEGER + 1 }])(
    'rejects %p, which offers no usable amount, with the message both suites match',
    metadata => {
      expect(() => faucetGrantAmount(metadata)).toThrow('Faucet metadata base_amount must be a positive safe integer');
    }
  );
});

describe('faucetCapFromRefusal', () => {
  it('reads the cap a refusal names, exactly', () => {
    expect(faucetCapFromRefusal('requested amount 100000000 exceeds the maximum claimable amount of 10000000')).toBe(
      10_000_000n
    );
    expect(
      faucetCapFromRefusal('requested amount 1 exceeds the maximum claimable amount of 18446744073709551615')
    ).toBe(18_446_744_073_709_551_615n);
  });

  it.each([
    'requested amount 1000 exceeds the maximum claimable amount',
    'requested amount 1000 exceeds the maximum claimable amount of N/A',
    'Please enter a valid recipient address',
    ''
  ])('reads no cap from %p', detail => {
    expect(faucetCapFromRefusal(detail)).toBeNull();
  });
});

describe('faucetRateLimitSeconds', () => {
  it.each([
    { detail: 'Account is rate limited for 25 more seconds.', seconds: 25 },
    { detail: 'Account is rate limited for 1 more second.', seconds: 1 },
    { detail: 'requestor is rate limited for 0 more seconds', seconds: 0 }
  ])('reads the wait in $detail', ({ detail, seconds }) => {
    expect(faucetRateLimitSeconds(detail)).toBe(seconds);
  });

  it.each(['Account is rate limited.', 'rate limited for 99999999999999999999 more seconds', ''])(
    'reads no wait from %p',
    detail => {
      expect(faucetRateLimitSeconds(detail)).toBeNull();
    }
  );
});
