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

/**
 * Lower bound on what a transaction actually costs, as a multiple of the base fee.
 *
 * The same `baseFee x (floor(log2(cycles)) + 1)` charge drives this and
 * `FEE_RESERVE_MULTIPLE`, from opposite directions: reserving for a send needs an
 * UPPER bound (30x, so an accepted send cannot fail on its fee), while deciding
 * whether a note is worth claiming needs a LOWER one (a note must beat the cheapest
 * fee the claim could possibly cost). Observed transactions land near 17x, so 8x is
 * deliberately conservative -- it errs toward claiming, which strands nothing.
 *
 * One base fee, which is what this used to compare against, is not a candidate for
 * either bound: it is the per-cycle-tier UNIT, not a transaction's cost. Using it
 * meant every note between 1x and ~17x passed a check whose entire purpose was to
 * refuse notes that cost more to claim than they yield.
 */
export const MIN_CLAIM_FEE_MULTIPLE = 8;

export function maxSendableNative(balance: number, verificationBaseFee: number | null, decimals: number): number {
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
 * The floor is a CONSERVATIVE LOWER BOUND on the real charge
 * (`MIN_CLAIM_FEE_MULTIPLE x baseFee`), not the base fee itself. The base fee is the
 * per-cycle-tier unit rather than a transaction's cost -- the kernel charges
 * `baseFee x (floor(log2(cycles)) + 1)`, which lands near 17x in practice -- so
 * comparing a note against one base fee admitted every note between 1x and ~17x at a
 * net loss, which is exactly the outcome (and the griefing vector) this check exists
 * to refuse. Erring low keeps the failure mode on the safe side: a marginal note gets
 * claimed rather than stranded.
 *
 * `amount` here is the amount the CLAIM will credit -- callers that batch several
 * notes into one transaction must pass the batch total, since one transaction pays
 * one fee.
 *
 * Both arguments are in the asset's smallest unit -- note amounts arrive from the
 * chain unscaled, so unlike the send cap there is no decimals conversion here.
 * Fails open on an unknown fee: refusing to claim during startup strands value.
 */
export function isWorthClaiming(
  amount: bigint | string | null | undefined,
  verificationBaseFee: number | null
): boolean {
  if (verificationBaseFee === null || verificationBaseFee <= 0) {
    return true;
  }
  // Callers run this inside unattended loops over chain-supplied data, so an
  // amount that will not parse must not throw: that would stop the consumer for
  // every note, not just the malformed one. Fail open and let the transaction
  // itself be the judge.
  let parsed: bigint;
  try {
    if (amount === null || amount === undefined) {
      return true;
    }
    parsed = typeof amount === 'bigint' ? amount : BigInt(amount);
  } catch {
    return true;
  }
  // `Math.trunc` before `BigInt`: a non-integral fee would throw a RangeError here,
  // and this expression sits OUTSIDE the try above.
  return parsed > BigInt(Math.trunc(verificationBaseFee)) * BigInt(MIN_CLAIM_FEE_MULTIPLE);
}
