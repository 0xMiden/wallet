import type { WalletClient } from 'viem';

import type { BridgeNoteDeps } from 'lib/epoch/miden-note';

import type { BridgeReviewContext, ReviewedTransfer } from './core/review';

export type BridgeWalletDeps = BridgeNoteDeps & {
  getContext: () => BridgeReviewContext;
  getEvmWallet: () => Promise<WalletClient | undefined>;
  onOperation: (id: string) => void;
};
/** Public operationId is the durable wallet row id, not the internal BridgeOperationInput correlation UUID. */
export type BridgeSubmissionOutcome =
  | { kind: 'started'; operationId: string }
  | { kind: 'rejected'; operationId?: string };

export async function submitReviewedBridge(
  review: ReviewedTransfer,
  deps: BridgeWalletDeps
): Promise<BridgeSubmissionOutcome> {
  void review;
  void deps;
  return { kind: 'rejected' };
}
