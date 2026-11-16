import type { TransferQuote } from './quote';
import type { BridgeRoute } from './routes';

export interface ReviewedTransfer {
  route: BridgeRoute;
  amount: string;
  accounts: { midenAccount: string; evmAddress: string };
  quote?: TransferQuote;
}
export interface BridgeReviewContext {
  route: BridgeRoute;
  amount: string;
  accounts: ReviewedTransfer['accounts'];
}
export function assertReviewedBridge(_review: ReviewedTransfer, _current: BridgeReviewContext, _now: number): void {
  throw new Error('Unsupported bridge core');
}
