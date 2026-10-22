import type { EarnVaultInfo } from 'lib/epoch';

/**
 * The earn screens render pre-formatted display strings, because most of their fields have no
 * producer yet and show a placeholder dash. The `*Usd` / `*Percent` twins beside them are the raw
 * figures behind the ones that DO have data, so those can count to a new value instead of snapping
 * (`components/ui/AnimatedNumber`); they are set from the same number the string is formatted from,
 * in `earn-mapping.ts`, and left unset wherever the string is a placeholder.
 */
export interface EarnSummary {
  /** Each figure is `null` until the first positions read completes (`loadingEarnSummary`). */
  totalRewardsUsd: number | null;
  blendedApyPercent: number | null;
  totalDepositedUsd: number | null;
  estimatedRewardsUsd: number | null;
}

export interface EarnPosition {
  id: string;
  /**
   * Id of the vault of this position's market (the slug of its market uid). "Deposit more" uses it to open
   * `/earn/vaults/{vaultId}/deposit` for the same market.
   */
  vaultId: string;
  /** Raw Epoch fields retained for Smart Withdraw once its SDK methods ship. */
  owner: string;
  marketUid: string;
  chainId: string;
  underlyingAddress: string;
  withdrawable: string;
  decimals: number;
  protocol: string;
  /** The name of the market when the protocol alone does not identify it, as on `EarnVault`. */
  marketName?: string;
  asset: string;
  network: string;
  amount: string;
  depositsUsd?: number;
  depositedAmount: string;
  rewards: string;
  age: string;
  activeDuration: string;
  apy: string;
  aprPercent?: number;
  dailyAverage: string;
  started: string;
  yearlyEstimate: string;
  withdrawTime: string;
  route: string;
  /** The latest read did not load it (its owner failed, or the read did), so it arms no withdrawal. */
  stale: boolean;
  chartData: EarnChartPoint[];
}

export interface EarnChartPoint {
  label: string;
  value: number;
}

/**
 * What recharts hands an `Area`'s `dot` render prop. Its own typings widen the argument to a union
 * that carries neither `index` nor the resolved coordinates, so the two earn charts name the three
 * fields they read rather than taking `any`.
 */
export interface ChartDotProps {
  cx?: number;
  cy?: number;
  index?: number;
}

/** The risk levels the earn screens can translate. A different label from the service shows as written. */
export type EarnRiskLevel = 'low' | 'medium' | 'high';

export interface EarnVault {
  /** Miden funding asset shown by the listing; `asset` remains the EVM underlying. */
  fundingAsset?: string;
  /** The slug of the market uid (`marketSlug`). Each market is one vault, so two markets of one lender have two ids. */
  id: string;
  /** The name of the lender family ("Aave V3", "Morpho"). */
  protocol: string;
  /**
   * The name of this market, set only when the protocol alone does not identify it. Morpho Blue has many USDC
   * markets on one chain, so a Morpho vault shows its lender name ("Morpho uniBTC-USDC 77").
   */
  marketName?: string;
  /** False when the market does not accept deposits now. Unset on the placeholder vault. */
  canOpen?: boolean;
  /** The risk level when the service gives a known label. `risk` holds the text for any other label. */
  riskLevel?: EarnRiskLevel;
  /** The vault as the lib read it. The deposit makes its market from this (`earnMarketForVault`). */
  info?: EarnVaultInfo;
  asset: string;
  network: string;
  apy: string;
  aprPercent?: number;
  apyChange24h: string;
  tvl: string;
  risk: string;
  audited: boolean;
  about: string;
  chartData: EarnChartPoint[];
}
