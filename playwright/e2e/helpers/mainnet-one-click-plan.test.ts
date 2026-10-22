import {
  MAINNET_ONE_CLICK_CAP_MICRO_USD,
  planOneClickRoundTrip,
  remainingOneClickCostBudget,
  searchSmallestViableAmount,
  tokenValueUsdMicro,
  usdToMicroDollarsCeil,
  type OneClickRoundTripCandidate
} from './mainnet-one-click-plan';

const candidate = (routeId: string, cost: bigint, available = 1_000n): OneClickRoundTripCandidate => ({
  routeId,
  symbol: 'USDC',
  amountBaseUnits: 100n,
  availableBaseUnits: available,
  forward: { inputUsdMicros: 100_000_000n, minimumOutputUsdMicros: 100_000_000n - cost / 2n, nativeFeeUsdMicros: 0n },
  reverse: { inputUsdMicros: 100_000_000n, minimumOutputUsdMicros: 100_000_000n - cost / 2n, nativeFeeUsdMicros: 0n }
});

describe('mainnet 1Click round-trip planner', () => {
  it('finds the smallest viable amount observed with a bounded dry-quote search', async () => {
    const attempted: bigint[] = [];
    const result = await searchSmallestViableAmount({
      firstAmount: 1n,
      maximumAmount: 1_000n,
      attempts: 4,
      quote: async amount => {
        attempted.push(amount);
        return amount >= 100n ? { amount } : undefined;
      }
    });

    expect(attempted).toEqual([1n, 10n, 100n]);
    expect(result.amount).toBe(100n);
  });

  it('covers the configured maximum across a 12-decimal range within the quote bound', async () => {
    const attempted: bigint[] = [];
    const maximumAmount = 1_000_000_000_000n;
    const result = await searchSmallestViableAmount({
      firstAmount: 1n,
      maximumAmount,
      attempts: 8,
      quote: async amount => {
        attempted.push(amount);
        return amount === maximumAmount ? { amount } : undefined;
      }
    });

    expect(result.amount).toBe(maximumAmount);
    expect(attempted[attempted.length - 1]).toBe(maximumAmount);
    expect(attempted).toHaveLength(7);
  });

  it('stops on non-minimum quote errors and fails when the configured search bound is exhausted', async () => {
    const failure = new Error('rate limited');
    await expect(searchSmallestViableAmount({
      firstAmount: 1n,
      maximumAmount: 1_000n,
      attempts: 3,
      quote: async () => { throw failure; }
    })).rejects.toBe(failure);

    await expect(searchSmallestViableAmount({
      firstAmount: 1n,
      maximumAmount: 1_000n,
      attempts: 2,
      quote: async () => undefined
    })).rejects.toThrow('bounded dry-quote search');
  });

  it('selects the lowest-cost funded route and treats the cap as a ceiling', () => {
    const plan = planOneClickRoundTrip([candidate('ethereum', 1_800_000n), candidate('base', 400_000n)]);

    expect(plan.routeId).toBe('base');
    expect(plan.worstCaseCostUsdMicros).toBe(400_000n);
  });

  it('accepts exactly $2.00 and rejects any amount above it', () => {
    expect(planOneClickRoundTrip([candidate('at-cap', MAINNET_ONE_CLICK_CAP_MICRO_USD)]).worstCaseCostUsdMicros)
      .toBe(MAINNET_ONE_CLICK_CAP_MICRO_USD);
    expect(() => planOneClickRoundTrip([candidate('over-cap', MAINNET_ONE_CLICK_CAP_MICRO_USD + 1n)]))
      .toThrow('$2.00 round-trip safety cap');
  });

  it('does not spend when the existing holding cannot cover the minimum principal', () => {
    expect(() => planOneClickRoundTrip([candidate('short', 1n, 99n)])).toThrow('No funded 1Click route');
  });

  it('includes both legs native fees and quote loss in the cap', () => {
    const item = candidate('fee-bound', 0n);
    item.forward.nativeFeeUsdMicros = 1_000_000n;
    item.reverse.nativeFeeUsdMicros = 1_000_001n;

    expect(() => planOneClickRoundTrip([item])).toThrow('$2.00 round-trip safety cap');
  });

  it('budgets the reverse leg against realized cost plus its worst case bound', () => {
    expect(remainingOneClickCostBudget(700_000n, 1_300_000n)).toBe(1_300_000n);
    expect(() => remainingOneClickCostBudget(700_000n, 1_300_001n)).toThrow('$2.00 round-trip safety cap');
  });

  it('rounds USD values upward to micro-dollars and rejects ambiguous numeric forms', () => {
    expect(usdToMicroDollarsCeil('0.0000001')).toBe(1n);
    expect(usdToMicroDollarsCeil('1.250000')).toBe(1_250_000n);
    expect(() => usdToMicroDollarsCeil('1e-7')).toThrow('without exponent notation');
  });

  it('values token amounts from pinned prices with conservative direction-specific rounding', () => {
    expect(tokenValueUsdMicro(1n, 6, 1_000_000n, true)).toBe(1n);
    expect(tokenValueUsdMicro(1n, 6, 1_000_000n, false)).toBe(1n);
    expect(tokenValueUsdMicro(1n, 8, 1n, true)).toBe(1n);
    expect(tokenValueUsdMicro(1n, 8, 1n, false)).toBe(0n);
  });
});
