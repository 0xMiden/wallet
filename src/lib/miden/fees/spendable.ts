import type { TokenBalanceData } from 'lib/miden/front/balance';

/**
 * Whether a transaction is certain to fail because the account holds none of the
 * asset the fee is taken in.
 *
 * Since protocol 0.16 the fee is withdrawn from the acting account's own vault in
 * the auth procedure, so an account holding only non-native tokens cannot move
 * them at all. Without this the send form stays enabled and the failure surfaces
 * after biometric confirmation, which reads as a lost transaction rather than a
 * precondition the wallet could have checked.
 *
 * Fails OPEN in every uncertain case -- an unknown fee, an unknown native asset,
 * or a native row that has not arrived. Those are indistinguishable from a
 * healthy account during startup, and blocking on them would disable sending on
 * chains that charge nothing at all.
 */
export function hasNoFeeAsset(
  balances: readonly TokenBalanceData[],
  nativeAssetId: string | undefined | null,
  verificationBaseFee: number | null
): boolean {
  if (verificationBaseFee === null || verificationBaseFee <= 0) {
    return false;
  }
  if (!nativeAssetId) {
    return false;
  }
  const native = balances.find(balance => balance.tokenId === nativeAssetId);
  if (native === undefined) {
    return false;
  }
  return native.balance <= 0;
}
