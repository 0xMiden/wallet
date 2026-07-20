// `data.ts` has a single runtime export: the `EARN_DATA` constant. It is a
// pure, static data module with no functions, hooks, or branches — importing
// it evaluates every line. These tests lock the shape and the concrete values
// of that fixture so accidental edits (renamed fields, dropped entries,
// malformed chart series) fail loudly, and they double as living
// documentation of the earn-flow demo dataset.
import { EARN_DATA } from './data';
// Grab the whole namespace to assert the module's runtime export set is
// exactly the one constant (no accidental runtime leakage).
import * as earnData from './data';
import type { EarnPosition, EarnVault, EarnChartPoint } from './types';

const isNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

const assertChartSeries = (chartData: EarnChartPoint[]): void => {
  expect(Array.isArray(chartData)).toBe(true);
  expect(chartData.length).toBeGreaterThan(0);
  chartData.forEach(point => {
    expect(Object.keys(point).sort()).toEqual(['label', 'value']);
    expect(isNonEmptyString(point.label)).toBe(true);
    expect(typeof point.value).toBe('number');
    expect(Number.isFinite(point.value)).toBe(true);
  });
};

describe('earn-flow/data', () => {
  describe('module runtime surface', () => {
    it('exposes exactly the EARN_DATA constant at runtime', () => {
      expect(Object.keys(earnData)).toEqual(['EARN_DATA']);
    });

    it('EARN_DATA is a plain object with the three top-level sections', () => {
      expect(EARN_DATA).toBeDefined();
      expect(Object.keys(EARN_DATA).sort()).toEqual(['positions', 'summary', 'vaults']);
    });
  });

  describe('summary', () => {
    it('carries the four preformatted summary strings verbatim', () => {
      expect(EARN_DATA.summary).toEqual({
        totalRewards: '$218.32',
        blendedApy: '~5.2%',
        totalDeposited: '$4, 218.32',
        estimatedRewards: '+$24.50'
      });
    });

    it('has exactly the EarnSummary fields, all non-empty strings', () => {
      expect(Object.keys(EARN_DATA.summary).sort()).toEqual([
        'blendedApy',
        'estimatedRewards',
        'totalDeposited',
        'totalRewards'
      ]);
      Object.values(EARN_DATA.summary).forEach(value => {
        expect(isNonEmptyString(value)).toBe(true);
      });
    });
  });

  describe('positions', () => {
    it('contains exactly two positions with unique ids', () => {
      expect(Array.isArray(EARN_DATA.positions)).toBe(true);
      expect(EARN_DATA.positions).toHaveLength(2);
      const ids = EARN_DATA.positions.map(p => p.id);
      expect(ids).toEqual(['aave-usdc-1', 'aave-usdc-2']);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('every position exposes the full EarnPosition field set', () => {
      const expectedKeys = [
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
      ];
      EARN_DATA.positions.forEach((position: EarnPosition) => {
        expect(Object.keys(position).sort()).toEqual(expectedKeys);
      });
    });

    it('every string field on each position is a non-empty string', () => {
      EARN_DATA.positions.forEach(position => {
        const { chartData, ...stringFields } = position;
        void chartData;
        Object.values(stringFields).forEach(value => {
          expect(isNonEmptyString(value)).toBe(true);
        });
      });
    });

    it('every position carries a well-formed chart series', () => {
      EARN_DATA.positions.forEach(position => {
        assertChartSeries(position.chartData);
        // The demo series all span the same 18-point Mar→Jun window.
        expect(position.chartData).toHaveLength(18);
        expect(position.chartData[0].label).toBe('Mar 18');
        expect(position.chartData.at(-1)?.label).toBe('Jun 28');
      });
    });

    it('pins the concrete values of the first position', () => {
      const [first] = EARN_DATA.positions;
      expect(first).toMatchObject({
        id: 'aave-usdc-1',
        protocol: 'Aave',
        asset: 'USDC',
        network: 'Ethereum',
        amount: '$1,024.50',
        depositedAmount: '$1,000.00',
        rewards: '+$24.50',
        age: '42d',
        activeDuration: '42 days active',
        apy: '5.24%',
        dailyAverage: '+$0.58',
        started: 'Mar 18',
        yearlyEstimate: '+$53.68 / yr',
        withdrawTime: '~30 sec · no lockup',
        route: 'Miden -> Aave (Ethereum)'
      });
      expect(first.chartData[0]).toEqual({ label: 'Mar 18', value: 1000 });
    });

    it('gives each position a distinct chart series', () => {
      const [first, second] = EARN_DATA.positions;
      expect(first.chartData).not.toEqual(second.chartData);
    });
  });

  describe('vaults', () => {
    it('contains exactly four vaults with unique ids', () => {
      expect(Array.isArray(EARN_DATA.vaults)).toBe(true);
      expect(EARN_DATA.vaults).toHaveLength(4);
      const ids = EARN_DATA.vaults.map(v => v.id);
      expect(ids).toEqual([
        'aave-usdc-ethereum-1',
        'aave-usdc-ethereum-2',
        'aave-usdc-ethereum-3',
        'aave-usdc-ethereum-4'
      ]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('every vault exposes the full EarnVault field set', () => {
      const expectedKeys = [
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
      ];
      EARN_DATA.vaults.forEach((vault: EarnVault) => {
        expect(Object.keys(vault).sort()).toEqual(expectedKeys);
      });
    });

    it('every vault string field is non-empty and audited is a boolean', () => {
      EARN_DATA.vaults.forEach(vault => {
        const { chartData, audited, ...stringFields } = vault;
        void chartData;
        expect(typeof audited).toBe('boolean');
        expect(audited).toBe(true);
        Object.values(stringFields).forEach(value => {
          expect(isNonEmptyString(value)).toBe(true);
        });
      });
    });

    it('every vault carries a well-formed APY chart series', () => {
      EARN_DATA.vaults.forEach(vault => {
        assertChartSeries(vault.chartData);
        expect(vault.chartData).toHaveLength(18);
        expect(vault.chartData[0].label).toBe('Mar 18');
        expect(vault.chartData.at(-1)?.label).toBe('Jun 28');
        // APY series are single-digit percentages, unlike the position
        // balance series which are in the thousands.
        vault.chartData.forEach(point => {
          expect(point.value).toBeGreaterThan(0);
          expect(point.value).toBeLessThan(10);
        });
      });
    });

    it('shares the common Aave/USDC descriptive fields across every vault', () => {
      EARN_DATA.vaults.forEach(vault => {
        expect(vault).toMatchObject({
          protocol: 'Aave',
          asset: 'USDC',
          network: 'Ethereum',
          apy: '5.24%',
          apyChange24h: '+0.12% (24h)',
          tvl: '$1.2B',
          risk: 'Low',
          audited: true,
          about: 'Aave is a decentralized lending protocol with battle-tested smart contracts and over $12B TVL.'
        });
      });
    });

    it('gives each vault a distinct chart series', () => {
      const series = EARN_DATA.vaults.map(v => JSON.stringify(v.chartData));
      expect(new Set(series).size).toBe(series.length);
    });
  });

  describe('cross-section invariants', () => {
    it('positions and vaults share the same 18-point chart window labels', () => {
      const positionLabels = EARN_DATA.positions[0].chartData.map(p => p.label);
      EARN_DATA.positions.forEach(position => {
        expect(position.chartData.map(p => p.label)).toEqual(positionLabels);
      });
      EARN_DATA.vaults.forEach(vault => {
        expect(vault.chartData.map(p => p.label)).toEqual(positionLabels);
      });
    });

    it('every id across positions and vaults is globally unique', () => {
      const allIds = [...EARN_DATA.positions.map(p => p.id), ...EARN_DATA.vaults.map(v => v.id)];
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  });
});
