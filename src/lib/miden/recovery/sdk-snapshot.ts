import { type MidenClient, NoteFile, NoteType } from '@miden-sdk/miden-sdk/lazy';

import { fromSerializable } from './serialization';
import { isRecoveryNote, validateJournal } from './validation';
import { markStorageUnavailable } from '../storage-health';
import { StorageContinuityError } from './continuity';
import { JOURNAL_MAX_BYTES, JOURNAL_MAX_ENTRIES } from './journal';
import { withRecoveryStorageLock } from './lock';
import type { RecoveryAccountExpectation, RecoveryNoteEntry } from './types';
import { noteDetailsCommitment } from '../sdk/note-details-commitment';

export interface RecoverySdkReader {
  settings: Pick<MidenClient['settings'], 'get' | 'set'>;
  accounts: Pick<MidenClient['accounts'], 'get'>;
  notes: Pick<MidenClient['notes'], 'list'>;
  storeIdentifier: MidenClient['storeIdentifier'];
}

function refuseNoteCapacity(): never {
  markStorageUnavailable('journal', { backend: 'independent', operation: 'validate' });
  throw new Error('Recovery journal note capacity exceeded');
}

export const SDK_GENERATION_KEY = 'bread.store-generation.v1';
export interface SdkRecoverySnapshot {
  generation: string | null;
  accounts: RecoveryAccountExpectation[];
  notes: RecoveryNoteEntry[];
}

export async function readSdkGeneration(client: RecoverySdkReader): Promise<string | null> {
  const value = await client.settings.get<unknown>(SDK_GENERATION_KEY);
  if (value !== null && (typeof value !== 'string' || value.length < 1 || value.length > 128))
    throw new StorageContinuityError();
  return value;
}

export async function initializeSdkGeneration(
  client: RecoverySdkReader,
  generation: string,
  previousGeneration: string | null,
  assertCurrent: () => void
): Promise<void> {
  await withRecoveryStorageLock(async () => {
    assertCurrent();
    const old = await readSdkGeneration(client);
    assertCurrent();
    if (old !== previousGeneration) throw new StorageContinuityError();
    if (old !== generation) await client.settings.set(SDK_GENERATION_KEY, generation);
    assertCurrent();
    if ((await readSdkGeneration(client)) !== generation) throw new StorageContinuityError();
    assertCurrent();
  });
}

/** Pinned SDK0.17.5 index and miden-client0.17.4 UNSPENT_STATES. Count before WASM materializes note bodies. */
export function countRetainedInputNotes(databaseName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      request.result.close();
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction('inputNotes', 'readonly');
        const index = tx.objectStore('inputNotes').index('stateDiscriminant');
        const counts: number[] = [];
        for (const state of [0, 1, 2, 4, 5]) {
          const countRequest = index.count(state);
          countRequest.onsuccess = () => {
            counts.push(countRequest.result);
          };
        }
        tx.oncomplete = () => {
          db.close();
          resolve(counts.reduce((sum, count) => sum + count, 0));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new StorageContinuityError());
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  });
}

