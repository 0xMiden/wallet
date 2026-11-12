import type { OneClickAppFee, OneClickFeePolicy } from '../../../src/lib/one-click/types';
import type { SavedSwapHolding, SwapLoopPhase } from './mainnet-swap-checkpoint';
import type { MainnetSendAuthority } from './mainnet-send-authorization';
import type { MainnetConsumeAuthority } from './mainnet-consume-authorization';

export interface MainnetNearQuoteAuthority {
  quoteHash: string;
  correlationId: string;
  depositAddress: string;
  deadline: string;
  amountIn: string;
  minimumOutput: string;
  refundFee: string;
}
export interface MainnetNearCheckpoint {
  version: 2;
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
  evm: { chainId: 1 | 42161; account: string; token: string; tokenBalance: string; nativeBalance: string;
    tokenUsdMicros: string; nativeUsdMicros: string };
  nativeAssetId: string;
  evmAssetId: string;
  serviceUrl: string;
  appFees: OneClickAppFee[];
  feePolicy?: OneClickFeePolicy;
  baseFee: string;
  principal: string;
  forwardMinimum: string;
  reverseMinimum: string;
  lossBudgetUsdMicros: string;
  feeBudget: string;
  evmFeeBudget: string;
  paidMidenFees: string;
  paidEvmFees: string;
  forwardQuote?: MainnetNearQuoteAuthority;
  sendAuthority?: MainnetSendAuthority;
  forwardMidenTxId?: string;
  forwardEvmTxHash?: string;
  forwardReceived?: string;
  reverseQuote?: MainnetNearQuoteAuthority;
  returnAmount?: string;
  evmNonceBefore?: number;
  returnValuation?: { pricedAt: string; nativeUsdMicros: string; tokenUsdMicros: string; gasUsdMicros: string };
  transactions?: { kind: 'transfer'; nonce: number; hash: string; feeWei?: string }[];
  returnProviderTxId?: string;
  returnNoteId?: string;
  consumeAuthority?: MainnetConsumeAuthority;
  returnMidenTxId?: string;
  reverseReceived?: string;
  refunded?: string;
  realizedCostUsdMicros?: string;
}
export function parseMainnetNearCheckpoint(_value: unknown): MainnetNearCheckpoint {
  throw new Error('Strict native NEAR checkpoint validation is not implemented');
}
export function loadMainnetNearCheckpoint(_path: string): MainnetNearCheckpoint | undefined {
  throw new Error('Native NEAR checkpoint recovery is not implemented');
}
export function saveMainnetNearCheckpoint(_path: string, _state: MainnetNearCheckpoint): void {
  throw new Error('Native NEAR checkpoint persistence is not implemented');
}
