import type { BridgeReviewContext, ReviewedTransfer } from './review';
import type { BridgeRoute } from './routes';

export interface SubmissionChecks {
  readCurrent: () => Promise<BridgeReviewContext>;
  verifyBalanceCap?: (route: BridgeRoute, amount: string, account: string) => Promise<void>;
  now: () => number;
}
export async function verifyBridgeSubmission(_review: ReviewedTransfer, _checks: SubmissionChecks): Promise<void> {
  throw new Error('Unsupported bridge core');
}
