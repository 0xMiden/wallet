import type { TokenBalanceData } from 'lib/miden/front/balance';

/**
 * Whether a transaction is certain to fail because the account cannot cover the
 * fee, which is taken in the native asset whatever the transaction moves.
 *
 * Since protocol 0.16 the fee is withdrawn from the acting account's own vault in
 * the auth procedure, so an account holding only non-native tokens cannot move
 * them at all. Without this the send form stays enabled and the failure surfaces
 * after biometric confirmation, which reads as a lost transaction rather than a
 * precondition the wallet could have checked.
 *
 * ## Why a LOWER bound here, when the send cap reserves an upper one
 *
 * The two are asking opposite questions and need opposite bounds. `maxSendableNative`
 * asks "how much can I spend and still be SAFE", so it holds back the worst case
 * (`FEE_RESERVE_MULTIPLE`). This asks "is failure CERTAIN", and answering that with
 * the worst case would disable sending for accounts that can pay perfectly well:
 * the real charge is `baseFee x (floor(log2(cycles)) + 1)` and lands near 17x on
 * devnet, so a 30x test would refuse an account holding 20x -- turning a working
 * send into a dead button, which is worse than the late failure it avoids.
 *
 * One base fee is the smallest charge the kernel can levy, so below it the fee
 * provably cannot be paid. That leaves a band (roughly 1x..30x) where the form
 * still allows a send that may fail in the epilogue; closing it needs the real
 * cycle count, which is not knowable until the transaction is proven.
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
  if (native.balance <= 0) {
    return true;
  }
  // `balance` is decimal-scaled for display, `verificationBaseFee` is in the
  // asset's smallest unit -- the same mismatch `maxSendableNative` converts for.
  // An absent or non-finite `decimals` would scale the comparison arbitrarily, so
  // fail open rather than guess.
  const decimals = native.metadata?.decimals;
  if (typeof decimals !== 'number' || !Number.isFinite(decimals)) {
    return false;
  }
  return native.balance * 10 ** decimals < verificationBaseFee;
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
 * The claim floor uses the SAME upper bound, and deliberately so.
 *
 * Both questions are "will this one transaction leave the user better off", so both
 * need a bound on what a transaction COSTS, from the same side. A LOWER bound is the
 * wrong tool for either: it admits transactions whose real cost exceeds the threshold
 * they just passed. Concretely, with the observed ~17x charge, a floor of 8x claims a
 * 10x note alone at a net loss of ~7x, and the griefing vector this check exists to
 * refuse is precisely a supply of notes sitting in that gap.
 *
 * One base fee -- what this originally compared against -- is not a candidate at all:
 * it is the per-cycle-tier UNIT, not a transaction's cost.
 */
export const CLAIM_COST_FEE_MULTIPLE = FEE_RESERVE_MULTIPLE;

export function maxSendableNative(balance: number, verificationBaseFee: number | null, decimals: number): number {
  if (verificationBaseFee === null || verificationBaseFee <= 0) {
    return balance;
  }
  const reserve = (verificationBaseFee * FEE_RESERVE_MULTIPLE) / 10 ** decimals;
  return Math.max(0, balance - reserve);
}

/**
 * Whether ONE consume transaction crediting `amount` leaves the holder better off.
 *
 * Auto-consume runs unattended, so a claim worth less than its own fee makes the
 * balance go DOWN without the user asking. That is also a cheap griefing vector: one
 * fee buys an attacker a pile of dust notes, each of which would cost the victim a fee
 * to sweep up.
 *
 * `amount` MUST BE THE TOTAL OF EVERYTHING THAT WILL BE IN ONE TRANSACTION, because
 * one transaction pays one fee. Both directions of getting this wrong are real, and
 * both were live in this codebase:
 *   - Per NOTE while batching (what the three auto-consume callers used to do) STRANDS
 *     aggregate value: twenty notes of 5x each total 100x and are comfortably worth one
 *     transaction, yet every one of them is refused individually. It also disagreed
 *     with the UI, which judges a group by its total.
 *   - Per TOTAL against a LOWER bound on the cost LOSES money, and the attacker picks
 *     the note count: a hundred dust notes summing to just over the threshold get
 *     swept for a fee roughly twice that. Hence the upper-bound multiple above.
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
  return parsed > BigInt(Math.trunc(verificationBaseFee)) * BigInt(CLAIM_COST_FEE_MULTIPLE);
}

/**
 * Sum of note amounts, in the asset's smallest unit — the value to hand
 * `isWorthClaiming` when these notes will be claimed as ONE transaction.
 *
 * Shared by the three unattended auto-consumers so they cannot drift on how the batch
 * is measured, and so none of them reverts to judging notes one at a time. Unparseable
 * amounts contribute 0 rather than throwing, for the same reason `isWorthClaiming`
 * fails open: one malformed chain value must not stop the whole pass.
 */
export function totalClaimableAmount(amounts: Array<bigint | string | null | undefined>): bigint {
  let total = 0n;
  for (const amount of amounts) {
    if (amount === null || amount === undefined) continue;
    try {
      total += typeof amount === 'bigint' ? amount : BigInt(amount);
    } catch {
      continue;
    }
  }
  return total;
}
