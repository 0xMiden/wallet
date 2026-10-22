// `data.ts` holds the earn-flow test fixtures: the vaults as the lib reads them (`EARN_VAULT_INFOS`) and the display
// data the screens get (`EARN_DATA`). These tests lock the shape and the values of the fixtures, so that a changed
// field or a dropped entry fails here and not in a screen test.
import * as earnData from './data';
import { EARN_DATA, EARN_VAULT_INFOS } from './data';
import type { EarnChartPoint, EarnPosition } from './types';

const isNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

const assertChartSeries = (chartData: EarnChartPoint[]): void => {
  expect(chartData.length).toBeGreaterThan(0);
  chartData.forEach(point => {
    expect(Object.keys(point).sort()).toEqual(['label', 'value']);
    expect(isNonEmptyString(point.label)).toBe(true);
    expect(Number.isFinite(point.value)).toBe(true);
  });
};

describe('earn-flow/data', () => {
  describe('module runtime surface', () => {
    it('exposes the display data and the vault infos', () => {
      expect(Object.keys(earnData).sort()).toEqual(['EARN_DATA', 'EARN_VAULT_INFOS']);
      expect(Object.keys(EARN_DATA).sort()).toEqual(['positions', 'summary', 'vaults']);
    });
  });

  describe('summary', () => {
    it('carries the four summary figures verbatim', () => {
      expect(EARN_DATA.summary).toEqual({
        totalRewardsUsd: 218.32,
        blendedApyPercent: 5.2,
        totalDepositedUsd: 4218.32,
        estimatedRewardsUsd: 24.5
      });
    });
  });

  describe('vault infos', () => {
    it('lists the USDC markets of each family, highest total APR first', () => {
      expect(EARN_VAULT_INFOS.map(info => info.lenderFamily)).toEqual([
        'MORPHO_BLUE',
        'MORPHO_BLUE',
        'AAVE_V3',
        'COMPOUND_V3',
        'DUMMY_LENDING'
      ]);
      const aprs = EARN_VAULT_INFOS.map(info => info.aprTotal);
      expect(aprs).toEqual([...aprs].sort((a, b) => b - a));
      EARN_VAULT_INFOS.forEach(info => expect(info.underlying.symbol).toBe('USDC'));
    });

    it('gives each market a lowercase uid of its lender key, chain and underlying', () => {
      EARN_VAULT_INFOS.forEach(info => {
        expect(info.marketUid).toBe(
          `${info.lenderKey}:${info.chainId}:${info.underlying.address}`.toLowerCase()
        );
      });
      expect(new Set(EARN_VAULT_INFOS.map(info => info.marketUid)).size).toBe(EARN_VAULT_INFOS.length);
    });

    it('has the Aave V3 USDC market on Base', () => {
      expect(EARN_VAULT_INFOS[2]).toMatchObject({
        marketUid: 'aave_v3:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        lenderKey: 'AAVE_V3',
        chainId: '8453'
      });
    });

    it('has two Morpho Blue markets that only their lender names tell apart', () => {
      const [first, second] = EARN_VAULT_INFOS;
      expect(first!.lenderName).not.toBe(second!.lenderName);
      expect(first!.marketName).toBe(second!.marketName);
      expect(first!.chainId).toBe(second!.chainId);
    });

    it('has one market that accepts no deposits now', () => {
      expect(EARN_VAULT_INFOS.filter(info => !info.canOpen)).toHaveLength(1);
    });
  });

  describe('positions', () => {
    it('contains two positions with unique ids in the same Aave V3 market', () => {
      expect(EARN_DATA.positions.map(p => p.id)).toEqual(['aave-usdc-1', 'aave-usdc-2']);
      const aaveVault = EARN_DATA.vaults[2]!;
      EARN_DATA.positions.forEach((position: EarnPosition) => {
        expect(position.vaultId).toBe(aaveVault.id);
        expect(position.marketUid.toLowerCase()).toBe(aaveVault.info?.marketUid);
      });
      expect(new Set(EARN_DATA.positions.map(p => p.owner)).size).toBe(2);
    });

    it('every display string field on each position is a non-empty string', () => {
      EARN_DATA.positions.forEach(position => {
        const { chartData, decimals, stale, ...fields } = position;
        expect(typeof decimals).toBe('number');
        expect(stale).toBe(false);
        assertChartSeries(chartData);
        Object.values(fields).forEach(value => expect(isNonEmptyString(value)).toBe(true));
      });
    });

    it('gives each position a distinct chart series', () => {
      const [first, second] = EARN_DATA.positions;
      expect(first!.chartData).not.toEqual(second!.chartData);
    });
  });

  describe('vaults', () => {
    it('has one display vault for each vault info, in the same order and carrying it', () => {
      expect(EARN_DATA.vaults.map(vault => vault.info)).toEqual(EARN_VAULT_INFOS);
      const ids = EARN_DATA.vaults.map(vault => vault.id);
      expect(new Set(ids).size).toBe(ids.length);
      ids.forEach(id => expect(id).toMatch(/^[a-z0-9-]+$/));
    });

    it('carries a well-formed APY chart series on every vault', () => {
      EARN_DATA.vaults.forEach(vault => assertChartSeries(vault.chartData));
    });
  });
});
