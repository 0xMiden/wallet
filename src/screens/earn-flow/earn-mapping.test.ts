import type { EarnPosition as LibEarnPosition, EarnVaultInfo } from 'lib/epoch';

import { EARN_DATA, EARN_VAULT_INFOS } from './data';
import {
  EARN_PLACEHOLDER,
  buildEarnSummary,
  formatApy,
  formatUsd,
  formatUsdTotal,
  mapEarnPosition,
  mapEarnVault,
  marketSlug,
  networkName,
  placeholderPosition,
  placeholderVault,
  positionSlug,
  vaultSlug
} from './earn-mapping';

const libPosition = (overrides: Partial<LibEarnPosition> = {}): LibEarnPosition => ({
  owner: '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  lenderKey: 'DUMMY_LENDING',
  lenderName: 'Dummy Lending',
  chainId: '11155111',
  deposits: '1024.5',
  withdrawable: '1024.5',
  depositsUSD: 1024.5,
  depositApr: 5.24,
  symbol: 'USDC',
  underlyingAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
  decimals: 6,
  priceUsd: 1,
  ...overrides
});

describe('positionSlug', () => {
  it('is deterministic and URL-safe', () => {
    const slug = positionSlug(libPosition());
    expect(slug).toBe(positionSlug(libPosition()));
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(encodeURIComponent(slug)).toBe(slug);
  });

  it('differs across owners and markets', () => {
    expect(positionSlug(libPosition())).not.toBe(
      positionSlug(libPosition({ owner: '0x0000000000000000000000000000000000000001' }))
    );
    expect(positionSlug(libPosition())).not.toBe(positionSlug(libPosition({ marketUid: 'OTHER:1:0x1' })));
  });
});

describe('formatApy', () => {
  it('formats to two decimals with a percent sign, the one shape every APY site shares', () => {
    expect(formatApy(5)).toBe('5.00%');
    expect(formatApy(5.244)).toBe('5.24%');
  });
});

