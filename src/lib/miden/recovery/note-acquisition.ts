import { type NoteFile, NoteType } from '@miden-sdk/miden-sdk/lazy';

import { JOURNAL_MAX_BYTES, JOURNAL_MAX_ENTRIES } from './journal';
import { fromSerializable } from './serialization';
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

function preflightAcquiredNotes(value: unknown): void {
  if (!Array.isArray(value) || value.length > JOURNAL_MAX_ENTRIES) throw new Error('Invalid acquired notes');
  let bytes = 0;
  for (const note of value) {
    if (typeof note !== 'object' || note === null || Array.isArray(note)) throw new Error('Invalid acquired note');
    const id: unknown = Reflect.get(note, 'id');
    const detailsId: unknown = Reflect.get(note, 'detailsId');
    const format: unknown = Reflect.get(note, 'format');
    const body: unknown = Reflect.get(note, 'noteFile');
    if (
      Object.keys(note).some(key => !['kind', 'id', 'detailsId', 'noteFile', 'provenance', 'format'].includes(key)) ||
      Reflect.get(note, 'kind') !== 'note' ||
      Reflect.get(note, 'provenance') !== 'input' ||
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 2048 ||
      (detailsId !== undefined &&
        (typeof detailsId !== 'string' || detailsId.length !== 64 || !/^[0-9a-f]{64}$/.test(detailsId))) ||
      (format !== undefined && format !== 'full' && format !== 'details') ||
      !Array.isArray(body) ||
      body.length === 0 ||
      body.length > JOURNAL_MAX_BYTES - bytes
    )
      throw new Error('Invalid acquired note');
    bytes += body.length;
    for (let index = 0; index < body.length; index++) {
      const byte: unknown = body[index];
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)
        throw new Error('Invalid acquired note bytes');
    }
  }
}

export function decodeAcquiredNotes(value: unknown): RecoveryNoteEntry[] {
  preflightAcquiredNotes(value);
  const decoded: unknown = fromSerializable(value);
  if (
    !Array.isArray(decoded) ||
    decoded.length > JOURNAL_MAX_ENTRIES ||
    !decoded.every(
      (note: unknown): note is RecoveryNoteEntry =>
        isRecoveryNote(note) &&
        note.provenance === 'input' &&
        Object.keys(note).every(key => ['kind', 'id', 'detailsId', 'noteFile', 'provenance', 'format'].includes(key))
    ) ||
    decoded.reduce((bytes, note) => bytes + note.noteFile.byteLength, 0) > JOURNAL_MAX_BYTES
  )
    throw new Error('Invalid acquired notes');
  return decoded;
}

export function captureNoteAcquisitionRetainer() {
  const sink = installedSink;
  const assertSinkCurrent = () => {
    if (!sink || installedSink !== sink) throw new StorageUnavailableError();
  };
  const retain = async (
    notes: RecoveryNoteEntry[],
    network: string,
    assertCurrent: () => void,
    onFailure?: (error: unknown) => void
  ): Promise<() => void> => {
    const check = () => {
      assertCurrent();
      assertSinkCurrent();
    };
    check();
    if (!sink) throw new StorageUnavailableError();
    try {
      await sink(notes, network, check);
    } catch (error) {
      onFailure?.(error);
      check();
      throw error;
    }
    check();
    return check;
  };
  return Object.assign(retain, { assertSinkCurrent });
}

export function retainAcquiredNotes(notes: RecoveryNoteEntry[], network: string, assertCurrent: () => void) {
  return captureNoteAcquisitionRetainer()(notes, network, assertCurrent);
}
