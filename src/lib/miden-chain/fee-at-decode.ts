import { cacheScope, getVerificationBaseFeeSync, isVerificationBaseFeeKnownAbsent } from 'lib/miden-chain/native-asset';

/**
 * Whether a transaction summary decoded now cannot tell its kernel fee note apart: the cached chain fee is unknown,
 * or, when `feeScope` is the scope of the fresh fee read that preceded the decode, the endpoint has moved since that
 * read. A summary has no block header, so its fee split reads this realm's cache.
 *
 * The caller asks this with no await before the split, and refuses the summary as an unknown fee when it holds. An
 * executed result splits on its own header and does not ask.
 */
export function isSummaryFeeUnknownAtDecode(feeScope?: string): boolean {
  if (feeScope !== undefined && cacheScope() !== feeScope) return true;
  return getVerificationBaseFeeSync() === null && !isVerificationBaseFeeKnownAbsent();
}