describe('formatUsd', () => {
  it('formats with thousands separators and two decimals', () => {
    expect(formatUsd(1024.5)).toBe('$1,024.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1234567.891)).toBe('$1,234,567.89');
  });
});

describe('formatUsdTotal', () => {
  it('shortens a large total so it fits a metric card, and keeps the cents below $1,000', () => {
    expect(formatUsdTotal(412_345_678.9)).toBe('$412.3M');
    expect(formatUsdTotal(23_456_789)).toBe('$23.5M');
    expect(formatUsdTotal(1234)).toBe('$1.2K');
    expect(formatUsdTotal(999.5)).toBe('$999.50');
  });
});

describe('networkName', () => {
  it('maps the known chains and falls back to a chain-id label', () => {
    expect(networkName('11155111')).toBe('Sepolia');
    expect(networkName('8453')).toBe('Base');
    expect(networkName('1')).toBe('Ethereum');
    expect(networkName('42')).toBe('Chain 42');
  });
});

describe('marketSlug', () => {
  it('lowercases, joins each run of other characters with one dash and trims the ends', () => {
    expect(marketSlug('AAVE_V3:8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(
      'aave-v3-8453-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    );
    expect(marketSlug('::Dummy__Lending::')).toBe('dummy-lending');
  });
});

describe('mapEarnPosition', () => {
  it('links back to the vault of its own market, whatever the case of the uid', () => {
    const ui = mapEarnPosition(libPosition({ marketUid: 'DUMMY_LENDING:11155111:0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69' }));
    expect(ui.vaultId).toBe(vaultSlug(libVault()));
  });

  it('links two Morpho markets of one chain to two vaults', () => {
    const [first, second] = EARN_VAULT_INFOS;
    const position = (info: EarnVaultInfo) =>
      mapEarnPosition(libPosition({ marketUid: info.marketUid, lenderKey: info.lenderKey, lenderName: info.lenderName }));
    expect(position(first!).vaultId).toBe(EARN_DATA.vaults[0]!.id);
    expect(position(second!).vaultId).toBe(EARN_DATA.vaults[1]!.id);
  });

  it('names a position by its lender family, and a Morpho position by its market too', () => {
    expect(mapEarnPosition(libPosition())).toMatchObject({ protocol: 'Dummy Lending' });
    expect(mapEarnPosition(libPosition()).marketName).toBeUndefined();
    expect(mapEarnPosition(libPosition({ lenderKey: 'AAVE_V3', lenderName: 'Aave V3' }))).toMatchObject({
      protocol: 'Aave V3'
    });
    expect(mapEarnPosition(libPosition({ lenderKey: 'COMPOUND_V3_USDC', lenderName: 'Compound V3' }))).toMatchObject({
      protocol: 'Compound V3'
    });
    const morpho = mapEarnPosition(libPosition({ lenderKey: 'MORPHO_BLUE_0X3B37', lenderName: 'Morpho uniBTC-USDC 77' }));
    expect(morpho).toMatchObject({ protocol: 'Morpho', marketName: 'Morpho uniBTC-USDC 77' });
  });

  it('shows the lender name of a lender outside the known families', () => {
    expect(mapEarnPosition(libPosition({ lenderKey: 'SPARK', lenderName: 'Spark' })).protocol).toBe('Spark');
  });

  it('names the dummy lender Dummy Lending in its route', () => {
    const ui = mapEarnPosition(libPosition());
    expect(ui.protocol).toBe('Dummy Lending');
    expect(ui.route).toBe('Miden -> Dummy Lending (Sepolia)');
  });

  it('maps real fields to the display formats', () => {
    const ui = mapEarnPosition(libPosition());
    expect(ui.protocol).toBe('Dummy Lending');
    expect(ui.asset).toBe('USDC');
    expect(ui.network).toBe('Sepolia');
    expect(ui.amount).toBe('$1,024.50');
    expect(ui.depositedAmount).toBe('$1,024.50');
    expect(ui.owner).toBe('0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(ui.withdrawable).toBe('1024.5');
    expect(ui.underlyingAddress).toBe('0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69');
    expect(ui.apy).toBe('5.24%');
    expect(ui.yearlyEstimate).toBe('+$53.68 / yr');
    expect(ui.route).toBe('Miden -> Dummy Lending (Sepolia)');
  });

  it('renders placeholders for fields the API cannot provide', () => {
    const ui = mapEarnPosition(libPosition());
    expect(ui.rewards).toBe(EARN_PLACEHOLDER);
    expect(ui.age).toBe(EARN_PLACEHOLDER);
    expect(ui.started).toBe(EARN_PLACEHOLDER);
    expect(ui.dailyAverage).toBe(EARN_PLACEHOLDER);
    expect(ui.withdrawTime).toBe(EARN_PLACEHOLDER);
  });

  it('produces a flat, non-empty chart series', () => {
    const ui = mapEarnPosition(libPosition());
    expect(ui.chartData.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ui.chartData.map(p => p.value)).size).toBe(1);
    expect(ui.chartData[0]!.value).toBe(1024.5);
  });
});

describe('buildEarnSummary', () => {
  it('computes deposit-weighted blended APY and yearly rewards estimate', () => {
    const summary = buildEarnSummary([
      libPosition({ depositsUSD: 1000, depositApr: 4 }),
      libPosition({ depositsUSD: 3000, depositApr: 8 })
    ]);
    // (1000*4 + 3000*8) / 4000 = 7.0
    expect(summary.blendedApyPercent).toBeCloseTo(7);
    expect(summary.totalDepositedUsd).toBe(4000);
    // 1000*0.04 + 3000*0.08 = 280
    expect(summary.estimatedRewardsUsd).toBeCloseTo(280);
    expect(summary.totalRewardsUsd).toBe(0);
  });

  it('renders zeros (not dashes) for no positions', () => {
    const summary = buildEarnSummary([]);
    expect(summary.totalDepositedUsd).toBe(0);
    expect(summary.totalRewardsUsd).toBe(0);
    expect(summary.blendedApyPercent).toBe(0);
    expect(summary.estimatedRewardsUsd).toBe(0);
  });
});

// The fallback dummy-lending market, which the service gives with no totals, risk or description.
const libVault = (overrides: Partial<EarnVaultInfo> = {}): EarnVaultInfo => ({
  ...EARN_VAULT_INFOS[4]!,
  ...overrides
});

describe('vaultSlug', () => {
  it('is the deterministic, URL-safe slug of the market uid', () => {
    const slug = vaultSlug(libVault());
    expect(slug).toBe('dummy-lending-11155111-0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69');
    expect(slug).toBe(vaultSlug(libVault()));
    expect(encodeURIComponent(slug)).toBe(slug);
  });

  it('gives each market its own id, two Morpho markets on one chain included', () => {
    const ids = EARN_VAULT_INFOS.map(vaultSlug);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('mapEarnVault', () => {
  it('maps each fixture vault info to its display vault', () => {
    EARN_VAULT_INFOS.forEach((info, index) => {
      expect(mapEarnVault(info)).toEqual(EARN_DATA.vaults[index]);
    });
  });

  it('lists native USDCx funding while the asset stays the EVM underlying', () => {
    expect(mapEarnVault(libVault(), 'USDCx')).toMatchObject({ asset: 'USDC', fundingAsset: 'USDCx' });
    expect(mapEarnVault(libVault())).not.toHaveProperty('fundingAsset');
  });

  it('shows the total APR, base and rewards, as the APY', () => {
    const ui = mapEarnVault(libVault({ depositApr: 3.75, aprTotal: 5.12 }));
    expect(ui.apy).toBe('5.12%');
    expect(ui.aprPercent).toBe(5.12);
    expect(ui.chartData.map(point => point.value)).toEqual([5.12, 5.12]);
  });

  it('names a vault by its family, and a Morpho vault by its lender name too', () => {
    const [morpho, , aave, compound] = EARN_VAULT_INFOS;
    expect(mapEarnVault(aave!)).toMatchObject({ protocol: 'Aave V3' });
    expect(mapEarnVault(aave!)).not.toHaveProperty('marketName');
    expect(mapEarnVault(compound!)).toMatchObject({ protocol: 'Compound V3' });
    expect(mapEarnVault(morpho!)).toMatchObject({ protocol: 'Morpho', marketName: 'Morpho uniBTC-USDC 77' });
    expect(mapEarnVault(libVault())).toMatchObject({ protocol: 'Dummy Lending', network: 'Sepolia' });
  });

  it('takes the asset from the underlying symbol', () => {
    const underlying = { ...libVault().underlying, symbol: 'USDC.e' };
    expect(mapEarnVault(libVault({ underlying })).asset).toBe('USDC.e');
  });

  it('formats the TVL from the total deposits, and keeps the dash without them', () => {
    expect(mapEarnVault(libVault({ totalDepositsUsd: 412_345_678.9 })).tvl).toBe('$412.3M');
    expect(mapEarnVault(libVault()).tvl).toBe(EARN_PLACEHOLDER);
  });

  it('capitalises the risk label, sets the known levels, and keeps an unknown label as text', () => {
    expect(mapEarnVault(libVault({ risk: { score: 1, label: 'low' } }))).toMatchObject({
      risk: 'Low',
      riskLevel: 'low'
    });
    expect(mapEarnVault(libVault({ risk: { score: 3, label: 'HIGH' } }))).toMatchObject({ riskLevel: 'high' });
    const unknown = mapEarnVault(libVault({ risk: { score: 4, label: 'very high' } }));
    expect(unknown.risk).toBe('Very high');
    expect(unknown).not.toHaveProperty('riskLevel');
    expect(mapEarnVault(libVault()).risk).toBe(EARN_PLACEHOLDER);
  });

  it('takes the about text from the service, and keeps the dash without it', () => {
    expect(mapEarnVault(libVault({ about: 'You earn 5.12%.' })).about).toBe('You earn 5.12%.');
    expect(mapEarnVault(libVault({ about: '  ' })).about).toBe(EARN_PLACEHOLDER);
    expect(mapEarnVault(libVault()).about).toBe(EARN_PLACEHOLDER);
  });

  it('keeps whether the market accepts deposits, and the vault info the deposit needs', () => {
    const closed = libVault({ canOpen: false });
    expect(mapEarnVault(closed)).toMatchObject({ canOpen: false, info: closed });
    expect(mapEarnVault(libVault()).canOpen).toBe(true);
  });

  it('renders placeholders for fields the API cannot provide', () => {
    const ui = mapEarnVault(libVault());
    expect(ui.apyChange24h).toBe(EARN_PLACEHOLDER);
    expect(ui.audited).toBe(false);
    expect(ui.chartData.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ui.chartData.map(p => p.value)).size).toBe(1);
  });
});

describe('placeholderPosition', () => {
  it('is all placeholders with a well-defined chart', () => {
    const ui = placeholderPosition();
    expect(ui.protocol).toBe(EARN_PLACEHOLDER);
    expect(ui.amount).toBe(EARN_PLACEHOLDER);
    expect(ui.chartData.length).toBeGreaterThanOrEqual(2);
  });
});

describe('placeholderVault', () => {
  it('is all placeholders with a well-defined chart', () => {
    const ui = placeholderVault();
    expect(ui.protocol).toBe(EARN_PLACEHOLDER);
    expect(ui.apy).toBe(EARN_PLACEHOLDER);
    expect(ui.chartData.length).toBeGreaterThanOrEqual(2);
  });
});
