import { assertReviewedBridge, type BridgeReviewContext, type ReviewedTransfer } from './review';
import type { BridgeRoute } from './routes';

export interface SubmissionChecks {
  readCurrent: () => Promise<BridgeReviewContext>;
  verifyBalanceCap?: (route: BridgeRoute, amount: string, account: string) => Promise<void>;
  now: () => number;
}

/** Admission only. Existing wallet provider/transaction owners perform any actual submission. */
export async function verifyBridgeSubmission(review: ReviewedTransfer, checks: SubmissionChecks): Promise<void> {
  assertReviewedBridge(review, await checks.readCurrent(), checks.now());
  if (review.route.mode === 'receive') {
    if (!checks.verifyBalanceCap) throw new Error('Bridge balance-cap verification unavailable');
    await checks.verifyBalanceCap(review.route, review.amount, review.accounts.midenAccount);
  }
  const current = await checks.readCurrent();
  assertReviewedBridge(review, current, checks.now());
}
