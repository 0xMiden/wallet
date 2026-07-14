import type { EarnPosition as LibEarnPosition, EarnVaultInfo } from 'lib/epoch';

import type { EarnPosition, EarnSummary, EarnVault } from './types';

/**
 * Maps the Epoch positions API shape (`lib/epoch/positions.ts`) onto the
 * presentational earn-flow types, which expect pre-formatted display strings.
 * Fields the positions service cannot provide (reward history, position age,
 * start date, chart history) render a neutral placeholder — never mock data.
 * Derivable fields ARE computed: blended APY is the deposit-weighted average
 * APR and the rewards estimates are deposits × APR (yearly).
 */

export const EARN_PLACEHOLDER = '—';

const NETWORK_NAMES: Record<string, string> = {
  '11155111': 'Sepolia'
};

export function networkName(chainId: string): string {
  return NETWORK_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSignedUsd(value: number): string {
  return `+${formatUsd(value)}`;
}

/**
 * Display names per lender key. The only live lender today is Epoch's
 * "DUMMY_LENDING" stand-in — shown as Aave on USDC until real lenders exist
 * (the whole earn flow is USDC-only, see MIDEN_USDC_FAUCET).
 */
const VAULT_DISPLAY: Record<string, { protocol: string; asset: string }> = {
  DUMMY_LENDING: { protocol: 'Aave', asset: 'USDC' }
};

function protocolName(lenderKey: string, lenderName: string): string {
  return VAULT_DISPLAY[lenderKey]?.protocol ?? lenderName;
}

function lenderChainSlug(lenderKey: string, chainId: string): string {
  return `${lenderKey}-${chainId}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Deterministic URL-safe id for a position — it is rendered raw into
 * `/earn/positions/{id}` by the list screens and looked up again by the
 * detail screen, so it must round-trip through a route param.
 */
export function positionSlug(position: LibEarnPosition): string {
  return `${position.owner}-${position.chainId}-${position.marketUid}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function mapEarnPosition(position: LibEarnPosition): EarnPosition {
  const network = networkName(position.chainId);
  const protocol = protocolName(position.lenderKey, position.lenderName);
  const yearlyUsd = (position.depositsUSD * position.depositApr) / 100;
  return {
    id: positionSlug(position),
    vaultId: lenderChainSlug(position.lenderKey, position.chainId),
    owner: position.owner,
    marketUid: position.marketUid,
    chainId: position.chainId,
    underlyingAddress: position.underlyingAddress,
    withdrawable: position.withdrawable,
    decimals: position.decimals,
    protocol,
    asset: position.symbol,
    network,
    amount: formatUsd(position.depositsUSD),
    // The positions service reports current deposits only — no principal split.
    depositedAmount: formatUsd(position.depositsUSD),
    rewards: EARN_PLACEHOLDER,
    age: EARN_PLACEHOLDER,
    activeDuration: EARN_PLACEHOLDER,
    apy: `${position.depositApr.toFixed(2)}%`,
    dailyAverage: EARN_PLACEHOLDER,
    started: EARN_PLACEHOLDER,
    yearlyEstimate: `${formatSignedUsd(yearlyUsd)} / yr`,
    withdrawTime: EARN_PLACEHOLDER,
    route: `Miden -> ${protocol} (${network})`,
    // No history endpoint yet — a flat, non-empty series keeps the area chart
    // well-defined (it takes min/max over the values).
    chartData: [
      { label: EARN_PLACEHOLDER, value: position.depositsUSD },
      { label: EARN_PLACEHOLDER, value: position.depositsUSD }
    ]
  };
}

/** Deterministic URL-safe id — rendered raw into `/earn/vaults/{id}`. */
export function vaultSlug(vault: EarnVaultInfo): string {
  return lenderChainSlug(vault.lenderKey, vault.chainId);
}

export function mapEarnVault(vault: EarnVaultInfo): EarnVault {
  const display = VAULT_DISPLAY[vault.lenderKey] ?? { protocol: vault.lenderName, asset: 'USDC' };
  return {
    id: vaultSlug(vault),
    protocol: display.protocol,
    asset: display.asset,
    network: networkName(vault.chainId),
    apy: `${vault.depositApr.toFixed(2)}%`,
    apyChange24h: EARN_PLACEHOLDER,
    tvl: EARN_PLACEHOLDER,
    risk: EARN_PLACEHOLDER,
    audited: false,
    about: EARN_PLACEHOLDER,
    // No APY history endpoint — flat, non-empty series keeps the chart defined.
    chartData: [
      { label: EARN_PLACEHOLDER, value: vault.depositApr },
      { label: EARN_PLACEHOLDER, value: vault.depositApr }
    ]
  };
}

export function buildEarnSummary(positions: LibEarnPosition[]): EarnSummary {
  const totalDeposits = positions.reduce((sum, p) => sum + p.depositsUSD, 0);
  const yearlyUsd = positions.reduce((sum, p) => sum + (p.depositsUSD * p.depositApr) / 100, 0);
  const blendedApy =
    totalDeposits > 0 ? positions.reduce((sum, p) => sum + p.depositsUSD * p.depositApr, 0) / totalDeposits : 0;
  return {
    // No rewards-history endpoint yet — report zero rather than a dash.
    totalRewards: formatUsd(0),
    blendedApy: `~${blendedApy.toFixed(1)}%`,
    totalDeposited: formatUsd(totalDeposits),
    estimatedRewards: formatSignedUsd(yearlyUsd)
  };
}

/** All-placeholder vault for deep links that land before data arrives. */
export function placeholderVault(): EarnVault {
  return {
    id: '',
    protocol: EARN_PLACEHOLDER,
    asset: EARN_PLACEHOLDER,
    network: EARN_PLACEHOLDER,
    apy: EARN_PLACEHOLDER,
    apyChange24h: EARN_PLACEHOLDER,
    tvl: EARN_PLACEHOLDER,
    risk: EARN_PLACEHOLDER,
    audited: false,
    about: EARN_PLACEHOLDER,
    chartData: [
      { label: EARN_PLACEHOLDER, value: 0 },
      { label: EARN_PLACEHOLDER, value: 0 }
    ]
  };
}

/** All-placeholder position for deep links that land before data arrives. */
export function placeholderPosition(): EarnPosition {
  return {
    id: '',
    vaultId: '',
    owner: '',
    marketUid: '',
    chainId: '',
    underlyingAddress: '',
    withdrawable: '0',
    decimals: 0,
    protocol: EARN_PLACEHOLDER,
    asset: EARN_PLACEHOLDER,
    network: EARN_PLACEHOLDER,
    amount: EARN_PLACEHOLDER,
    depositedAmount: EARN_PLACEHOLDER,
    rewards: EARN_PLACEHOLDER,
    age: EARN_PLACEHOLDER,
    activeDuration: EARN_PLACEHOLDER,
    apy: EARN_PLACEHOLDER,
    dailyAverage: EARN_PLACEHOLDER,
    started: EARN_PLACEHOLDER,
    yearlyEstimate: EARN_PLACEHOLDER,
    withdrawTime: EARN_PLACEHOLDER,
    route: EARN_PLACEHOLDER,
    chartData: [
      { label: EARN_PLACEHOLDER, value: 0 },
      { label: EARN_PLACEHOLDER, value: 0 }
    ]
  };
}
