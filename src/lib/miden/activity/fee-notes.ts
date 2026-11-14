import type { OutputNote } from '@miden-sdk/miden-sdk';

import { FEE_RESERVE_MULTIPLE } from 'lib/miden/fees/spendable';
import { getNativeAssetIdSync, getVerificationBaseFeeSync } from 'lib/miden-chain/native-asset';

import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

/**
 * Fee-note identification, kept in a LEAF module on purpose.
 *
 * `splitExecutedOutputNotes` has to be callable from every completion path, the confirm
 * sheet and the dApp-facing serializer -- and `fee.ts` reaches `lib/shared/format`, which
 * pulls in `lib/miden/front`. Importing that chain from those modules broke eight unrelated
 * jest suites at module load. The rule that only one module may read raw output notes is
 * only adoptable if that module is cheap to import, so the primitives live here and `fee.ts`
 * re-exports them for existing callers.
 */

export const TX_FEE_NOTE_TAG = 0xfee;

declare const UserNoteBrand: unique symbol;

/**
 * An output note that has been through {@link partitionFeeNote} and is NOT the kernel's
 * fee note.
 *
 * The brand exists because this bug class is a missing type, not insufficient care: the
 * same mistake -- index or count a raw `OutputNote[]` that silently gained a second entry
 * on a fee-charging chain -- was made independently in the swap completion, the E2E note
 * handoff, the confirm sheet and the dApp-facing result serializer. A convention cannot
 * stop the next one; a type can. Functions that pick or count notes take `UserOutputNote[]`,
 * so handing them a raw `OutputNote[]` is a compile error rather than a review finding.
 */
export type UserOutputNote = OutputNote & { readonly [UserNoteBrand]: true };

export type FeePaid = {
  /** In the fee asset's smallest unit. */
  amount: bigint;
  faucetId: string;
};

/**
 * Whether an output note carries the fee tag. NOT sufficient on its own — see below.
 *
 * Tolerates a missing accessor but lets an EVICTION through, for the reason given on
 * `feePaidFromResult`: these accessors borrow from the client's RefCell, so a swallowed
 * poison error would answer this question from a client another flow is inside.
 */
function hasFeeTag(note: OutputNote): boolean {
  try {
    return note.metadata()?.tag()?.asU32() === TX_FEE_NOTE_TAG;
  } catch (err) {
    if (isWasmClientPoisonedError(err)) {
      throw err;
    }
    return false;
  }
}

/**
 * The bech32 faucet of a note's single fungible asset, or `undefined`.
 *
 * Also `undefined` for a note that carries an NFT: the fee note holds one fungible asset and nothing else, and being
 * taken for it removes a note from the approval sheet, which must never happen to a note holding an NFT.
 */
function soleFungibleFaucet(note: OutputNote): string | undefined {
  try {
    if ((note.assets()?.nonFungibleAssets() ?? []).length > 0) {
      return undefined;
    }
    const assets = note.assets()?.fungibleAssets() ?? [];
    const first = assets[0];
    if (!first || assets.length !== 1) {
      return undefined;
    }
    return getBech32AddressFromAccountId(first.faucetId());
  } catch (err) {
    if (isWasmClientPoisonedError(err)) {
      throw err;
    }
    return undefined;
  }
}

/** The most the kernel can charge at `verificationBaseFee`, or undefined when that is not a safe integer. */
function feeCeiling(verificationBaseFee: number): bigint | undefined {
  const ceiling = Math.round(verificationBaseFee * FEE_RESERVE_MULTIPLE);
  return Number.isSafeInteger(ceiling) ? BigInt(ceiling) : undefined;
}

/** Whether the note's first fungible amount is at most `ceiling`; false when it cannot be read. */
function withinFeeCeiling(note: OutputNote, ceiling: bigint): boolean {
  try {
    const amount = (note.assets()?.fungibleAssets() ?? [])[0]?.amount();
    return amount !== undefined && BigInt(amount) <= ceiling;
  } catch (err) {
    if (isWasmClientPoisonedError(err)) {
      throw err;
    }
    return false;
  }
}

