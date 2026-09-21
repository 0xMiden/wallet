export interface EarnSummary {
  totalRewards: string;
  blendedApy: string;
  totalDeposited: string;
  estimatedRewards: string;
}

export interface EarnPosition {
  id: string;
  /** Id of the vault this position lives in — links "Deposit more" back into `/earn/vaults/{vaultId}/deposit`. */
  vaultId: string;
  /** Raw Epoch fields retained for Smart Withdraw once its SDK methods ship. */
  owner: string;
  marketUid: string;
  chainId: string;
  underlyingAddress: string;
  withdrawable: string;
  decimals: number;
  protocol: string;
  asset: string;
  network: string;
  amount: string;
  depositedAmount: string;
  rewards: string;
  age: string;
  activeDuration: string;
  apy: string;
  dailyAverage: string;
  started: string;
  yearlyEstimate: string;
  withdrawTime: string;
  route: string;
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

export interface EarnVault {
  id: string;
  protocol: string;
  asset: string;
  network: string;
  apy: string;
  apyChange24h: string;
  tvl: string;
  risk: string;
  audited: boolean;
  about: string;
  chartData: EarnChartPoint[];
}
