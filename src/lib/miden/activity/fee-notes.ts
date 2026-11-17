import type { OutputNote } from '@miden-sdk/miden-sdk';

import { FEE_RESERVE_MULTIPLE } from 'lib/miden/fees/spendable';
import { getNativeAssetIdSync, getVerificationBaseFeeSync } from 'lib/miden-chain/native-asset';

import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { retireLandedTrap } from '../sdk/landed-trap-retirement';
import { rethrowTrapOrKill } from '../sdk/sdk-error-code';

/**
 * Fee-note identification, kept in a LEAF module on purpose.
 *
 * `splitExecutedOutputNotes` and `splitLandedOutputNotes` have to be callable from every
 * completion path, the confirm sheet and the dApp-facing serializer -- and `fee.ts` reaches `lib/shared/format`, which
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

/** A landed fee check trapped, so this note cannot be ruled out as the kernel's fee. */
const UNRULED = Symbol('unruled');

/**
 * On the landed path, record a fee-check trap and return true so only that check is answered. With no ledger a trap
 * is rethrown, and a kill always propagates.
 */
function answerLandedTrap(err: unknown, traps: WebAssembly.RuntimeError[] | undefined): boolean {
  if (traps !== undefined && typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) {
    traps.push(err);
    return true;
  }
  rethrowTrapOrKill(err);
  return false;
}

/**
 * Whether an output note carries the fee tag. NOT sufficient on its own - see below.
 *
 * Tolerates a missing accessor but lets a TRAP or a KILL through (`rethrowTrapOrKill`), as
 * every fee check below does unless the landed split passes `traps`, which records a trap
 * instead. These accessors run in the client's WASM instance, so a swallowed trap would
 * leave the hold this runs in on an instance its lock never retires, and a swallowed kill
 * would answer for a pipeline that was stopped.
 */
function hasFeeTag(note: OutputNote, traps?: WebAssembly.RuntimeError[]): boolean | typeof UNRULED {
  try {
    return note.metadata()?.tag()?.asU32() === TX_FEE_NOTE_TAG;
  } catch (err) {
    // Landed: the tag is unknown, so the faucet and amount checks decide whether the note can be ruled out.
    if (answerLandedTrap(err, traps)) return UNRULED;
    return false;
  }
}

/**
 * The bech32 faucet of a note's single fungible asset, or `undefined`.
 *
 * Also `undefined` for a note that carries an NFT: the fee note holds one fungible asset and nothing else, and being
 * taken for it removes a note from the approval sheet, which must never happen to a note holding an NFT.
 */
function soleFungibleFaucet(note: OutputNote, traps?: WebAssembly.RuntimeError[]): string | undefined | typeof UNRULED {
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
    // Landed: a trap cannot rule the note out. An ordinary failure is not a candidate.
    if (answerLandedTrap(err, traps)) return UNRULED;
    return undefined;
  }
}

/** The most the kernel can charge at `verificationBaseFee`, or undefined when that is not a safe integer. */
function feeCeiling(verificationBaseFee: number): bigint | undefined {
  const ceiling = Math.round(verificationBaseFee * FEE_RESERVE_MULTIPLE);
  return Number.isSafeInteger(ceiling) ? BigInt(ceiling) : undefined;
}

/** Whether the note's first fungible amount is at most `ceiling`; false when it cannot be read. */
function withinFeeCeiling(
  note: OutputNote,
  ceiling: bigint,
  traps?: WebAssembly.RuntimeError[]
): boolean | typeof UNRULED {
  try {
    const amount = (note.assets()?.fungibleAssets() ?? [])[0]?.amount();
    return amount !== undefined && BigInt(amount) <= ceiling;
  } catch (err) {
    if (answerLandedTrap(err, traps)) return UNRULED;
    return false;
  }
}

function feeCandidateVerdict(
  note: OutputNote,
  nativeFaucetId: string,
  ceiling: 'kernel' | 'recorded',
  kernelCeiling: bigint | undefined,
  traps: WebAssembly.RuntimeError[] | undefined
): 'candidate' | 'unruled' | 'no' {
  const tagged = hasFeeTag(note, traps);
  // UNRULED is a symbol, so it is tested before the truthiness check.
  if (tagged === UNRULED) return unknownTagVerdict(note, nativeFaucetId, ceiling, kernelCeiling, traps);
  if (!tagged) return 'no';
  const faucet = soleFungibleFaucet(note, traps);
  if (faucet === UNRULED) return 'unruled';
  if (faucet !== nativeFaucetId) return 'no';
  if (ceiling === 'recorded') return 'candidate';
  if (kernelCeiling === undefined) return 'no';
  const within = withinFeeCeiling(note, kernelCeiling, traps);
  if (within === UNRULED) return 'unruled';
  return within ? 'candidate' : 'no';
}

