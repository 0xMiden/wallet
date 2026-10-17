import type { TokenBalanceData } from 'lib/miden/front/balance';

import {
  CLAIM_COST_FEE_MULTIPLE,
  claimFeeShortfalls,
  type ClaimFeeNote,
  hasNoFeeAsset,
  isWorthClaiming,
  maxSendableNative,
  totalClaimableAmount
} from './spendable';

const NATIVE = 'mtst1native';

// MIDEN's 6 decimals, so a base fee of 10000 base units is 0.01 in the
// decimal-scaled `balance` these rows carry. The scale is not decoration here:
// `hasNoFeeAsset` converts through it, and a row without it fails open.
// `null` means "the row carries no decimals at all", which is a distinct case
// from omitting the argument — passing `undefined` explicitly would just
// re-trigger the default.
const row = (tokenId: string, balance: number, decimals: number | null = 6): TokenBalanceData =>
  ({ tokenId, balance, metadata: decimals === null ? {} : { decimals } }) as TokenBalanceData;

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

  it('blocks a native balance too small to cover even one base fee', () => {
    // A non-zero balance is not the same as a payable one. At 6 decimals a base
    // fee of 10000 is 0.01 MIDEN, so 0.001 provably cannot pay it — and a plain
    // `balance <= 0` test let this account through to fail after biometric
    // confirmation, which is exactly what this guard exists to prevent.
    const balances = [row('TKN', 50), row(NATIVE, 0.001)];
    expect(hasNoFeeAsset(balances, NATIVE, 10000)).toBe(true);
  });

  it('allows a balance between one base fee and the send reserve', () => {
    // 0.05 MIDEN is 5x the base fee: under the 30x the send cap RESERVES, but
    // well over the ~17x a real transaction charges, so the send may well
    // succeed. Testing "certain to fail" against the worst case instead would
    // disable the form for an account that can pay.
    const balances = [row('TKN', 50), row(NATIVE, 0.05)];
    expect(hasNoFeeAsset(balances, NATIVE, 10000)).toBe(false);
  });

  it('fails open when the native row carries no decimals', () => {
    // Without a scale the comparison is arbitrary — 0.001 reads as either 1000
    // base units or 0.001 of them. Guessing could disable sending on a funded
    // account, so an unknown scale is treated like an unknown fee.
    const balances = [row('TKN', 50), row(NATIVE, 0.001, null)];
    expect(hasNoFeeAsset(balances, NATIVE, 10000)).toBe(false);
  });

  it('fails open on a placeholder scale, which carries a number it invented', () => {
    // The harder half of the same case, and the one a `typeof decimals === 'number'`
    // test alone lets through: `DEFAULT_TOKEN_METADATA` ships `decimals: 6` with
    // `scaleIsUnknown: true`, so the shape looks answerable while the 6 is a guess.
    // Scaling by it would block the form on arithmetic nobody stated.
    const placeholder: TokenBalanceData = {
      tokenId: NATIVE,
      balance: 0.001,
      metadata: { decimals: 6, scaleIsUnknown: true }
    } as TokenBalanceData;
    expect(hasNoFeeAsset([row('TKN', 50), placeholder], NATIVE, 10000)).toBe(false);
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

describe('claimFeeShortfalls', () => {
  // Base units throughout, as notes arrive from the chain; the vault row is decimal-scaled at
  // MIDEN's 6 decimals, so 0.01 in a row is one base fee of 10000.
  const BASE = 10000;
  const nativeNote = (amount: number): ClaimFeeNote => ({ faucetId: NATIVE, amount: String(amount) });
  const tokenNote: ClaimFeeNote = { faucetId: 'TKN', amount: '5000000' };
  const otherNote: ClaimFeeNote = { faucetId: 'OTHER', amount: '5000000' };
  // Its second asset may be the fee asset.
  const multi: ClaimFeeNote = { ...tokenNote, carriesMoreAssets: true };
  const empty = [row('TKN', 50), row(NATIVE, 0)];

  it('refuses a claim of another token when the vault holds no fee asset', () => {
    // BREAD-WALLET-C: the consume was built, signed and failed on the fee every time.
    expect(claimFeeShortfalls([[tokenNote]], [], empty, NATIVE, BASE)).toEqual([true]);
  });

  it('lets a new wallet claim its first fee asset out of the note itself', () => {
    // The kernel runs the note scripts before the auth procedure withdraws the fee, so the
    // note's own USDCX is in the vault by then.
    expect(claimFeeShortfalls([[nativeNote(BASE)]], [], empty, NATIVE, BASE)).toEqual([false]);
  });

  it('refuses a fee-asset note below one base fee on an empty vault', () => {
    expect(claimFeeShortfalls([[nativeNote(BASE - 1)]], [], empty, NATIVE, BASE)).toEqual([true]);
  });

  it('adds what the vault holds to what the notes carry', () => {
    // 0.006 held is 6000 units; with a 4000-unit note that is exactly one base fee.
    const balances = [row(NATIVE, 0.006)];
    expect(claimFeeShortfalls([[nativeNote(4000)]], [], balances, NATIVE, BASE)).toEqual([false]);
    expect(claimFeeShortfalls([[nativeNote(3999)]], [], balances, NATIVE, BASE)).toEqual([true]);
  });

  it('admits a claim holding a note with assets the list does not show', () => {
    expect(claimFeeShortfalls([[tokenNote, multi]], [], empty, NATIVE, BASE)).toEqual([false]);
  });

  it('judges each claim alone, so a multi-asset note never disables the check for an earlier one', () => {
    expect(claimFeeShortfalls([[tokenNote], [multi]], [], empty, NATIVE, BASE)).toEqual([true, false]);
    // Nor does a fee-asset claim fund the others: a caller adds a claim to `ahead` once it is queued.
    expect(claimFeeShortfalls([[tokenNote], [nativeNote(3 * BASE)], [otherNote]], [], empty, NATIVE, BASE)).toEqual([
      true,
      false,
      true
    ]);
  });

  it('admits every claim when a note that may run first carries the fee asset, whatever the order', () => {
    // The queue's order turns on rows the list cannot see, and the fees of what runs first are not
    // charged, so even one unit of the fee asset ahead admits.
    const transactions = [[tokenNote], [otherNote]];
    expect(claimFeeShortfalls(transactions, [tokenNote, nativeNote(1)], empty, NATIVE, BASE)).toEqual([false, false]);
    expect(claimFeeShortfalls(transactions, [nativeNote(1), tokenNote], empty, NATIVE, BASE)).toEqual([false, false]);
    expect(claimFeeShortfalls(transactions, [multi], empty, NATIVE, BASE)).toEqual([false, false]);
  });

  it('counts nothing ahead that carries no fee asset', () => {
    expect(claimFeeShortfalls([[tokenNote]], [tokenNote, otherNote], empty, NATIVE, BASE)).toEqual([true]);
  });

  it('fails open wherever hasNoFeeAsset does', () => {
    expect(claimFeeShortfalls([[tokenNote]], [], empty, NATIVE, null)).toEqual([false]);
    expect(claimFeeShortfalls([[tokenNote]], [], empty, NATIVE, 0)).toEqual([false]);
    expect(claimFeeShortfalls([[tokenNote]], [], empty, NATIVE, Number.NaN)).toEqual([false]);
    expect(claimFeeShortfalls([[tokenNote]], [], empty, null, BASE)).toEqual([false]);
    expect(claimFeeShortfalls([[tokenNote]], [], [row('TKN', 50)], NATIVE, BASE)).toEqual([false]);
    const placeholder = {
      tokenId: NATIVE,
      balance: 0.001,
      metadata: { decimals: 6, scaleIsUnknown: true }
    } as TokenBalanceData;
    expect(claimFeeShortfalls([[tokenNote]], [], [placeholder], NATIVE, BASE)).toEqual([false]);
  });

  it('fails open on a fee-asset amount that does not parse, for that claim only', () => {
    expect(
      claimFeeShortfalls([[{ faucetId: NATIVE, amount: 'not-a-number' }], [tokenNote]], [], empty, NATIVE, BASE)
    ).toEqual([false, true]);
  });

  it('judges a zero balance without a scale, as hasNoFeeAsset does', () => {
    expect(claimFeeShortfalls([[tokenNote]], [], [row(NATIVE, 0, null)], NATIVE, BASE)).toEqual([true]);
  });
});
