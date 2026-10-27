import { type NoteFile, NoteType } from '@miden-sdk/miden-sdk/lazy';

import { JOURNAL_MAX_BYTES } from './journal';
import type { RecoveryNoteEntry } from './types';
import { isRecoveryNote } from './validation';
import { noteDetailsCommitment } from '../sdk/note-details-commitment';
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
  try {
    if (note?.metadata().noteType() === NoteType.Public) return [];
    if (!note && !details) return [];
    const id = file.noteId()?.toString() ?? (details && noteDetailsCommitment(details));
    if (!id) throw new Error('Acquired note identity unavailable');
    const entry: RecoveryNoteEntry = {
      kind: 'note',
      id,
      noteFile: file.serialize().slice(),
      provenance: 'input',
      format: note ? 'full' : 'details'
    };
    if (!isRecoveryNote(entry) || entry.noteFile.byteLength > JOURNAL_MAX_BYTES)
      throw new Error('Invalid acquired note');
    return [entry];
  } finally {
    note?.free();
    details?.free();
  }
}

export async function retainAcquiredNotes(
  notes: RecoveryNoteEntry[],
  network: string,
  assertCurrent: () => void
): Promise<void> {
  const sink = installedSink;
  const check = () => {
    assertCurrent();
    if (!sink || installedSink !== sink) throw new StorageUnavailableError();
  };
  check();
  if (!sink) throw new StorageUnavailableError();
  await sink(notes, network, check);
  check();
}
