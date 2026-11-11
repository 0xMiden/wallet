/** @jest-environment node */
import {
  chooseMainnetSwapLoop,
  planMainnetSwapLoop,
  swapSearchAmounts,
  type SwapHolding,
  type SwapLoopCandidate
} from '../playwright/e2e/helpers/mainnet-swap-plan';

const holding = (faucetId: string, balance = 10_000_000n): SwapHolding => ({
  faucetId, symbol: faucetId, decimals: 6, balance, usdMicros: 1_000_000n
});
const candidate = (): SwapLoopCandidate => {
  const a = holding('a');
  const b = holding('b');
  return {
    forward: { offered: a, requested: b, offer: 1_010_000n, minimumReceive: 1_009_000n, full: true, settlementsRunning: true },
    reverse: { offered: b, requested: a, offer: 1_009_000n, minimumReceive: 1_008_000n, full: true, settlementsRunning: true },
    native: holding('fee'), baseFee: 1n, recoveryTxs: 2n
  };
};

describe('nightly swap cost gate', () => {
  it('budgets six transactions and retains tomorrow plus recovery headroom', () => {
    expect(planMainnetSwapLoop(candidate())).toMatchObject({ worstCaseLossUsdMicros: 2_180n, nativeReserve: 360n });
  });
  it('accepts the exact $2 boundary and rejects one micro-dollar over it', () => {
    const c = candidate();
    c.forward.offer = 3_000_000n;
    c.forward.minimumReceive = 2_000_000n;
    c.reverse.offer = 2_000_000n;
    c.reverse.minimumReceive = 1_000_180n;
    expect(planMainnetSwapLoop(c).worstCaseLossUsdMicros).toBe(2_000_000n);
    c.reverse.minimumReceive--;
    expect(() => planMainnetSwapLoop(c)).toThrow(/cap/);
  });
  it('rejects forward proceeds below the return minimum even with existing B funds', () => {
    const c = candidate();
    c.forward.minimumReceive = c.reverse.offer = 999_999n;
    expect(() => planMainnetSwapLoop(c)).toThrow(/minimum/);
  });
  it('cannot use preexisting B to fund a larger return', () => {
    const c = candidate();
    c.reverse.offer++;
    expect(() => planMainnetSwapLoop(c)).toThrow(/proceeds/);
  });
  it('adds the native offer to the reserve rather than spending tomorrow fees', () => {
    const c = candidate();
    c.native = c.forward.offered = c.reverse.requested = holding('a', 1_010_359n);
    expect(() => planMainnetSwapLoop(c)).toThrow(/reserve/);
    c.native.balance++;
    expect(planMainnetSwapLoop(c).nativeReserve).toBe(360n);
  });
  it.each(['partial', 'paused', 'wrong pair', 'unfunded', 'zero fee', 'negative', 'bad decimals', 'unpriced'])('rejects %s input', mode => {
    const c = candidate();
    if (mode === 'partial') c.forward.full = false;
    if (mode === 'paused') c.reverse.settlementsRunning = false;
    if (mode === 'wrong pair') c.reverse.requested = holding('other');
    if (mode === 'unfunded') c.forward.offered.balance = 1n;
    if (mode === 'zero fee') c.baseFee = 0n;
    if (mode === 'negative') c.reverse.minimumReceive = -1n;
    if (mode === 'bad decimals') c.forward.offered.decimals = 13;
    if (mode === 'unpriced') c.native.usdMicros = 0n;
    expect(() => planMainnetSwapLoop(c)).toThrow();
  });
  it('reserves forward create and claim fees out of native intermediate proceeds', () => {
    const c = candidate();
    c.native = c.forward.requested = c.reverse.offered = holding('b');
    c.reverse.offer = 1_008_940n;
    expect(planMainnetSwapLoop(c).worstCaseLossUsdMicros).toBe(2_120n);
    c.reverse.offer = 1_009_000n;
    expect(() => planMainnetSwapLoop(c)).toThrow(/proceeds/);
  });
  it('rounds each network fee up conservatively', () => {
    const c = candidate();
    c.native.decimals = 12;
    expect(planMainnetSwapLoop(c).worstCaseLossUsdMicros).toBe(2_006n);
  });
  it('selects the lowest loss then the lowest principal, independent of registry order', () => {
    const costly = planMainnetSwapLoop(candidate());
    const c = candidate();
    c.reverse.minimumReceive = 1_008_500n;
    const cheap = planMainnetSwapLoop(c);
    expect(chooseMainnetSwapLoop([costly, cheap])).toBe(cheap);
    expect(chooseMainnetSwapLoop([])).toBeUndefined();
  });
  it('searches only bounded near-minimum amounts, never exceeding balance or $2 principal', () => {
    expect(swapSearchAmounts(holding('a'))).toEqual([1_000_000n, 1_010_000n, 1_020_000n, 1_050_000n, 1_100_000n, 1_250_000n, 1_500_000n, 2_000_000n]);
    expect(swapSearchAmounts(holding('a', 1_015_000n))).toEqual([1_000_000n, 1_010_000n]);
  });
});