/**
 * A landed note whose tag read trapped may be a fee-tagged candidate, so it is ruled out only by a faucet that is not
 * the sole native one or an amount over the ceiling; anything else, a faucet or amount trap included, is ambiguous.
 */
function unknownTagVerdict(
  note: OutputNote,
  nativeFaucetId: string,
  ceiling: 'kernel' | 'recorded',
  kernelCeiling: bigint | undefined,
  traps: WebAssembly.RuntimeError[] | undefined
): 'unruled' | 'no' {
  const faucet = soleFungibleFaucet(note, traps);
  if (ceiling === 'kernel' && kernelCeiling === undefined) return 'no';
  // Read even when the faucet rules the note out, so an amount trap is still recorded.
  const within =
    kernelCeiling !== undefined && ceiling === 'kernel' ? withinFeeCeiling(note, kernelCeiling, traps) : true;
  if (faucet !== UNRULED && faucet !== nativeFaucetId) return 'no';
  return within === false ? 'no' : 'unruled';
}

/**
 * Split output notes into the kernel's fee note and the notes the user actually created.
 *
 * The tag ALONE is not evidence. `0xfee` is a plain u32 that anything constructing a
 * `NoteMetadata` can set, and a dApp's `transactionRequest` reaches
 * `requestCustomTransaction` verbatim - so a website can add an output note carrying that
 * tag. Being identified as the fee is not a cosmetic relabel: the note is REMOVED from the
 * output-note list and its value is taken back out of the amounts, so this is how a
 * transfer disappears from a screen the user is approving. THIS MODULE IS THAT SCREEN'S
 * SPLIT - `decode.ts` calls it for both verified views - so the note is attacker-chosen and
 * the corroborations below are a security boundary, not tidiness.
 *
 * Every condition must hold, and each closes a way the tag alone was forgeable:
 *   - the CHAIN CHARGES. On a chain whose `verification_base_fee` is 0 the kernel emits no
 *     fee note at all, so any note wearing the tag is by construction not one. Without this
 *     a single native tagged note passes every other check on testnet - no race, no cold
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
 * briefly counted as user value - an inflated amount, in the same direction as the
 * two-candidate case, and the direction a receipt should err. The alternative, trusting the
 * tag alone, is what let an attacker-chosen note erase itself from an approval sheet
 * whenever a realm had not primed its cache - and the confirm popup is a SEPARATE realm
 * whose sync cache starts empty on every open.
 */
export function partitionFeeNote(
  notes: OutputNote[],
  nativeFaucetId: string | null,
  verificationBaseFee: number | null,
  ceiling: 'kernel' | 'recorded' = 'kernel'
): { feeNote: OutputNote | undefined; userNotes: UserOutputNote[] } {
  return partitionNotes(notes, nativeFaucetId, verificationBaseFee, ceiling);
}

function partitionNotes(
  notes: OutputNote[],
  nativeFaucetId: string | null,
  verificationBaseFee: number | null,
  ceiling: 'kernel' | 'recorded' = 'kernel',
  traps?: WebAssembly.RuntimeError[]
): { feeNote: OutputNote | undefined; userNotes: UserOutputNote[] } {
  // `'kernel'` measures `feeCeiling`. `'recorded'` must not call it.
  const kernelCeiling =
    ceiling === 'kernel' && verificationBaseFee !== null && verificationBaseFee > 0
      ? feeCeiling(verificationBaseFee)
      : undefined;
  const candidates: OutputNote[] = [];
  let unruled = false;
  if (
    verificationBaseFee !== null &&
    verificationBaseFee > 0 &&
    nativeFaucetId !== null &&
    (ceiling === 'recorded' || kernelCeiling !== undefined)
  ) {
    for (const note of notes) {
      const verdict = feeCandidateVerdict(note, nativeFaucetId, ceiling, kernelCeiling, traps);
      if (verdict === 'candidate') candidates.push(note);
      if (verdict === 'unruled') unruled = true;
    }
  }
  // A note that cannot be ruled out (a fee-tagged note whose faucet or amount check trapped, or a note whose tag read
  // trapped that its faucet and amount do not rule out) makes the split ambiguous exactly as a second candidate does:
  // no note is the fee.
  const feeNote = !unruled && candidates.length === 1 ? candidates[0] : undefined;
  // The ONE place the brand is minted. Sound when a fee note was identified: that note is
  // the only one the predicate matched and it is filtered out. In the AMBIGUOUS branch the
  // unresolved candidates are branded too -- deliberately, per the docblock above: two
  // fee-tagged notes mean we cannot say which is real, so both stay in the totals rather
  // than one being silently erased from them.
  const userNotes = (feeNote ? notes.filter(note => note !== feeNote) : notes) as UserOutputNote[];
  return { feeNote, userNotes };
}

