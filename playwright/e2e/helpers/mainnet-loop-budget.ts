export type MainnetLoopProvider = 'swap' | 'epoch' | 'near';
export interface PortfolioSample {
  identity: string;
  decimals: number;
  usdMicros: bigint;
  before: bigint;
  after: bigint;
}
export const MAINNET_LOOP_LOSS_CAP = 2_000_000n;
export function remainingMainnetLoopBudget(
  _runId: string,
  _provider: MainnetLoopProvider,
  _completed: readonly unknown[]
): bigint {
  return MAINNET_LOOP_LOSS_CAP;
}
export function realizedMainnetLoopLoss(_samples: readonly PortfolioSample[]): bigint {
  return 0n;
}
