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

/**
 * How much of the native asset the user may actually send, holding back enough to
 * pay the transaction's own fee.
 *
 * The kernel charges `baseFee x (floor(log2(cycles)) + 1)`, and cycles are not
 * knowable until the transaction is proven -- so no caller can quote the exact
 * fee up front. We reserve a deliberate upper bound instead: observed devnet
 * transactions land near 17x the base fee, so 30x keeps ~1.8x headroom and a send
 * that passes this check does not then fail in the epilogue.
 *
 * `balance` is decimal-scaled for display while `verificationBaseFee` is in the
 * asset's smallest unit, so the reserve is converted before subtracting. Mixing
 * them would reserve 300000 MIDEN instead of 0.3 and disable sending entirely.
 */
export const FEE_RESERVE_MULTIPLE = 30;

export function maxSendableNative(
  balance: number,
  verificationBaseFee: number | null,
  decimals: number
): number {
  if (verificationBaseFee === null || verificationBaseFee <= 0) {
    return balance;
  }
  const reserve = (verificationBaseFee * FEE_RESERVE_MULTIPLE) / 10 ** decimals;
  return Math.max(0, balance - reserve);
}

/**
 * Whether claiming a note yields the holder more than it costs to claim.
 *
 * Auto-consume runs unattended, so a note worth less than its own fee makes the
 * balance go DOWN when the wallet collects it. That is also a cheap griefing
 * vector: one fee buys an attacker a batch of dust notes, each of which costs the
 * victim a fee to sweep up.
 *
 * The floor is exactly the fee -- the only threshold that is arithmetically
 * provable rather than a judgement call. A note at or below it cannot profit the
 * holder; a note above it nets something, however little. Anything stricter would
 * start refusing notes a user might reasonably want, which is a product decision
 * rather than arithmetic.
 *
 * Both arguments are in the asset's smallest unit -- note amounts arrive from the
 * chain unscaled, so unlike the send cap there is no decimals conversion here.
 * Fails open on an unknown fee: refusing to claim during startup strands value.
 */
export function isWorthClaiming(amount: bigint, verificationBaseFee: number | null): boolean {
  if (verificationBaseFee === null || verificationBaseFee <= 0) {
    return true;
  }
  return amount > BigInt(verificationBaseFee);
}
