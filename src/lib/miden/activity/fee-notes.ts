import type { OutputNote } from '@miden-sdk/miden-sdk';

import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';

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

/** The bech32 faucet of a note's single fungible asset, or `undefined`. */
function soleFungibleFaucet(note: OutputNote): string | undefined {
  try {
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

/**
 * Split output notes into the kernel's fee note and the notes the user actually created.
 *
 * The tag ALONE is not evidence. `0xfee` is a plain u32 that anything constructing a
 * `NoteMetadata` can set, and a dApp's `transactionRequest` reaches
 * `requestCustomTransaction` verbatim — so a website could add an output note carrying
 * that tag and have the wallet record it as this transaction's "Network Fee" while
 * ERASING it from the transaction's amount and note list. The user still approves that
 * note on the confirmation sheet (which does not consult this code), so it is history
 * forgery rather than an unauthorized spend, but a wallet should not be the one
 * mislabelling it.
 *
 * Two corroborations, both cheap:
 *   - the note holds exactly ONE fungible asset, drawn on the chain's NATIVE faucet,
 *     which is the only asset a fee is ever paid in;
 *   - exactly ONE candidate exists. The kernel emits one. If a second appears, we cannot
 *     say which is real, so NEITHER is treated as the fee: the fee figure is dropped and
 *     both notes stay in the totals. That errs toward showing the user more than they
 *     spent rather than hiding a real note, which is the right direction for a receipt.
 *
 * When the native faucet is not yet discovered the tag is all there is, so it is used
 * alone rather than counting the kernel's fee note as user value — the inflated-amount
 * bug the tag check exists to prevent. That window is a fresh install before its first
 * successful discovery, and nothing in it is attacker-selected.
 */
export function partitionFeeNote(
  notes: OutputNote[],
  nativeFaucetId: string | null
): { feeNote: OutputNote | undefined; userNotes: UserOutputNote[] } {
  const candidates = notes.filter(note => {
    if (!hasFeeTag(note)) return false;
    if (nativeFaucetId === null) return true;
    return soleFungibleFaucet(note) === nativeFaucetId;
  });
  const feeNote = candidates.length === 1 ? candidates[0] : undefined;
  // The cast is the ONE place the brand is minted, and it is sound exactly here: every
  // note in the returned array has been checked against the fee predicate above.
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
 * nothing. Enforced by the `no-restricted-syntax` rule that bans `.outputNotes()` outside
 * this module.
 */
export function splitExecutedOutputNotes(executed: { outputNotes: () => { notes: () => OutputNote[] } }): {
  feeNote: OutputNote | undefined;
  userNotes: UserOutputNote[];
} {
  return partitionFeeNote(executed.outputNotes().notes(), getNativeAssetIdSync());
}
