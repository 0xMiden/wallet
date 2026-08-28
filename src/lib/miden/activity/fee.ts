import type { OutputNote, TransactionResult } from '@miden-sdk/miden-sdk';

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

/** Whether an output note is the kernel's fee note rather than one the user created. */
export function isFeeNote(note: OutputNote): boolean {
  try {
    return note.metadata()?.tag()?.asU32() === TX_FEE_NOTE_TAG;
  } catch {
    return false;
  }
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
 * Never throws: this runs while recording a transaction the user has already sent,
 * and losing the whole row to a missing accessor would be worse than losing the
 * fee figure.
 */
export function feePaidFromResult(result: TransactionResult): FeePaid | undefined {
  try {
    const notes = result.executedTransaction().outputNotes().notes();
    for (const note of notes) {
      if (!isFeeNote(note)) continue;
      const assets = note.assets()?.fungibleAssets() ?? [];
      const first = assets[0];
      if (!first) continue;
      return { amount: BigInt(first.amount()), faucetId: String(first.faucetId()) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