type ExecutedOutputs = {
  outputNotes: () => { notes: () => OutputNote[] };
  blockHeader?: () => { verificationBaseFee: () => number };
};

/**
 * The ONLY place in the wallet that reads an executed transaction's raw output notes, with
 * {@link splitLandedOutputNotes}.
 *
 * `ExecutedTransaction.outputNotes()` returns the kernel's fee note alongside the user's,
 * so every caller has to split them -- and the ones that forgot did not fail, they silently
 * picked or counted the wrong note on a fee-charging chain while staying green at fee 0.
 * Routing every read through here means a caller cannot forget: it gets the split back or
 * nothing. The `no-restricted-syntax` rule bans every `.outputNotes()` call, and the read
 * both splits share is the one disable.
 *
 * A trap or a kill in a fee check is thrown as itself, so the WASM hold a caller runs in
 * retires the client instead of trusting an answer read from it.
 */
export function splitExecutedOutputNotes(
  executed: ExecutedOutputs,
  ceiling: 'kernel' | 'recorded' = 'kernel'
): {
  feeNote: OutputNote | undefined;
  userNotes: UserOutputNote[];
} {
  const notes = readOutputNotes(executed);
  return partitionNotes(notes, getNativeAssetIdSync(), executedBaseFee(executed), ceiling);
}

/**
 * {@link splitExecutedOutputNotes} for a reader past submit and outside any hold, where a landed row that failed would
 * offer a Retry that pays twice. The check that trapped does not take its note as the fee: a tag trap leaves the tag
 * unknown, the faucet and amount checks still run, a note they rule out is not a candidate, and one they cannot rule
 * out makes the split ambiguous, as a faucet or amount trap on a fee-tagged note does. A header trap identifies none,
 * and the split logs the trap. A kill, and a trap from `executedTransaction()` or the output-note read itself, still
 * propagate. A fee-check trap retires the realm client first, once per `landing`, the wallet row id
 * (`sdk/landed-trap-retirement.ts`).
 */
export function splitLandedOutputNotes(
  result: { executedTransaction: () => ExecutedOutputs },
  landing: string
): {
  feeNote: OutputNote | undefined;
  userNotes: UserOutputNote[];
} {
  const executed = result.executedTransaction();
  const notes = readOutputNotes(executed);
  const traps: WebAssembly.RuntimeError[] = [];
  const split = partitionNotes(notes, getNativeAssetIdSync(), executedBaseFee(executed, traps), 'kernel', traps);
  if (traps.length > 0) {
    console.warn('[fee-notes] landed fee split answered a trap', traps);
    // No lock sees a trap past submit, so the split that answers it retires the client.
    retireLandedTrap(traps[0], landing, result);
  }
  return split;
}

/** Read before any fee check, so a split that answers a trap still has the notes. */
function readOutputNotes(executed: ExecutedOutputs): OutputNote[] {
  // eslint-disable-next-line no-restricted-syntax -- sanctioned outputNotes() read
  return executed.outputNotes().notes();
}

/** The kernel charged against the reference block's rate, which the realm cache can lag behind. */
function executedBaseFee(executed: ExecutedOutputs, traps?: WebAssembly.RuntimeError[]): number | null {
  return executed.blockHeader
    ? headerBaseFee(executed.blockHeader.bind(executed), traps)
    : getVerificationBaseFeeSync();
}

function headerBaseFee(
  read: () => { verificationBaseFee: () => number },
  traps?: WebAssembly.RuntimeError[]
): number | null {
  try {
    return read().verificationBaseFee();
  } catch (err) {
    // Landed: a header trap is an unknown fee, so no note is the fee.
    answerLandedTrap(err, traps);
    return null;
  }
}
