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

export const toNoteType = (noteType: NoteTypeString) => (noteType === 'public' ? NoteType.Public : NoteType.Private);

// The chain doesn't commit to a fixed cadence, so recall-height → wall-clock
// conversion is an estimate for display only.
export const ESTIMATED_MS_PER_BLOCK = 3_000;

// P2IDE note storage layout (miden-standards 0.16 `src/note/p2ide.rs`,
// `impl From<P2ideNoteStorage> for NoteStorage`):
// [reclaimer.suffix, reclaimer.prefix, target.suffix, target.prefix,
//  reclaim_height, timelock_height], Felt::ZERO = unset.
//
// Miden 0.15 had only four items ([target.suffix, target.prefix, reclaim,
// timelock]) and the reclaim height sat at index 2. 0.16 prepended the
// reclaimer pair, so index 2 now holds `target.suffix()` — an AccountId suffix
// felt, which is far larger than any plausible block height. Reading the wrong
// slot therefore fails the range check below and silently suppresses the
// "returns to sender by" banner on every recallable note.
const P2IDE_RECLAIM_HEIGHT_INDEX = 4;
const P2IDE_STORAGE_ITEM_COUNT = 6;

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
    const items = recipient.storage().items();
    // Bail rather than index blind when the layout is not the one this constant
    // was written for: a future protocol move that shifts the slot again must
    // hide the banner, never render a felt from an unrelated slot as a date.
    if (items.length !== P2IDE_STORAGE_ITEM_COUNT) return undefined;
    const reclaimFelt = items[P2IDE_RECLAIM_HEIGHT_INDEX];
    if (!reclaimFelt) return undefined;
    const reclaimHeight = Number(reclaimFelt.asInt());
    if (reclaimHeight <= 0 || reclaimHeight > 0xffffffff) return undefined;
    return Date.now() + (reclaimHeight - syncHeight) * ESTIMATED_MS_PER_BLOCK;
  } catch {
    return undefined;
  }
}