export async function readSdkRecoverySnapshot(
  client: RecoverySdkReader,
  accountIds: string[],
  includeNotes: boolean,
  assertCurrent: () => void,
  retainedNotes: RecoveryNoteEntry[] = []
): Promise<SdkRecoverySnapshot> {
  if (
    accountIds.length === 0 ||
    accountIds.length > 256 ||
    accountIds.some(id => typeof id !== 'string' || id.length > 2048)
  )
    throw new StorageContinuityError();
  const generation = await readSdkGeneration(client);
  assertCurrent();
  const accounts: RecoveryAccountExpectation[] = [];
  for (const accountId of accountIds) {
    const account = await client.accounts.get(accountId);
    assertCurrent();
    if (!account) throw new StorageContinuityError();
    const commitment = account.to_commitment();
    accounts.push({ accountId, nonce: account.nonce().asInt().toString(), commitment: commitment.toHex() });
    commitment.free();
  }
  const notes: RecoveryNoteEntry[] = [];
  if (includeNotes) {
    const databaseName = await client.storeIdentifier();
    assertCurrent();
    const count = await countRetainedInputNotes(databaseName).catch(() => {
      throw new StorageContinuityError();
    });
    assertCurrent();
    if (count > JOURNAL_MAX_ENTRIES) refuseNoteCapacity();
    let bytes = 0;
    for (const status of ['expected', 'unverified', 'committed', 'processing']) {
      if (status !== 'expected' && status !== 'unverified' && status !== 'committed' && status !== 'processing')
        continue;
      const records = await client.notes.list({ status });
      assertCurrent();
      for (const record of records) {
        const metadata = record.metadata();
        if (metadata && metadata.noteType() !== NoteType.Private) continue;
        const details = record.details();
        const id = record.id()?.toString() ?? noteDetailsCommitment(details);
        let file: NoteFile;
        let format: 'full' | 'details' = 'full';
        try {
          file = NoteFile.fromInputNote(record.toInputNote());
        } catch {
          file = NoteFile.fromNoteDetails(details);
          format = 'details';
        }
        try {
          const noteFile = file.serialize();
          bytes += noteFile.byteLength;
          if (bytes > JOURNAL_MAX_BYTES || notes.length >= JOURNAL_MAX_ENTRIES) refuseNoteCapacity();
          notes.push({ kind: 'note', id, noteFile, provenance: 'input', format });
        } finally {
          file.free();
        }
      }
    }
  }
  if (retainedNotes.length > JOURNAL_MAX_ENTRIES) throw new StorageContinuityError();
  for (const retained of retainedNotes) {
    if (retained.provenance !== 'input') continue;
    assertCurrent();
    const file = NoteFile.deserialize(retained.noteFile);
    try {
      const details = file.noteDetails() ?? file.note();
      if (!details) throw new StorageContinuityError();
      const commitment = noteDetailsCommitment(details);
      const id = file.noteId()?.toString();
      if (id) {
        const records = await client.notes.list({ ids: [id] });
        assertCurrent();
        if (records.length !== 1 || noteDetailsCommitment(records[0]!.details()) !== commitment)
          throw new StorageContinuityError();
      } else {
        const match = notes.some(note => {
          const candidate = NoteFile.deserialize(note.noteFile);
          try {
            const candidateDetails = candidate.noteDetails() ?? candidate.note();
            return candidateDetails !== undefined && noteDetailsCommitment(candidateDetails) === commitment;
          } finally {
            candidate.free();
          }
        });
        if (!match) throw new StorageContinuityError();
      }
    } finally {
      file.free();
    }
  }
  assertCurrent();
  return { generation, accounts, notes };
}

export function decodeSdkRecoverySnapshot(value: unknown): SdkRecoverySnapshot {
  if (typeof value !== 'object' || value === null) throw new StorageContinuityError();
  const generation: unknown = Reflect.get(value, 'generation');
  if (generation !== null && (typeof generation !== 'string' || generation.length > 128))
    throw new StorageContinuityError();
  const decoded = validateJournal(
    fromSerializable({
      version: 1,
      sequence: 1,
      scope: { network: 'wire', walletGeneration: 'wire', sdkGeneration: 'wire' },
      accounts: Reflect.get(value, 'accounts'),
      entries: Reflect.get(value, 'notes')
    })
  );
  const notes: RecoveryNoteEntry[] = [];
  for (const entry of decoded.entries) {
    if (entry.kind !== 'note') throw new StorageContinuityError();
    notes.push(entry);
  }
  return { generation, accounts: decoded.accounts, notes };
}

export function decodeRetainedRecoveryNotes(value: unknown): RecoveryNoteEntry[] {
  if (value === undefined) return [];
  const decoded: unknown = fromSerializable(value);
  if (
    !Array.isArray(decoded) ||
    decoded.length > JOURNAL_MAX_ENTRIES ||
    !decoded.every(isRecoveryNote) ||
    decoded.reduce((size, note) => size + note.noteFile.byteLength, 0) > JOURNAL_MAX_BYTES
  )
    throw new StorageContinuityError();
  return decoded;
}
