export interface SwapHolding {
  faucetId: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  usdMicros: bigint;
}

export interface SwapLegBound {
  offered: SwapHolding;
  requested: SwapHolding;
  offer: bigint;
  minimumReceive: bigint;
  full: boolean;
  settlementsRunning: boolean;
}

export interface SwapLoopCandidate {
  forward: SwapLegBound;
  reverse: SwapLegBound;
  native: SwapHolding;
  baseFee: bigint;
  recoveryTxs: bigint;
}

export interface SwapLoopPlan extends SwapLoopCandidate {
  worstCaseLossUsdMicros: bigint;
  nativeReserve: bigint;
}

export function planMainnetSwapLoop(_candidate: SwapLoopCandidate): SwapLoopPlan {
  throw new Error('not implemented');
}

export function chooseMainnetSwapLoop(_candidates: readonly SwapLoopPlan[]): SwapLoopPlan | undefined {
  throw new Error('not implemented');
}

export function swapSearchAmounts(_holding: SwapHolding): bigint[] {
  throw new Error('not implemented');
}
