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
