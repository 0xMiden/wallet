import type { TokenBalanceData } from 'lib/miden/front/balance';

import {
  CLAIM_COST_FEE_MULTIPLE,
  hasNoFeeAsset,
  isWorthClaiming,
  maxSendableNative,
  totalClaimableAmount
} from './spendable';

const NATIVE = 'mtst1native';

const row = (tokenId: string, balance: number): TokenBalanceData => ({ tokenId, balance }) as TokenBalanceData;

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
  const BASE = 10000;
  // A conservative UPPER bound on what one transaction costs.
  const FLOOR = BigInt(BASE) * BigInt(CLAIM_COST_FEE_MULTIPLE);

  it('rejects a claim worth less than the fee it will pay', () => {
    expect(isWorthClaiming(FLOOR - 1n, BASE)).toBe(false);
  });

  it('rejects a claim worth exactly the fee, which nets the user nothing', () => {
    expect(isWorthClaiming(FLOOR, BASE)).toBe(false);
  });

  it('accepts a claim worth more than the fee', () => {
    expect(isWorthClaiming(FLOOR + 1n, BASE)).toBe(true);
  });

  it('rejects a claim that beats ONE base fee but not the fee it really costs', () => {
    // The base fee is the per-cycle-tier UNIT, not a transaction's cost: the kernel
    // charges `baseFee x (floor(log2(cycles)) + 1)`, near 17x in practice. Comparing
    // against one base fee auto-claimed everything between 1x and ~17x at a net LOSS,
    // which is exactly the dust-flood griefing vector this check refuses.
    expect(isWorthClaiming(BigInt(BASE) + 1n, BASE)).toBe(false);
    expect(isWorthClaiming(BigInt(BASE) * 2n, BASE)).toBe(false);
  });

  it('rejects a claim that clears a LOWER bound on the cost but not the real cost', () => {
    // Why the multiple is an upper bound and not a lower one. At the ~17x charge, a
    // threshold of 8x admits a 10x claim that loses ~7x -- and since a batch total is
    // what is measured, the attacker picks the note count and can always land a pile of
    // dust just above a low threshold. Both bounds answer "will this transaction leave
    // the user better off", so both must come from the same side.
    expect(isWorthClaiming(BigInt(BASE) * 8n, BASE)).toBe(false);
    expect(isWorthClaiming(BigInt(BASE) * 17n, BASE)).toBe(false);
  });

  it('accepts any note on a chain that charges nothing', () => {
    expect(isWorthClaiming(1n, 0)).toBe(true);
  });

  it('accepts a note whose amount is a decimal string', () => {
    expect(isWorthClaiming((FLOOR + 1n).toString(), BASE)).toBe(true);
    expect(isWorthClaiming((FLOOR - 1n).toString(), BASE)).toBe(false);
  });

  it('does not throw on a non-integral base fee', () => {
    // `BigInt(10000.5)` is a RangeError, and this conversion sits outside the guard
    // that protects the amount parse -- so a fractional fee would take down the
    // unattended consumer for every note.
    expect(() => isWorthClaiming(1_000_000n, 10000.5)).not.toThrow();
    expect(isWorthClaiming(1_000_000n, 10000.5)).toBe(true);
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

describe('totalClaimableAmount', () => {
  const BASE = 10000;

  it('sums the notes that will share one transaction', () => {
    expect(totalClaimableAmount([1n, '2', 3n])).toBe(6n);
  });

  it('lets a batch of individually-marginal notes clear the floor', () => {
    // The stranding bug. Judged per note, twenty notes worth 5x the base fee each were
    // ALL refused -- yet they total 100x and one transaction settles them for one fee.
    const notes = Array.from({ length: 20 }, () => BigInt(BASE) * 5n);
    expect(notes.every(note => isWorthClaiming(note, BASE))).toBe(false);
    expect(isWorthClaiming(totalClaimableAmount(notes), BASE)).toBe(true);
  });

  it('still refuses a dust flood whose total only just clears a LOW threshold', () => {
    // The other direction, which the attacker controls: a hundred dust notes summing to
    // just over 8x the base fee would be swept for a fee near 17x. The upper-bound
    // multiple is what refuses this, and it is why the total alone is not enough.
    const dust = Array.from({ length: 100 }, () => BigInt(BASE) / 100n);
    expect(totalClaimableAmount(dust)).toBe(BigInt(BASE));
    expect(isWorthClaiming(totalClaimableAmount(dust), BASE)).toBe(false);
  });

  it('skips unparseable and missing amounts instead of throwing', () => {
    // Same reason `isWorthClaiming` fails open: one malformed chain value must not stop
    // the whole unattended pass.
    expect(totalClaimableAmount([1n, null, undefined, 'not-a-number', '2'])).toBe(3n);
  });

  it('is 0 for no notes', () => {
    expect(totalClaimableAmount([])).toBe(0n);
  });
});
