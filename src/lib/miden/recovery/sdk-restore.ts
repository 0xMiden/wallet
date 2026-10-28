import { NoteFile, type MidenClient } from '@miden-sdk/miden-sdk/lazy';

import { restoreRetainedGuardianAccount, type RecoveryAccountMaterial } from './account-restore';
import { StorageContinuityError } from './continuity';
import { JOURNAL_MAX_BYTES, JOURNAL_MAX_ENTRIES } from './journal';
import { recoveryNoteUsage } from './note-candidates';
import {
  initializeSdkGeneration,
  assertRetainedInputRecord,
  readSdkGeneration,
  readSdkRecoverySnapshot,
  type RecoverySdkReader
} from './sdk-snapshot';
import { fromSerializable } from './serialization';
import type { RecoveryNoteEntry } from './types';
import { isRecoveryAccount, isRecoveryNote } from './validation';
import { assertSdkRecoveryCommandWire } from './wire-preflight';
import { noteDetailsCommitment } from '../sdk/note-details-commitment';

export type SdkRecoveryCommand =
  | { kind: 'account'; material: RecoveryAccountMaterial }
  | { kind: 'note'; note: RecoveryNoteEntry; accountId: string }
  | { kind: 'generation'; generation: string };

export interface RecoverySdkWriter extends RecoverySdkReader {
  accounts: Pick<MidenClient['accounts'], 'get' | 'insert'>;
  notes: RecoverySdkReader['notes'] & Pick<MidenClient['notes'], 'import'>;
}

export async function advanceRecoveryChain(
  client: Pick<MidenClient, 'getSyncHeight' | 'syncChain'>,
  target: number,
  assertCurrent: () => void
): Promise<void> {
  if (!Number.isSafeInteger(target) || target < 0 || target > 0xffffffff) throw new StorageContinuityError();
  assertCurrent();
  const before = await client.getSyncHeight();
  assertCurrent();
  if (!Number.isSafeInteger(before) || before < 0 || before > 0xffffffff) throw new StorageContinuityError();
  if (before < target) return;
  const result = await client.syncChain();
  try {
    assertCurrent();
  } finally {
    result.free();
  }
  const after = await client.getSyncHeight();
  assertCurrent();
  if (!Number.isSafeInteger(after) || after < target || after > 0xffffffff) throw new StorageContinuityError();
}

export async function restoreSdkRecovery(
  client: RecoverySdkWriter,
  command: SdkRecoveryCommand,
  assertCurrent: () => void,
  acquire?: (file: NoteFile, importNote: () => Promise<unknown>) => Promise<unknown>,
  advance?: (target: number) => Promise<void>
): Promise<void> {
  assertCurrent();
  if (command.kind === 'account') {
    await restoreRetainedGuardianAccount(client, command.material, assertCurrent);
  } else if (command.kind === 'generation') {
    const old = await readSdkGeneration(client);
    assertCurrent();
    if (old !== null && old !== command.generation) throw new StorageContinuityError();
    await initializeSdkGeneration(client, command.generation, old, assertCurrent);
  } else {
    const note = command.note;
    if (
      !isRecoveryNote(note) ||
      recoveryNoteUsage([note]).bytes > JOURNAL_MAX_BYTES ||
      recoveryNoteUsage([note]).count > JOURNAL_MAX_ENTRIES ||
      note.provenance !== 'input'
    )
      throw new StorageContinuityError();
    const file = NoteFile.deserialize(note.noteFile);
    try {
      const importBytes = file.serialize().slice();
      if (importBytes.byteLength === 0 || importBytes.byteLength > JOURNAL_MAX_BYTES)
        throw new StorageContinuityError();
      const full = file.note();
      const details = file.noteDetails() ?? full;
      if (!details) throw new StorageContinuityError();
      const commitment = noteDetailsCommitment(details);
      const id = file.noteId()?.toString();
      if (id) {
        const existing = await client.notes.list({ ids: [id] });
        assertCurrent();
        if (existing.length > 1) throw new StorageContinuityError();
        if (existing.length === 1) {
          assertRetainedInputRecord(existing[0]!, commitment, full !== undefined);
          return;
        }
      }
      const proof = file.inclusionProof();
      try {
        const location = proof?.location();
        try {
          if (location && advance) await advance(location.blockNum());
        } finally {
          location?.free();
        }
      } finally {
        proof?.free();
      }
      assertCurrent();
      const importNote = () => {
        assertCurrent();
        // The async SDK owns this separate handle, including native refusal.
        return client.notes.import(NoteFile.deserialize(importBytes));
      };
      if (acquire) await acquire(file, importNote);
      else await importNote();
      assertCurrent();
      await readSdkRecoverySnapshot(client, [command.accountId], !id, assertCurrent, [note]);
    } finally {
      file.free();
    }
  }
  assertCurrent();
}

export function decodeSdkRecoveryCommand(value: unknown): SdkRecoveryCommand {
  assertSdkRecoveryCommandWire(value);
  const decoded: unknown = fromSerializable(value);
  if (typeof decoded !== 'object' || decoded === null) throw new StorageContinuityError();
  const kind: unknown = Reflect.get(decoded, 'kind');
  if (kind === 'generation') {
    const generation: unknown = Reflect.get(decoded, 'generation');
    if (typeof generation !== 'string' || generation.length < 1 || generation.length > 128)
      throw new StorageContinuityError();
    return { kind, generation };
  }
  if (kind === 'note') {
    const note: unknown = Reflect.get(decoded, 'note');
    const accountId: unknown = Reflect.get(decoded, 'accountId');
    if (
      !isRecoveryNote(note) ||
      recoveryNoteUsage([note]).bytes > JOURNAL_MAX_BYTES ||
      recoveryNoteUsage([note]).count > JOURNAL_MAX_ENTRIES ||
      typeof accountId !== 'string' ||
      accountId.length > 2048
    )
      throw new StorageContinuityError();
    return { kind, note, accountId };
  }
  const material: unknown = Reflect.get(decoded, 'material');
  if (kind !== 'account' || typeof material !== 'object' || material === null) throw new StorageContinuityError();
  const floor: unknown = Reflect.get(material, 'floor');
  const accountBytes: unknown = Reflect.get(material, 'accountBytes');
  const guardianCommitment: unknown = Reflect.get(material, 'guardianCommitment');
  const signerCommitments: unknown = Reflect.get(material, 'signerCommitments');
  const chainCommitment: unknown = Reflect.get(material, 'chainCommitment');
  if (
    !isRecoveryAccount(floor) ||
    !(accountBytes instanceof Uint8Array) ||
    accountBytes.length > JOURNAL_MAX_BYTES ||
    typeof guardianCommitment !== 'string' ||
    guardianCommitment.length > 2048 ||
    typeof chainCommitment !== 'string' ||
    chainCommitment.length > 2048 ||
    !Array.isArray(signerCommitments) ||
    signerCommitments.length === 0 ||
    signerCommitments.length > 2 ||
    !signerCommitments.every(
      (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 2048
    )
  )
    throw new StorageContinuityError();
  return { kind, material: { floor, accountBytes, guardianCommitment, signerCommitments, chainCommitment } };
}
