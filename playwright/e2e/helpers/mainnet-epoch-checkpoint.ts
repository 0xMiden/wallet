import type { SavedSwapHolding, SwapLoopPhase } from './mainnet-swap-checkpoint';

export interface EpochEvmSnapshot {
  chainId: 1 | 42161;
  account: string;
  token: string;
  compact: string;
  allocator: string;
  tokenBalance: string;
  nativeBalance: string;
  tokenUsdMicros: string;
  nativeUsdMicros: string;
}
export interface EpochEvmTransaction {
  kind: 'approve' | 'deposit' | 'withdraw' | 'cancel';
  nonce: number;
  hash: string;
  feeWei?: string;
}
export interface MainnetEpochCheckpoint {
  version: 1;
  network: 'mainnet';
  account: string;
  accountHex: string;
  sourceRunId: string;
  authorizationRunId: string;
  phase: SwapLoopPhase;
  createdAt: string;
  pricedAt: string;
  updatedAt: string;
  native: SavedSwapHolding;
  evm: EpochEvmSnapshot;
  allocatorUrl: string;
  virtualChainId: number;
  principal: string;
  forwardMinimum: string;
  reverseMinimum: string;
  lossBudgetUsdMicros: string;
  feeBudget: string;
  evmFeeBudget: string;
  paidMidenFees: string;
  paidEvmFees: string;
  forwardNonce: string;
  forwardNoteId?: string;
  forwardMidenTxId?: string;
  forwardEvmTxHash?: string;
  forwardReceived?: string;
  reverseNonce?: string;
  returnAmount?: string;
  evmNonceBefore?: number;
  transactions?: EpochEvmTransaction[];
  returnNoteId?: string;
  returnMidenTxId?: string;
  reverseReceived?: string;
  after?: { native: string; evmToken: string; evmNative: string };
  realizedCostUsdMicros?: string;
}
export interface EpochIntentEvidence {
  nonce: string;
  sponsor: string;
  midenAccount: string;
  tokenIn: string;
  tokenOut: string;
  tokenInAmount: string;
  minTokenOut: string;
  destinationChainId: number;
  recipient: string;
}

export function parseMainnetEpochCheckpoint(value: unknown): unknown { return value; }
export function loadMainnetEpochCheckpoint(_path: string): MainnetEpochCheckpoint | undefined { return undefined; }
export function saveMainnetEpochCheckpoint(_path: string, _state: MainnetEpochCheckpoint): void {}
export function mainnetEpochNextAction(_state: Pick<MainnetEpochCheckpoint, 'phase'> | undefined): string { return 'prepare'; }
export function matchAuthorizedEpoch(
  _state: MainnetEpochCheckpoint, _rows: EpochIntentEvidence[], _leg: 'forward' | 'reverse'
): EpochIntentEvidence | undefined { return undefined; }
