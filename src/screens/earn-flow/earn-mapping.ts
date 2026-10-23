import {
  EARN_LENDER_FAMILY_NAMES,
  earnLenderFamily,
  type EarnLenderFamily,
  type EarnPosition as LibEarnPosition,
  type EarnVaultInfo,
  earnVaultTakesDeposits
} from 'lib/epoch';
import { formatUsd, usdFormatterFor } from 'lib/i18n/numbers';
import type { EarnVaultConfig } from 'lib/remote-config/schema';

import type { EarnPosition, EarnRiskLevel, EarnSummary, EarnVault } from './types';

export { formatUsd };

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
  '1': 'Ethereum',
  '10': 'Optimism',
  '137': 'Polygon',
  '8453': 'Base',
  '42161': 'Arbitrum',
  '11155111': 'Sepolia'
};

export function networkName(chainId: string): string {
  return NETWORK_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function formatSignedUsd(value: number): string {
  return `+${formatUsd(value)}`;
}

/** The one shape every APY figure shares, static or animated: two decimals and a percent sign. */
export function formatApy(apr: number): string {
  return `${apr.toFixed(2)}%`;
}

/**
 * The formatter for an animated earn USD figure: `usdFormatterFor` its value, with the `+` of
 * `formatSignedUsd` when `signed`. A figure with no value renders its placeholder and never
 * formats, so no target is invented for it.
 */
export function usdFigureFormatter(
  target: number | null | undefined,
  { signed = false }: { signed?: boolean } = {}
): (value: number) => string {
  if (target == null) return signed ? formatSignedUsd : formatUsd;
  const format = usdFormatterFor(target);
  return signed ? value => `+${format(value)}` : format;
}

/**
 * The protocol name of a lender family ("Aave V3", "Compound V3", "Morpho", "Dummy Lending"). A lender outside
 * the known families shows its own lender name.
 */
function protocolName(family: EarnLenderFamily | undefined, lenderName: string): string {
  return family ? EARN_LENDER_FAMILY_NAMES[family] : lenderName;
}

/**
 * The market name to show beside the protocol, or undefined when the protocol alone identifies the market.
 * Aave V3 and Compound V3 have one USDC market for each chain, so the protocol and the network identify it.
 * Morpho Blue has many USDC markets on one chain, so a Morpho market shows its lender name
 * ("Morpho uniBTC-USDC 77"). Its `marketName` ("Loan USDC") is the same for all of them, so it is not used.
 */
function distinguishingMarketName(family: EarnLenderFamily | undefined, lenderName: string): string | undefined {
  switch (family) {
    case 'MORPHO_BLUE':
      return lenderName;
    default:
      return undefined;
  }
}

/**
 * A deterministic URL-safe slug of a market uid: lowercase, each run of other characters changed to one '-', and
 * no '-' at the start or the end. The market uid comes checksum-cased from a position and lowercase from a vault,
 * so both give the same slug.
 */
export function marketSlug(marketUid: string): string {
  return marketUid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The risk levels the screens can translate, from the service's label. Another label gives undefined. */
function riskLevelOf(label: string): EarnRiskLevel | undefined {
  switch (label.trim().toLowerCase()) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return undefined;
  }
}

/** The risk label with a capital first letter ("low" → "Low"), or the placeholder when there is no label. */
function riskText(label: string | undefined): string {
  const text = label?.trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : EARN_PLACEHOLDER;
}

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1
});

/**
 * A large USD total in a short form ("$412.3M"), so that it fits in a metric card. A value below $1,000 uses
 * `formatUsd`, which gives the cents.
 */
export function formatUsdTotal(value: number): string {
  return Math.abs(value) < 1000 ? formatUsd(value) : compactUsd.format(value);
}

/**
 * Deterministic URL-safe id for a position — it is rendered raw into
 * `/earn/positions/{id}` by the list screens and looked up again by the
 * detail screen, so it must round-trip through a route param.
 */