/**
 * Split output notes into the kernel's fee note and the notes the user actually created.
 *
 * The tag ALONE is not evidence. `0xfee` is a plain u32 that anything constructing a
 * `NoteMetadata` can set, and a dApp's `transactionRequest` reaches
 * `requestCustomTransaction` verbatim — so a website can add an output note carrying that
 * tag. Being identified as the fee is not a cosmetic relabel: the note is REMOVED from the
 * output-note list and its value is taken back out of the amounts, so this is how a
 * transfer disappears from a screen the user is approving. THIS MODULE IS THAT SCREEN'S
 * SPLIT — `decode.ts` calls it for both verified views — so the note is attacker-chosen and
 * the corroborations below are a security boundary, not tidiness.
 *
 * Every condition must hold, and each closes a way the tag alone was forgeable:
 *   - the CHAIN CHARGES. On a chain whose `verification_base_fee` is 0 the kernel emits no
 *     fee note at all, so any note wearing the tag is by construction not one. Without this
 *     a single native tagged note passes every other check on testnet — no race, no cold
 *     cache, just a dApp asking a fee-free chain to hide a transfer.
 *   - the note holds exactly ONE fungible asset, drawn on the chain's NATIVE faucet, which
 *     is the only asset the wallet ever commits a fee in (it always commits `one_to_one`).
 *   - the amount is at most what the kernel can charge: the base fee times
 *     `FEE_RESERVE_MULTIPLE`. The kernel charges the base fee times (ilog2(cycles) + 1) with
 *     cycles capped at 2^29, so a larger tagged note is never the fee.
 *   - exactly ONE candidate exists. The kernel emits one. If a second appears we cannot say
 *     which is real, so NEITHER is treated as the fee and both stay in the totals.
 *
 * `'recorded'` skips only that magnitude check. A past summary has no fee rate of its own, so the
 * note the chain charged can sit above `feeCeiling`, and a base fee whose kernel ceiling is not
 * a safe integer still identifies that one note. The chain-charges, tag, sole-native and
 * one-candidate checks stay. Approval and signing omit the argument and keep `'kernel'`.
 *
 * UNKNOWN FAILS CLOSED. When the base fee or the native faucet has not been discovered
 * yet, nothing is identified as the fee. The cost is that the kernel's real fee note is
 * briefly counted as user value — an inflated amount, in the same direction as the
 * two-candidate case, and the direction a receipt should err. The alternative, trusting the
 * tag alone, is what let an attacker-chosen note erase itself from an approval sheet
 * whenever a realm had not primed its cache — and the confirm popup is a SEPARATE realm
 * whose sync cache starts empty on every open.
 */
export function partitionFeeNote(
  notes: OutputNote[],
  nativeFaucetId: string | null,
  verificationBaseFee: number | null,
  ceiling: 'kernel' | 'recorded' = 'kernel'
): { feeNote: OutputNote | undefined; userNotes: UserOutputNote[] } {
  // `'kernel'` measures `feeCeiling`. `'recorded'` must not call it.
  const kernelCeiling =
    ceiling === 'kernel' && verificationBaseFee !== null && verificationBaseFee > 0
      ? feeCeiling(verificationBaseFee)
      : undefined;
  const candidates =
    verificationBaseFee !== null &&
    verificationBaseFee > 0 &&
    nativeFaucetId !== null &&
    (ceiling === 'recorded' || kernelCeiling !== undefined)
      ? notes.filter(
          note =>
            hasFeeTag(note) &&
            soleFungibleFaucet(note) === nativeFaucetId &&
            (ceiling === 'recorded' || (kernelCeiling !== undefined && withinFeeCeiling(note, kernelCeiling)))
        )
      : [];
  const feeNote = candidates.length === 1 ? candidates[0] : undefined;
  // The ONE place the brand is minted. Sound when a fee note was identified: that note is
  // the only one the predicate matched and it is filtered out. In the AMBIGUOUS branch the
  // unresolved candidates are branded too -- deliberately, per the docblock above: two
  // fee-tagged notes mean we cannot say which is real, so both stay in the totals rather
  // than one being silently erased from them.
  const userNotes = (feeNote ? notes.filter(note => note !== feeNote) : notes) as UserOutputNote[];
  return { feeNote, userNotes };
}

/**
 * The ONLY place in the wallet that reads an executed transaction's raw output notes.
 *
 * `ExecutedTransaction.outputNotes()` returns the kernel's fee note alongside the user's,
 * so every caller has to split them -- and the ones that forgot did not fail, they silently
 * picked or counted the wrong note on a fee-charging chain while staying green at fee 0.
 * Routing every read through here means a caller cannot forget: it gets the split back or
 * nothing. The `no-restricted-syntax` rule bans every `.outputNotes()` call, and this call
 * is the one disable.
 */
export function splitExecutedOutputNotes(
  executed: {
    outputNotes: () => { notes: () => OutputNote[] };
    blockHeader?: () => { verificationBaseFee: () => number };
  },
  ceiling: 'kernel' | 'recorded' = 'kernel'
): {
  feeNote: OutputNote | undefined;
  userNotes: UserOutputNote[];
} {
  // The kernel charged against the reference block's rate, which the realm cache can lag behind.
  const baseFee = executed.blockHeader
    ? headerBaseFee(executed.blockHeader.bind(executed))
    : getVerificationBaseFeeSync();
  // eslint-disable-next-line no-restricted-syntax -- sanctioned outputNotes() read
  return partitionFeeNote(executed.outputNotes().notes(), getNativeAssetIdSync(), baseFee, ceiling);
}

function headerBaseFee(read: () => { verificationBaseFee: () => number }): number | null {
  try {
    return read().verificationBaseFee();
  } catch (err) {
    if (isWasmClientPoisonedError(err)) throw err;
    return null;
  }
}
