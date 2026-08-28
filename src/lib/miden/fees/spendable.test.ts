import type { TokenBalanceData } from 'lib/miden/front/balance';

import { hasNoFeeAsset, isWorthClaiming, maxSendableNative } from './spendable';

const NATIVE = 'mtst1native';

const row = (tokenId: string, balance: number): TokenBalanceData =>
  ({ tokenId, balance }) as TokenBalanceData;

describe('hasNoFeeAsset', () => {
  it('blocks when the chain charges a fee and the account holds none of the fee asset', () => {
    const balances = [row('TKN', 50), row(NATIVE, 0)];
    expect(hasNoFeeAsset(balances, NATIVE, 10000)).toBe(true);
  });

  it('allows the send when the account holds some of the fee asset', () => {
    const balances = [row('TKN', 50), row(NATIVE, 1)];
    expect(hasNoFeeAsset(balances, NATIVE, 10000)).toBe(false);
  });

  it('allows the send on a chain that charges nothing', () => {
    // Testnet runs at base fee 0, where an empty native balance is irrelevant.
    const balances = [row('TKN', 50), row(NATIVE, 0)];
    expect(hasNoFeeAsset(balances, NATIVE, 0)).toBe(false);
  });

  it('fails open while the fee is still unknown', () => {
    // null is "not discovered yet", not "free". Blocking here would lock the send
    // form during startup on every chain, fee-charging or not.
    const balances = [row('TKN', 50), row(NATIVE, 0)];
    expect(hasNoFeeAsset(balances, NATIVE, null)).toBe(false);
  });

  it('fails open while the native asset id is still unknown', () => {
    // Pre-discovery `fetchBalances` omits the native row entirely, so an absent
    // row is indistinguishable from a zero one -- it must not be read as empty.
    const balances = [row('TKN', 50)];
    expect(hasNoFeeAsset(balances, undefined, 10000)).toBe(false);
  });

  it('fails open when the native row has not arrived yet', () => {
    const balances = [row('TKN', 50)];
    expect(hasNoFeeAsset(balances, NATIVE, 10000)).toBe(false);
  });
});

describe('maxSendableNative', () => {
  // MIDEN has 6 decimals: a base fee of 10000 is 0.01 in display units, so a 30x
  // reserve is 0.3 -- NOT 300000. Subtracting the raw base-unit figure from a
  // decimal-scaled balance would reserve 300000 MIDEN and disable every send.
  const DECIMALS = 6;

  it('reserves thirty times the base fee, converted into display units', () => {
    expect(maxSendableNative(1, 10000, DECIMALS)).toBeCloseTo(0.7, 9);
  });

  it('returns the whole balance on a chain that charges nothing', () => {
    expect(maxSendableNative(1, 0, DECIMALS)).toBe(1);
  });

  it('returns the whole balance while the fee is unknown', () => {
    expect(maxSendableNative(1, null, DECIMALS)).toBe(1);
  });

  it('never returns a negative amount when the reserve exceeds the balance', () => {
    expect(maxSendableNative(0.1, 10000, DECIMALS)).toBe(0);
  });
});

describe('isWorthClaiming', () => {
  // Unlike the send cap, both sides here are already in base units: a note's
  // amount comes off the chain unscaled, as does the fee. No decimals conversion.
  it('rejects a note worth less than the fee to claim it', () => {
    expect(isWorthClaiming(9999n, 10000)).toBe(false);
  });

  it('rejects a note worth exactly the fee, which nets the user nothing', () => {
    expect(isWorthClaiming(10000n, 10000)).toBe(false);
  });

  it('accepts a note worth more than the fee', () => {
    expect(isWorthClaiming(10001n, 10000)).toBe(true);
  });

  it('accepts any note on a chain that charges nothing', () => {
    expect(isWorthClaiming(1n, 0)).toBe(true);
  });

  it('accepts a note whose amount is a decimal string', () => {
    expect(isWorthClaiming('10001', 10000)).toBe(true);
    expect(isWorthClaiming('9999', 10000)).toBe(false);
  });

  it('accepts a note whose amount is missing rather than crashing the consumer', () => {
    // This runs inside an unattended loop: throwing here would take down claiming
    // for every note, not just the malformed one. Fail open -- never strand value.
    expect(isWorthClaiming(undefined, 10000)).toBe(true);
    expect(isWorthClaiming('not-a-number', 10000)).toBe(true);
  });

  it('accepts any note while the fee is unknown', () => {
    // Fail open: refusing to claim during startup would strand real value.
    expect(isWorthClaiming(1n, null)).toBe(true);
  });
});
