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
  /** The document's name of this position's vault, when the document lists its market. */
  name?: string;
  /** The name of the market when neither the document nor the protocol identifies it. */
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
  /** The id the document lists the vault under (`earn.vaults[].id`). Unset (empty) on the placeholder vault. */
  id: string;
  /** The document's name of the vault, shown as written in every language. Unset on the placeholder vault. */
  name?: string;
  /** The name of the lender family ("Aave V3", "Morpho"), or the lender's own name outside the known families. */
  protocol: string;
  /** The name of this market, when neither the document nor the protocol identifies it. */
  marketName?: string;
  /** The document's `about` sentence, shown under the name. Unset when the document gives none. */
  listedAbout?: string;
  /**
   * False when the vault does not take a deposit now: the catalogue does not open it, or the document stops its
   * deposits. Unset on the placeholder vault.
   */
  canOpen?: boolean;
  /** False when the document stops new deposits into the vault (`depositsEnabled: false`). */
  depositsEnabled?: boolean;
  /** The risk level when the document or the service gives a known label. `risk` holds the text for any other. */
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
  /** The document's `about` when it sets one, else the catalogue's description, else the placeholder. */
  about: string;
  chartData: EarnChartPoint[];
}
