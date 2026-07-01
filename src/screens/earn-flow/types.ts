export interface EarnSummary {
  totalRewards: string;
  blendedApy: string;
  totalDeposited: string;
  estimatedRewards: string;
}

export interface EarnPosition {
  id: string;
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