export function positionSlug(position: LibEarnPosition): string {
  return `${position.owner}-${position.chainId}-${position.marketUid}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** The absolute URL of a listed vault's document logo (`selectEarnVaultLogoUrl`), or null when it names none. */
export type EarnVaultLogoUrlOf = (listing: EarnVaultConfig) => string | null;

const NO_LOGO_URL: EarnVaultLogoUrlOf = () => null;

/**
 * The display position of one lending position. `listed` is the document's vault list (`selectEarnVaults`): a
 * position in a listed market takes that vault's name, route id and document logo (`logoUrlOf`). A market the
 * document does not list has no vault id; the id is never derived from the market uid.
 */
export function mapEarnPosition(
  position: LibEarnPosition,
  listed: readonly EarnVaultConfig[] = [],
  logoUrlOf: EarnVaultLogoUrlOf = NO_LOGO_URL
): EarnPosition {
  const network = networkName(position.chainId);
  const family = earnLenderFamily(position.lenderKey);
  const protocol = protocolName(family, position.lenderName);
  const listing = listed.find(vault => vault.marketUid === position.marketUid.toLowerCase());
  // A listed market's name identifies it on its own.
  const marketName = listing ? undefined : distinguishingMarketName(family, position.lenderName);
  const epochProtocol = listing?.protocol;
  const logoUrl = listing ? logoUrlOf(listing) : null;
  const yearlyUsd = (position.depositsUSD * position.depositApr) / 100;
  return {
    id: positionSlug(position),
    // The document's route id when it lists this market. Deposit more stays off when it does not.
    vaultId: listing?.id ?? '',
    owner: position.owner,
    marketUid: position.marketUid,
    chainId: position.chainId,
    underlyingAddress: position.underlyingAddress,
    withdrawable: position.withdrawable,
    decimals: position.decimals,
    protocol,
    ...(epochProtocol ? { epochProtocol } : {}),
    ...(listing ? { name: listing.name } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(marketName ? { marketName } : {}),
    asset: position.symbol,
    network,
    amount: formatUsd(position.depositsUSD),
    depositsUsd: position.depositsUSD,
    // The positions service reports current deposits only — no principal split.
    depositedAmount: formatUsd(position.depositsUSD),
    rewards: EARN_PLACEHOLDER,
    age: EARN_PLACEHOLDER,
    activeDuration: EARN_PLACEHOLDER,
    apy: `${position.depositApr.toFixed(2)}%`,
    aprPercent: position.depositApr,
    dailyAverage: EARN_PLACEHOLDER,
    started: EARN_PLACEHOLDER,
    yearlyEstimate: `${formatSignedUsd(yearlyUsd)} / yr`,
    withdrawTime: EARN_PLACEHOLDER,
    route: `Miden -> ${protocol} (${network})`,
    stale: false,
    // No history endpoint yet — a flat, non-empty series keeps the area chart
    // well-defined (it takes min/max over the values).
    chartData: [
      { label: EARN_PLACEHOLDER, value: position.depositsUSD },
      { label: EARN_PLACEHOLDER, value: position.depositsUSD }
    ]
  };
}

/**
 * The URL-safe id of a vault: the id the document lists it under. The list screens put it raw into
 * `/earn/vaults/{id}`, and a position of the same market links to it (`EarnPosition.vaultId`).
 */
export function vaultSlug(vault: EarnVaultInfo): string {
  return vault.listing.id;
}

/**
 * The display vault of one market, named as the document lists it: its `name`, and its `about` and `risk` in place
 * of the catalogue's when it sets them. The rate is `aprTotal` (base and rewards). `fundingAsset` is the Miden asset
 * that funds a deposit (USDCx on testnet); `asset` stays the EVM underlying. `logoUrl` is the absolute URL of the
 * entry's document logo (`selectEarnVaultLogoUrl`), drawn before the bundled mark.
 */
export function mapEarnVault(vault: EarnVaultInfo, fundingAsset?: string, logoUrl?: string | null): EarnVault {
  const { listing } = vault;
  const riskLabel = listing.risk ?? vault.risk?.label;
  const riskLevel = riskLabel === undefined ? undefined : riskLevelOf(riskLabel);
  const listedAbout = listing.about?.trim();
  const about = listedAbout || vault.about?.trim();
  return {
    id: vaultSlug(vault),
    name: listing.name,
    protocol: protocolName(vault.lenderFamily, vault.lenderName),
    ...(logoUrl ? { logoUrl } : {}),
    ...(listedAbout ? { listedAbout } : {}),
    asset: vault.underlying.symbol,
    ...(fundingAsset ? { fundingAsset } : {}),
    network: networkName(vault.chainId),
    apy: formatApy(vault.aprTotal),
    aprPercent: vault.aprTotal,
    apyChange24h: EARN_PLACEHOLDER,
    tvl: vault.totalDepositsUsd === undefined ? EARN_PLACEHOLDER : formatUsdTotal(vault.totalDepositsUsd),
    risk: riskText(riskLabel),
    ...(riskLevel ? { riskLevel } : {}),
    audited: false,
    about: about || EARN_PLACEHOLDER,
    canOpen: earnVaultTakesDeposits(vault),
    depositsEnabled: listing.depositsEnabled,
    info: vault,
    // No APY history endpoint — flat, non-empty series keeps the chart defined.
    chartData: [
      { label: EARN_PLACEHOLDER, value: vault.aprTotal },
      { label: EARN_PLACEHOLDER, value: vault.aprTotal }
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
    totalRewardsUsd: 0,
    blendedApyPercent: blendedApy,
    totalDepositedUsd: totalDeposits,
    estimatedRewardsUsd: yearlyUsd
  };
}

/** The summary while the first positions read is in flight: no figures yet, so none can count from zero. */
export function loadingEarnSummary(): EarnSummary {
  return { totalRewardsUsd: null, blendedApyPercent: null, totalDepositedUsd: null, estimatedRewardsUsd: null };
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
    stale: true,
    chartData: [
      { label: EARN_PLACEHOLDER, value: 0 },
      { label: EARN_PLACEHOLDER, value: 0 }
    ]
  };
}
