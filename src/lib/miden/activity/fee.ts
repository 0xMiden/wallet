import type { OutputNote, TransactionResult } from '@miden-sdk/miden-sdk';

import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { formatAmount } from 'lib/shared/format';

import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';

/**
 * Tag carried by the TX_FEE note the kernel emits when a transaction pays a fee.
 *
 * The fee leaves the account as a real output note, so it shows up alongside the
 * notes the user meant to create. Anything totalling output value has to exclude
 * it, or a send appears to move more than it did.
 */
export const TX_FEE_NOTE_TAG = 0xfee;

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
): { feeNote: OutputNote | undefined; userNotes: OutputNote[] } {
  const candidates = notes.filter(note => {
    if (!hasFeeTag(note)) return false;
    if (nativeFaucetId === null) return true;
    return soleFungibleFaucet(note) === nativeFaucetId;
  });
  const feeNote = candidates.length === 1 ? candidates[0] : undefined;
  return { feeNote, userNotes: feeNote ? notes.filter(note => note !== feeNote) : notes };
}

/**
 * The fee this transaction actually paid, or `undefined` if it paid none.
 *
 * Read from the emitted note rather than computed, because the charge is
 * `baseFee x (floor(log2(cycles)) + 1)` and the cycle count is only known once the
 * transaction has run -- `verificationBaseFee` alone understates it by an order of
 * magnitude. The vault delta is not usable either: the SDK exposes the post-state
 * absolutely, not as a difference.
 *
 * Absorbs a missing or throwing accessor: this runs while recording a transaction the
 * user has already sent, and losing the whole row to it would be worse than losing the
 * fee figure.
 *
 * An EVICTION is the one exception and propagates. Every accessor here borrows from the
 * WASM client's RefCell, so once the watchdog has handed the mutex to a successor these
 * reads are touching a client another flow is inside. Swallowing that would return a
 * plausible `undefined` and let the caller run its NEXT WASM read on the same evicted
 * client -- the double borrow the poison contract exists to prevent.
 */
export function feePaidFromResult(result: TransactionResult): FeePaid | undefined {
  try {
    const notes = result.executedTransaction().outputNotes().notes();
    const { feeNote } = partitionFeeNote(notes, getNativeAssetIdSync());
    if (!feeNote) {
      return undefined;
    }
    const assets = feeNote.assets()?.fungibleAssets() ?? [];
    const first = assets[0];
    if (!first) {
      return undefined;
    }
    // BECH32, like every other faucet id the wallet stores -- `String(AccountId)`
    // gives canonical hex, and the two are different encodings of the same account.
    // `assetsMetadata` is keyed by bech32 and `resolveDisplayMetadata` compares the
    // native faucet id by string equality, so a hex id missed both, resolved to the
    // unknown-token placeholder (`scaleIsUnknown: true`) and made `hasKnownScale`
    // false -- which meant the receipt's fee row was never rendered at all.
    return { amount: BigInt(first.amount()), faucetId: getBech32AddressFromAccountId(first.faucetId()) };
  } catch (err) {
    if (isWasmClientPoisonedError(err)) {
      throw err;
    }
    return undefined;
  }
}

/**
 * The fee fields to record on a transaction row, ready to spread into an update.
 *
 * Returns an empty object rather than `{ feeAmount: undefined }` when no fee was
 * paid: these spread into a partial update that `Object.assign`s over the stored
 * row, so writing explicit undefineds would erase whatever is already there.
 */
export function feeFieldsFromResult(result: TransactionResult | undefined): {
  feeAmount?: bigint;
  feeFaucetId?: string;
} {
  if (!result) {
    return {};
  }
  const paid = feePaidFromResult(result);
  return paid ? { feeAmount: paid.amount, feeFaucetId: paid.faucetId } : {};
}

/**
 * The fee, formatted for display, or `undefined` when the row recorded none.
 *
 * Absent for every row written before fees were charged and for every row on a
 * zero-fee chain, so callers render the line conditionally rather than showing a
 * blank or a zero that would imply the wallet failed to read it.
 */
export function feeTextFromTransaction(
  transaction: { feeAmount?: bigint },
  decimals: number | undefined,
  symbol: string
): string | undefined {
  if (transaction.feeAmount === undefined) {
    return undefined;
  }
  return `${formatAmount(transaction.feeAmount, decimals)} ${symbol}`;
}
