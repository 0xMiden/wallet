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

/**
 * Whether a persisted or dApp-supplied note type means "private", rejecting
 * anything unrecognized.
 *
 * Both shapes genuinely reach the request builders: `ITransaction.noteType` is
 * DECLARED as the SDK's numeric `NoteType`, but `initiateSendTransaction`
 * persists the `'public' | 'private'` string, so a value typed as the enum may
 * be either at runtime.
 *
 * Unknown values throw, mirroring the SDK's own `resolveNoteType`. The wallet
 * used to hand the raw value to `client.send()`, which threw; building the note
 * locally moved that decision here, and a plain `=== 'private' ? Private :
 * Public` would answer "public" for every unrecognized value — including the
 * numeric `NoteType.Private`, which is `0`. A note the user approved as Private
 * would then go out fully public and irreversibly, so this fails the send
 * instead.
 */
export const isPrivateNoteType = (noteType: NoteType | NoteTypeString | string | null | undefined): boolean => {
  if (noteType === NoteTypeEnum.Private || noteType === NoteType.Private) return true;
  // `null`/`undefined` ⇒ public, matching the SDK: a row that never recorded a
  // note type predates the field and was public.
  if (noteType === NoteTypeEnum.Public || noteType === NoteType.Public || noteType == null) return false;
  throw new Error(`Unknown note type: "${String(noteType)}". Expected "public" or "private".`);
};

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
