import type { TokenBalanceData } from 'lib/miden/front/balance';
import { hasKnownScale } from 'lib/miden/metadata/scale';

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
  const held = feeAssetHeld(balances, nativeAssetId);
  return held !== null && held < verificationBaseFee;
}

/**
 * The fee asset the vault holds, in the asset's smallest unit, or `null` when that cannot be
 * stated: an unknown native asset, a native row that has not arrived, or an unknown scale. A row at
 * or below zero is 0 whatever its scale.
 */
function feeAssetHeld(balances: readonly TokenBalanceData[], nativeAssetId: string | undefined | null): number | null {
  if (!nativeAssetId) {
    return null;
  }
  const native = balances.find(balance => balance.tokenId === nativeAssetId);
  if (native === undefined) {
    return null;
  }
  if (native.balance <= 0) {
    return 0;
  }
  // `balance` is decimal-scaled for display, `verificationBaseFee` is in the
  // asset's smallest unit -- the same mismatch `maxSendableNative` converts for.
  // An absent or non-finite `decimals` would scale the comparison arbitrarily, so
  // fail open rather than guess.
  //
  // `hasKnownScale` is the load-bearing half of that test, not a duplicate of it:
  // `DEFAULT_TOKEN_METADATA` carries `decimals: 6` with `scaleIsUnknown: true`,
  // so a placeholder record passes the `typeof` test with an INVENTED scale and
  // would block on arithmetic nobody stated. Both balance builders
  // hard-wire `MIDEN_METADATA` for the native row today, so this is a latent
  // shape rather than a live one -- which is exactly when it is cheap to close.
  const decimals = native.metadata?.decimals;
  if (typeof decimals !== 'number' || !Number.isFinite(decimals) || !hasKnownScale(native.metadata)) {
    return null;
  }
  return native.balance * 10 ** decimals;
}

/** What the claim fee check reads from a note. */
export interface ClaimFeeNote {
  faucetId: string;
  /** The listed asset's amount, in its smallest unit. */
  amount: string;
  /** The note holds fungible assets beyond the listed one. */
  carriesMoreAssets?: boolean;
  /** The note's full asset list is not known. */
  assetsUnknown?: boolean;
}

/** Activity's decimal-scaled balances adapted to the shared base-unit claim fee rule. */
export function claimFeeShortfalls(
  transactions: ReadonlyArray<readonly ClaimFeeNote[]>,
  ahead: readonly ClaimFeeNote[],
  balances: readonly TokenBalanceData[],
  nativeAssetId: string | undefined | null,
  verificationBaseFee: number | null
): boolean[] {
  const held = feeAssetHeld(balances, nativeAssetId);
  const vaultFeeAsset = held !== null && Number.isFinite(held) ? BigInt(Math.round(held)) : null;
  return claimFeeShortfallsBaseUnits(transactions, ahead, vaultFeeAsset, nativeAssetId, verificationBaseFee);
}

/**
 * For each consume transaction of a claim, whether it is certain to fail because the account cannot pay its network
 * fee. `ahead` holds every note that may be consumed before these transactions, in any order: the claims already
 * queued, and in Accept All the groups it queued before.
 *
 * Unlike a send, a claim can pay for itself. The kernel runs every input note's script before the epilogue's auth
 * procedure withdraws the fee from the vault, so the fee asset a consumed note carries is already there to pay it: a
 * new wallet pays for claiming its first USDCX out of that very note. So a transaction is refused only when the
 * vault's fee asset plus what its own notes carry is below one base fee, `hasNoFeeAsset`'s LOWER bound, because this
 * asks the same question, whether failure is certain, and no note ahead carries the fee asset.
 *
 * Nothing ahead is simulated. Which row the queue runs first turns on state the list cannot see (cooldowns, recovery
 * holds, deduplication), so any fee asset ahead may land first and admits every transaction, and the fees paid ahead
 * are not charged: a claim they leave unable to pay fails at signing, as it would without this check. Each transaction
 * is judged alone, so none of them funds another; a caller queueing them one by one adds each queued one to `ahead`.
 *
 * Fails OPEN, refusing nothing, when the fee, native asset or vault holding is unknown or a note ahead holds assets
 * the list does not show (any of them may be the fee asset), and admits a transaction whose own notes hold such
 * assets or whose fee-asset amount does not parse.
 */
export function claimFeeShortfallsBaseUnits(
  transactions: readonly (readonly ClaimFeeNote[])[],
  ahead: readonly ClaimFeeNote[],
  vaultFeeAsset: bigint | null,
  nativeAssetId: string | undefined | null,
  verificationBaseFee: number | null
): boolean[] {
  const refuseNone = transactions.map(() => false);
  if (
    vaultFeeAsset === null ||
    !nativeAssetId ||
    verificationBaseFee === null ||
    !Number.isFinite(verificationBaseFee) ||
    verificationBaseFee <= 0
  ) {
    return refuseNone;
  }
  const hasUnknownAssets = (note: ClaimFeeNote) =>
    note.assetsUnknown || note.carriesMoreAssets || !note.faucetId.trim() || !note.amount.trim();
  if (ahead.some(note => hasUnknownAssets(note) || note.faucetId === nativeAssetId)) {
    return refuseNone;
  }
  // A whole-unit budget is below a fractional fee exactly when it is below its ceiling.
  const fee = BigInt(Math.ceil(verificationBaseFee));
  return transactions.map(notes => {
    let available = vaultFeeAsset;
    for (const note of notes) {
      if (hasUnknownAssets(note)) return false;
      if (note.faucetId !== nativeAssetId) continue;
      try {
        available += BigInt(note.amount);
      } catch {
        return false;
      }
    }
    return available < fee;
  });
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

/**
 * What a seed-recovered account is asked to receive before its everyday key can be
 * activated (#805): one claim and one rotation, each bounded by the reserve above.
 */
export const ROTATION_FUNDING_MIN_FEE_MULTIPLE = 2 * FEE_RESERVE_MULTIPLE;

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
 * Sum of note amounts, in the asset's smallest unit - the value to hand
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
