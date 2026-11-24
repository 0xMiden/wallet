import type { BridgeRoute } from './routes';

export type BridgeProvider = 'agglayer' | 'epoch' | 'xreserve';
export type FlowMode = 'receive' | 'send';
export type ActivityStatus =
  | 'signature'
  | 'source_finality'
  | 'message_observed'
  | 'claim_available'
  | 'claim_submitted'
  | 'failed'
  | 'complete';
export interface BridgeActivity {
  id: string;
  mode: FlowMode;
  provider: BridgeProvider;
  routeSnapshot?: BridgeRoute;
  routeId?: string;
  environment?: string;
  amount: string;
  asset: string;
  status: ActivityStatus;
  sourceTxHash?: string;
  destinationTxHash?: string;
  midenTxId?: string;
  claimTxHash?: string;
  updatedAt: number;
  sourceTxAt?: number;
  destinationTxAt?: number;
}
