import type { EarnPosition as LibEarnPosition, EarnVaultInfo } from 'lib/epoch';

import {
  EARN_PLACEHOLDER,
  buildEarnSummary,
  formatUsd,
  mapEarnPosition,
  mapEarnVault,
  networkName,
  placeholderPosition,
  placeholderVault,
  positionSlug,
  vaultSlug
} from './earn-mapping';

const libPosition = (overrides: Partial<LibEarnPosition> = {}): LibEarnPosition => ({
  owner: '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  lenderKey: 'dummy-lending',
  lenderName: 'Dummy Lending',
  chainId: '11155111',
  deposits: '1024.5',
  withdrawable: '1024.5',
  depositsUSD: 1024.5,
  depositApr: 5.24,
  symbol: 'USDC',
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
    expect(positionSlug(libPosition())).not.toBe(positionSlug(libPosition({ owner: '0x0000000000000000000000000000000000000001' })));
    expect(positionSlug(libPosition())).not.toBe(positionSlug(libPosition({ marketUid: 'OTHER:1:0x1' })));
  });
});

describe('formatUsd', () => {
  it('formats with thousands separators and two decimals', () => {
    expect(formatUsd(1024.5)).toBe('$1,024.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1234567.891)).toBe('$1,234,567.89');
  });
});

describe('networkName', () => {
  it('maps Sepolia and falls back to a chain-id label', () => {
    expect(networkName('11155111')).toBe('Sepolia');
    expect(networkName('42')).toBe('Chain 42');
  });
});

describe('mapEarnPosition', () => {
  it('links back to its vault via vaultId (matches the vault slug)', () => {
    const ui = mapEarnPosition(libPosition({ lenderKey: 'DUMMY_LENDING' }));
    expect(ui.vaultId).toBe(vaultSlug(libVault()));
  });

  it('applies the lender display override (DUMMY_LENDING shown as Aave)', () => {
    const ui = mapEarnPosition(libPosition({ lenderKey: 'DUMMY_LENDING' }));
    expect(ui.protocol).toBe('Aave');
    expect(ui.route).toBe('Miden -> Aave (Sepolia)');
  });

  it('maps real fields to the display formats', () => {
    const ui = mapEarnPosition(libPosition());
    expect(ui.protocol).toBe('Dummy Lending');
    expect(ui.asset).toBe('USDC');
    expect(ui.network).toBe('Sepolia');
    expect(ui.amount).toBe('$1,024.50');
    expect(ui.depositedAmount).toBe('$1,024.50');
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
    expect(summary.blendedApy).toBe('~7.0%');
    expect(summary.totalDeposited).toBe('$4,000.00');
    // 1000*0.04 + 3000*0.08 = 280
    expect(summary.estimatedRewards).toBe('+$280.00');
    expect(summary.totalRewards).toBe('$0.00');
  });

  it('renders zeros (not dashes) for no positions', () => {
    const summary = buildEarnSummary([]);
    expect(summary.totalDeposited).toBe('$0.00');
    expect(summary.totalRewards).toBe('$0.00');
    expect(summary.blendedApy).toBe('~0.0%');
    expect(summary.estimatedRewards).toBe('+$0.00');
  });
});

const libVault = (overrides: Partial<EarnVaultInfo> = {}): EarnVaultInfo => ({
  lenderKey: 'DUMMY_LENDING',
  lenderName: 'Dummy Lending',
  logoUri: '',
  chainId: '11155111',
  apr: 2,
  depositApr: 2,
  ...overrides
});

describe('vaultSlug', () => {
  it('is deterministic and URL-safe', () => {
    const slug = vaultSlug(libVault());
    expect(slug).toBe(vaultSlug(libVault()));
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(encodeURIComponent(slug)).toBe(slug);
  });
});

describe('mapEarnVault', () => {
  it('renders the dummy lender as Aave on USDC with the live APR', () => {
    const ui = mapEarnVault(libVault());
    expect(ui.protocol).toBe('Aave');
    expect(ui.asset).toBe('USDC');
    expect(ui.network).toBe('Sepolia');
    expect(ui.apy).toBe('2.00%');
  });

  it('falls back to the lender name for unknown lenders', () => {
    const ui = mapEarnVault(libVault({ lenderKey: 'AAVE_V3', lenderName: 'Aave V3' }));
    expect(ui.protocol).toBe('Aave V3');
  });

  it('renders placeholders for fields the API cannot provide', () => {
    const ui = mapEarnVault(libVault());
    expect(ui.apyChange24h).toBe(EARN_PLACEHOLDER);
    expect(ui.tvl).toBe(EARN_PLACEHOLDER);
    expect(ui.risk).toBe(EARN_PLACEHOLDER);
    expect(ui.about).toBe(EARN_PLACEHOLDER);
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
