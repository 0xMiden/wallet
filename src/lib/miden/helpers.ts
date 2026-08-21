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
