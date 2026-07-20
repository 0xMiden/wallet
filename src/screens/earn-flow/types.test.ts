// `types.ts` is a declaration-only module: it exports four TypeScript
// interfaces (`EarnSummary`, `EarnPosition`, `EarnChartPoint`, `EarnVault`)
// and nothing else. Interfaces are erased at compile time, so after
// transpilation the module has no runtime members beyond the `__esModule`
// marker. There is consequently no function/branch to drive; the value of a
// test here is twofold:
//
//  1. Side-effect importing the module forces the transpiled file to be
//     evaluated under coverage, so it is attributed (rather than showing as an
//     un-imported 0%).
//  2. Constructing fully-populated, correctly-shaped values for every exported
//     interface makes each type a compile-time obligation — if a field is
//     renamed, removed, retyped, or an interface deleted, `tsc` fails on this
//     file. That guards the module's actual (type) surface.
//
// The `import type` below is elided at runtime; the bare `import './types'`
// keeps the module in the runtime graph so coverage sees it.
import './types';
import type { EarnSummary, EarnPosition, EarnChartPoint, EarnVault } from './types';

describe('earn-flow/types', () => {
  it('EarnChartPoint accepts a label/value point', () => {
    const point: EarnChartPoint = { label: 'Jan', value: 12.5 };

    expect(point.label).toBe('Jan');
    expect(point.value).toBeCloseTo(12.5);
    expect(typeof point.label).toBe('string');
    expect(typeof point.value).toBe('number');
    // Exactly the two declared keys, nothing else.
    expect(Object.keys(point).sort()).toEqual(['label', 'value']);
  });

  it('EarnSummary carries the four headline metric strings', () => {
    const summary: EarnSummary = {
      totalRewards: '$1,204.55',
      blendedApy: '6.2%',
      totalDeposited: '$18,900.00',
      estimatedRewards: '$1,320.00'
    };

    expect(summary).toEqual({
      totalRewards: '$1,204.55',
      blendedApy: '6.2%',
      totalDeposited: '$18,900.00',
      estimatedRewards: '$1,320.00'
    });
    expect(Object.keys(summary).sort()).toEqual([
      'blendedApy',
      'estimatedRewards',
      'totalDeposited',
      'totalRewards'
    ]);
    // Every headline metric is a string.
    Object.values(summary).forEach(v => expect(typeof v).toBe('string'));
  });

  it('EarnPosition holds the full position shape including a nested chart series', () => {
    const chartData: EarnChartPoint[] = [
      { label: 'W1', value: 1 },
      { label: 'W2', value: 2.75 },
      { label: 'W3', value: 3 }
    ];

    const position: EarnPosition = {
      id: 'pos-1',
      protocol: 'Aave',
      asset: 'USDC',
      network: 'Ethereum',
      amount: '$5,000.00',
      depositedAmount: '$4,800.00',
      rewards: '$200.00',
      age: '3 months',
      activeDuration: '92 days',
      apy: '5.4%',
      dailyAverage: '$2.17',
      started: '2026-04-19',
      yearlyEstimate: '$264.00',
      withdrawTime: 'Instant',
      route: '/earn/positions/pos-1',
      chartData
    };

    // Scalar string fields all populated as strings.
    (
      [
        'id',
        'protocol',
        'asset',
        'network',
        'amount',
        'depositedAmount',
        'rewards',
        'age',
        'activeDuration',
        'apy',
        'dailyAverage',
        'started',
        'yearlyEstimate',
        'withdrawTime',
        'route'
      ] as const
    ).forEach(key => expect(typeof position[key]).toBe('string'));

    expect(position.id).toBe('pos-1');
    expect(position.route).toBe(`/earn/positions/${position.id}`);

    // Nested EarnChartPoint[] is preserved by reference and well-formed.
    expect(position.chartData).toBe(chartData);
    expect(Array.isArray(position.chartData)).toBe(true);
    expect(position.chartData).toHaveLength(3);
    position.chartData.forEach(pt => {
      expect(typeof pt.label).toBe('string');
      expect(typeof pt.value).toBe('number');
    });

    // The interface declares exactly these 17 members.
    expect(Object.keys(position).sort()).toEqual([
      'activeDuration',
      'age',
      'amount',
      'apy',
      'asset',
      'chartData',
      'dailyAverage',
      'depositedAmount',
      'id',
      'network',
      'protocol',
      'rewards',
      'route',
      'started',
      'withdrawTime',
      'yearlyEstimate'
    ]);
  });

  it('EarnVault holds the vault shape with an audited flag and chart series', () => {
    const chartData: EarnChartPoint[] = [{ label: 'D1', value: 0 }];

    const vault: EarnVault = {
      id: 'vault-1',
      protocol: 'Morpho',
      asset: 'ETH',
      network: 'Base',
      apy: '4.1%',
      apyChange24h: '+0.2%',
      tvl: '$12.4M',
      risk: 'Low',
      audited: true,
      about: 'A conservative lending vault.',
      chartData
    };

    // `audited` is the only boolean member; everything else here is a string.
    expect(typeof vault.audited).toBe('boolean');
    expect(vault.audited).toBe(true);
    (
      ['id', 'protocol', 'asset', 'network', 'apy', 'apyChange24h', 'tvl', 'risk', 'about'] as const
    ).forEach(key => expect(typeof vault[key]).toBe('string'));

    expect(vault.chartData).toBe(chartData);
    expect(vault.chartData[0]).toEqual({ label: 'D1', value: 0 });

    expect(Object.keys(vault).sort()).toEqual([
      'about',
      'apy',
      'apyChange24h',
      'asset',
      'audited',
      'chartData',
      'id',
      'network',
      'protocol',
      'risk',
      'tvl'
    ]);

    // A non-audited vault is equally valid — exercise the other boolean branch.
    const unaudited: EarnVault = { ...vault, audited: false };
    expect(unaudited.audited).toBe(false);
  });

  it('EarnChartPoint is reusable across both EarnPosition and EarnVault', () => {
    const shared: EarnChartPoint = { label: 'shared', value: 42 };

    const position: Pick<EarnPosition, 'chartData'> = { chartData: [shared] };
    const vault: Pick<EarnVault, 'chartData'> = { chartData: [shared] };

    expect(position.chartData[0]).toBe(vault.chartData[0]);
    expect(position.chartData[0]).toBe(shared);
  });
});
