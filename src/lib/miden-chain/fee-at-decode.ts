import { cacheScope, getVerificationBaseFeeSync, isVerificationBaseFeeKnownAbsent } from 'lib/miden-chain/native-asset';

/**
 * Whether a transaction summary decoded now cannot tell its kernel fee note apart: `feeScope` differs from this
 * realm's cache scope, or the cached chain fee is null and not known-absent. `feeScope` is the scope of the fresh
 * fee read that preceded the decode. A summary has no block header, so its fee split reads this realm's cache.
 *
 * The caller asks this with no await before the split, and refuses the summary as an unknown fee when it holds. An
 * executed result splits on its own header and does not ask.
 */
export function isSummaryFeeUnknownAtDecode(feeScope: string): boolean {
  if (cacheScope() !== feeScope) return true;
  return getVerificationBaseFeeSync() === null && !isVerificationBaseFeeKnownAbsent();
}
