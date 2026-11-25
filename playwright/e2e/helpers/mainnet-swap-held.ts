import type { MainnetSwapCheckpoint, SwapOrderEvidence } from './mainnet-swap-checkpoint';
import type { MainnetSwapPaybackEvidence } from './mainnet-swap-claim';

export interface SwapHeldLive {
  runId: string;
  now: number;
  balances: { offer: bigint; request: bigint; native: bigint };
  payback: MainnetSwapPaybackEvidence | undefined;
  orders: SwapOrderEvidence[];
  pendingWalletRows: number;
}

export function closeSwapHeldDust(_state: MainnetSwapCheckpoint, _live: SwapHeldLive): boolean {
  return false;
}
