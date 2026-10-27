import { type NoteFile, NoteType } from '@miden-sdk/miden-sdk/lazy';

import { JOURNAL_MAX_BYTES } from './journal';
import type { RecoveryNoteEntry } from './types';
import { isRecoveryNote } from './validation';
import { normalizedCommitment, noteDetailsCommitment } from '../sdk/note-details-commitment';
import { StorageUnavailableError } from '../storage-health';

export type NoteAcquisitionSink = (
  notes: RecoveryNoteEntry[],
  network: string,
  assertCurrent: () => void
) => Promise<void>;

let installedSink: NoteAcquisitionSink | undefined;

export function installNoteAcquisitionSink(sink: NoteAcquisitionSink | undefined): void {
  installedSink = sink;
}

export function uninstallNoteAcquisitionSink(sink: NoteAcquisitionSink): void {
  if (installedSink === sink) installedSink = undefined;
}

export function isNoteAcquisitionSinkInstalled(sink: NoteAcquisitionSink): boolean {
  return installedSink === sink;
}

/** Copies a structurally decoded file while its caller owns the WASM hold. */
export function captureAcquiredNote(file: NoteFile): RecoveryNoteEntry[] {
  const note = file.note();
  const details = file.noteDetails();
  const metadata = note?.metadata();
  const identifier = file.noteId();
  try {
    if (metadata?.noteType() === NoteType.Public) return [];
    const body = note ?? details;
    if (!body) return [];
    const detailsId = noteDetailsCommitment(body);
    const entry: RecoveryNoteEntry = {
      kind: 'note',
      id: identifier ? normalizedCommitment(identifier.toString()) : detailsId,
      detailsId,
      noteFile: file.serialize().slice(),
      provenance: 'input',
      format: note ? 'full' : 'details'
    };
    if (!isRecoveryNote(entry) || entry.noteFile.byteLength > JOURNAL_MAX_BYTES)
      throw new Error('Invalid acquired note');
    return [entry];
  } finally {
    identifier?.free();
    metadata?.free();
    note?.free();
    details?.free();
  }
}

export function sameAcquiredNote(left: RecoveryNoteEntry, right: RecoveryNoteEntry): boolean {
  const leftId = normalizedCommitment(left.id);
  const rightId = normalizedCommitment(right.id);
  return (
    leftId === rightId ||
    leftId === right.detailsId ||
    left.detailsId === rightId ||
    (left.detailsId !== undefined && left.detailsId === right.detailsId)
  );
}

export async function retainAcquiredNotes(
  notes: RecoveryNoteEntry[],
  network: string,
  assertCurrent: () => void
): Promise<() => void> {
  const sink = installedSink;
  const check = () => {
    assertCurrent();
    if (!sink || installedSink !== sink) throw new StorageUnavailableError();
  };
  check();
  if (!sink) throw new StorageUnavailableError();
  try {
    await sink(notes, network, check);
  } catch (error) {
    check();
    throw error;
  }
  check();
  return check;
}
