import { Address, InputNoteRecord, NoteScript, NoteType } from '@miden-sdk/miden-sdk/lazy';

import { NoteTypeEnum, NoteType as NoteTypeString } from './types';

export function isAddressValid(address: string) {
  try {
    Address.fromBech32(address);
    return true;
  } catch {
    return false;
  }
}

export const toNoteTypeString = (noteType: NoteType) =>
  noteType === NoteType.Public ? NoteTypeEnum.Public : NoteTypeEnum.Private;

/**
 * Whether a persisted or dApp-supplied note type means "private", rejecting
 * anything unrecognized.
 *
 * Accepts two shapes because two shapes can arrive. `ITransaction.noteType` is
 * the `'public' | 'private'` string union (`lib/miden/types`), and that string is
 * what `initiateSendTransaction` persists — so every send row reaching the
 * builders carries a string. The numeric arm is for the typed seam:
 * `buildSendExecuteArgs` declares its parameter as the SDK's `NoteType | string`
 * and dApp/speculation input arrives unvalidated, so a caller can legitimately
 * hand in the enum.
 *
 * Unknown values throw, mirroring the SDK's own `resolveNoteType`. The wallet
 * used to hand the raw value to `client.send()`, which threw; building the note
 * locally moved that decision here, and a plain `=== 'private' ? Private :
 * Public` would answer "public" for every unrecognized value — including the
 * numeric `NoteType.Private`, which is `0` and therefore also falsy, so a
 * truthiness test fails the same way. A note the user approved as Private would
 * go out fully public and irreversibly, so this fails the send instead.
 */
export const isPrivateNoteType = (noteType: NoteType | NoteTypeString | string | null | undefined): boolean => {
  if (noteType === NoteTypeEnum.Private || noteType === NoteType.Private) return true;
  // `null`/`undefined` ⇒ public, matching the SDK's `resolveNoteType`. Reachable
  // only through the `noteType?:` rows (`ITransaction`, bridged-send,
  // earn-deposit), whose sends hardcode Public anyway; `SendTransaction.noteType`
  // is required. Kept so the function is total over its declared input.
  if (noteType === NoteTypeEnum.Public || noteType === NoteType.Public || noteType == null) return false;
  throw new Error(`Unknown note type: "${String(noteType)}". Expected "public" or "private".`);
};

/**
 * Normalize any accepted note-type form to the `'public' | 'private'` string
 * that is actually PERSISTED on a transaction row and compared against
 * downstream.
 *
 * Needed because the two representations are not interchangeable once stored.
 * `isPrivateNoteType` accepts the SDK's numeric enum, so a numeric value can
 * reach the request builder and correctly produce a Private note — but the row
 * then holds `0`, and `completeSendTransaction` decides whether to relay the
 * note file with `tx.noteType === NoteTypeEnum.Private`, a STRING compare that
 * `0` fails. The note would be built private and never delivered, leaving the
 * recipient unable to see or consume it. Normalizing at the boundary keeps the
 * stored form canonical so those compares cannot silently miss.
 *
 * Throws on an unrecognized value, like `isPrivateNoteType`.
 */
export const toPersistedNoteType = (noteType: NoteType | NoteTypeString | string | null | undefined): NoteTypeString =>
  isPrivateNoteType(noteType) ? NoteTypeEnum.Private : NoteTypeEnum.Public;

// The chain doesn't commit to a fixed cadence, so recall-height → wall-clock
// conversion is an estimate for display only.
export const ESTIMATED_MS_PER_BLOCK = 3_000;

/**
 * Largest relative recall offset the wallet will accept from a caller.
 *
 * Block heights are u32 on chain, and the offset is only ever used as
 * `syncHeight + recallBlocks`, so the ceiling has to leave room for the head.
 * Half the u32 space is ~2^31 blocks — on the order of two centuries at the
 * observed cadence — which is past any real recall window while keeping the sum
 * comfortably inside the type.
 */
export const MAX_RECALL_BLOCKS = 0x7fff_ffff;

/**
 * Validate a caller-supplied relative recall offset before it is persisted,
 * previewed for approval, or turned into an absolute reclaim height.
 *
 * Nothing downstream re-checks it: the offset is added to the sync height and
 * handed to the SDK as a u32 block height, and wasm-bindgen TRUNCATES a wider
 * or fractional JS number at that boundary instead of rejecting it. Every way
 * that goes wrong silently misprices the reclaim window the user approved:
 *
 * - `2 ** 32` wraps to `0`. The approval sheet says the note is recallable in
 *   four billion blocks; on chain the sender can reclaim it IMMEDIATELY, so a
 *   recipient who doesn't consume it within one block can lose the funds.
 * - A negative offset large enough to drive the sum below zero wraps the other
 *   way and strands the sender's recall for ~4 billion blocks.
 * - A fractional offset is truncated toward zero, making the note recallable
 *   earlier than the sheet said.
 *
 * `0` and `undefined` are both accepted and both mean "not recallable" — the
 * builders treat a falsy offset as a plain P2ID — so this rejects only values
 * that would be honored as a window and then quietly mean something else.
 */
export const assertValidRecallBlocks = (recallBlocks: number | undefined | null): void => {
  if (recallBlocks === undefined || recallBlocks === null) return;
  if (!Number.isSafeInteger(recallBlocks) || recallBlocks < 0 || recallBlocks > MAX_RECALL_BLOCKS) {
    throw new Error(`recallBlocks must be a whole number between 0 and ${MAX_RECALL_BLOCKS}, got ${recallBlocks}`);
  }
};

// P2IDE note storage layout (miden-standards src/note/p2ide.rs):
// [target.suffix, target.prefix, reclaim_height, timelock_height], Felt::ZERO = unset.
const P2IDE_RECLAIM_HEIGHT_INDEX = 2;

let p2ideScriptRootHex: string | undefined;

/**
 * Estimated wall-clock time (epoch ms) at which the sender of a P2IDE note
 * becomes able to reclaim it, or undefined for non-recallable notes (plain
 * P2ID scripts, or a P2IDE with no reclaim height set).
 */
export function getNoteRecallableAtMs(note: InputNoteRecord, syncHeight: number): number | undefined {
  try {
    const recipient = note.details().recipient();
    p2ideScriptRootHex ??= NoteScript.p2ide().root().toHex();
    if (recipient.script().root().toHex() !== p2ideScriptRootHex) return undefined;
    const reclaimFelt = recipient.storage().items()[P2IDE_RECLAIM_HEIGHT_INDEX];
    if (!reclaimFelt) return undefined;
    const reclaimHeight = Number(reclaimFelt.asInt());
    if (reclaimHeight <= 0 || reclaimHeight > 0xffffffff) return undefined;
    return Date.now() + (reclaimHeight - syncHeight) * ESTIMATED_MS_PER_BLOCK;
  } catch {
    return undefined;
  }
}
