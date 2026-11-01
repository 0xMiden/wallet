import { NoteFile, NoteType, type TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { JOURNAL_MAX_BYTES, JOURNAL_MAX_ENTRIES } from './journal';
import { recoveryNoteUsage } from './note-candidates';
import { fromSerializable } from './serialization';
import type { RecoveryCapture, RecoveryNoteEntry } from './types';
import { isRecoveryNote } from './validation';
import { assertRecoveryCaptureWire } from './wire-preflight';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

export function captureRecoveryNotes(
  result: TransactionResult,
  requestBytes: Uint8Array,
  holdIsCurrent: () => boolean
): RecoveryCapture {
  if (!holdIsCurrent()) throw new WasmClientPoisonedError('watchdog', new Error('Recovery capture lost its hold'));
  const executed = result.executedTransaction();
  const notes: RecoveryNoteEntry[] = [];
  let size = requestBytes.byteLength;
  const retain = (id: string, file: NoteFile, provenance: 'input' | 'output') => {
    try {
      const noteFile = file.serialize();
      size += noteFile.byteLength;
      if (size > JOURNAL_MAX_BYTES || notes.length >= JOURNAL_MAX_ENTRIES)
        throw new Error('Recovery capture capacity exceeded');
      notes.push({ kind: 'note', id, noteFile, provenance, format: 'full' });
    } finally {
      file.free();
    }
  };
  for (const note of executed.inputNotes().notes()) {
    if (note.note().metadata().noteType() === NoteType.Public) continue;
    retain(note.id().toString(), NoteFile.fromInputNote(note), 'input');
  }
  for (const note of executed.userOutputNotes()) {
    if (note.metadata().noteType() === NoteType.Public) continue;
    if (note.metadata().noteType() === NoteType.Private) {
      const full = note.intoFull();
      if (!full) throw new Error('Private output recovery body unavailable');
      full.free();
    }
    retain(note.id().toString(), NoteFile.fromOutputNote(note), 'output');
  }
  return decodeRecoveryCapture({ requestBytes, notes });
}

export function decodeRecoveryCapture(value: unknown): RecoveryCapture {
  assertRecoveryCaptureWire(value);
  const decoded =
    typeof value === 'object' && value !== null && Reflect.get(value, 'requestBytes') instanceof Uint8Array
      ? value
      : fromSerializable(value);
  if (typeof decoded !== 'object' || decoded === null) throw new Error('Invalid recovery capture');
  const requestBytes: unknown = Reflect.get(decoded, 'requestBytes');
  const notes: unknown = Reflect.get(decoded, 'notes');
  if (
    Object.keys(decoded).some(key => key !== 'requestBytes' && key !== 'notes') ||
    !(requestBytes instanceof Uint8Array) ||
    requestBytes.length === 0 ||
    !Array.isArray(notes) ||
    notes.length > JOURNAL_MAX_ENTRIES ||
    !notes.every(isRecoveryNote)
  )
    throw new Error('Invalid recovery capture');
  const usage = recoveryNoteUsage(notes);
  if (usage.count > JOURNAL_MAX_ENTRIES || requestBytes.length + usage.bytes > JOURNAL_MAX_BYTES)
    throw new Error('Invalid recovery capture');
  return { requestBytes, notes };
}
