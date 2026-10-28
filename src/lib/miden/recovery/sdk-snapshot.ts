import { type MidenClient, type InputNoteRecord, InputNoteState, NoteFile, NoteType } from '@miden-sdk/miden-sdk/lazy';

import {
  assertCanonicalNoteRequest,
  readCanonicalNoteFamilies,
  type CanonicalNoteReadback
} from './canonical-note-readback';
import { StorageContinuityError } from './continuity';
import { JOURNAL_MAX_BYTES, JOURNAL_MAX_ENTRIES } from './journal';
import { withRecoveryStorageLock } from './lock';
import { recoveryNoteUsage } from './note-candidates';
import { fromSerializable } from './serialization';
import type { RecoveryAccountExpectation, RecoveryNoteEntry } from './types';
import { isRecoveryNote, validateJournal } from './validation';
import { assertCanonicalNotesWire, assertRetainedNotesWire, assertSdkRecoverySnapshotWire } from './wire-preflight';
import { noteDetailsCommitment } from '../sdk/note-details-commitment';
import { monotonicNowMs } from '../sync-backoff';

export interface RecoverySdkReader {
  settings: Pick<MidenClient['settings'], 'get' | 'set'>;
  accounts: Pick<MidenClient['accounts'], 'get'>;
  notes: Pick<MidenClient['notes'], 'list'> & Partial<Pick<MidenClient['notes'], 'listPage'>>;
  storeIdentifier: MidenClient['storeIdentifier'];
}

function refuseNoteCapacity(): never {
  throw new Error('Recovery journal note capacity exceeded');
}

export const SDK_GENERATION_KEY = 'bread.store-generation.v1';
export interface SdkRecoverySnapshot {
  generation: string | null;
  accounts: RecoveryAccountExpectation[];
  notes: RecoveryNoteEntry[];
  canonicalNotes?: CanonicalNoteReadback[];
}

export function assertRetainedInputRecord(
  record: InputNoteRecord,
  detailsCommitment: string,
  requireAuthentication: boolean
): void {
  if (
    noteDetailsCommitment(record.details()) !== detailsCommitment ||
    record.state() === InputNoteState.Invalid ||
    (requireAuthentication && !record.isAuthenticated())
  )
    throw new StorageContinuityError();
}

export async function readSdkGeneration(client: RecoverySdkReader): Promise<string | null> {
  const value = await client.settings.get<unknown>(SDK_GENERATION_KEY);
  if (value === null) return null;
  if (!(Array.isArray(value) || value instanceof Uint8Array) || value.length < 1 || value.length > 512)
    throw new StorageContinuityError();
  if (!value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new StorageContinuityError();
  let generation: string;
  try {
    generation = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(value));
  } catch {
    throw new StorageContinuityError();
  }
  if (generation.length < 1 || generation.length > 128) throw new StorageContinuityError();
  return generation;
}

export async function initializeSdkGeneration(
  client: RecoverySdkReader,
  generation: string,
  previousGeneration: string | null,
  assertCurrent: () => void
): Promise<void> {
  await withRecoveryStorageLock(async () => {
    assertCurrent();
    if (generation.length < 1 || generation.length > 128) throw new StorageContinuityError();
    const encoded = new TextEncoder().encode(generation);
    if (new TextDecoder('utf-8', { fatal: true }).decode(encoded) !== generation) throw new StorageContinuityError();
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

async function readNoteBaseline(
  client: RecoverySdkReader,
  generation: string | null,
  assertCurrent: () => void
): Promise<RecoveryNoteEntry[]> {
  if (!client.notes.listPage) throw new Error('Recovery baseline paging is unsupported');
  const checkGeneration = async () => {
    assertCurrent();
    const current = await readSdkGeneration(client);
    assertCurrent();
    if (current !== generation) throw new Error('Recovery baseline generation changed');
  };
  const notes: RecoveryNoteEntry[] = [];
  let bytes = 0;
  let cursor: string | undefined;
  for (let pages = 0; pages < 128; pages++) {
    assertCurrent();
    const page = await client.notes.listPage({
      states: ['expected', 'unverified', 'committed', 'processing'],
      limit: 128,
      ...(cursor === undefined ? {} : { afterDetailsCommitment: cursor })
    });
    try {
      assertCurrent();
      await checkGeneration();
      if (
        page.notes.length > 128 ||
        (page.nextCursor !== null &&
          (!/^0x[0-9a-f]{64}$/.test(page.nextCursor) ||
            (cursor !== undefined &&
              page.nextCursor <= cursor &&
              !(page.exhausted && page.notes.length === 0 && page.nextCursor === cursor)))) ||
        (page.nextCursor === null && (cursor !== undefined || !page.exhausted || page.notes.length > 0))
      )
        throw new Error('Recovery baseline cursor did not advance');
      for (const record of page.notes) {
        assertCurrent();
        const metadata = record.metadata();
        try {
          if (metadata?.noteType() === NoteType.Public) continue;
        } finally {
          metadata?.free();
        }
        const details = record.details();
        const identifier = record.id();
        try {
          const id = identifier?.toString() ?? noteDetailsCommitment(details);
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
            notes.push({ kind: 'note', id, noteFile: noteFile.slice(), provenance: 'input', format });
          } finally {
            file.free();
          }
        } finally {
          identifier?.free();
          details.free();
        }
      }
      assertCurrent();
      if (page.exhausted) return notes;
      cursor = page.nextCursor ?? undefined;
    } finally {
      for (const record of page.notes) record.free();
    }
  }
  throw new Error('Recovery baseline page limit exceeded');
}

export async function readSdkRecoverySnapshot(
  client: RecoverySdkReader,
  accountIds: string[],
  includeNotes: boolean,
  assertCurrent: () => void,
  retainedNotes: RecoveryNoteEntry[] = [],
  canonicalNoteFamilies: RecoveryNoteEntry[] = []
): Promise<SdkRecoverySnapshot> {
  const deadline = includeNotes ? monotonicNowMs() + 5000 : undefined;
  const check = () => {
    assertCurrent();
    if (deadline !== undefined && monotonicNowMs() >= deadline) throw new Error('Recovery baseline deadline exceeded');
  };
  assertCanonicalNoteRequest(canonicalNoteFamilies);
  if (
    accountIds.length === 0 ||
    accountIds.length > 256 ||
    accountIds.some(id => typeof id !== 'string' || id.length > 2048)
  )
    throw new StorageContinuityError();
  const generation = await readSdkGeneration(client);
  check();
  const accounts: RecoveryAccountExpectation[] = [];
  for (const accountId of accountIds) {
    const account = await client.accounts.get(accountId);
    check();
    if (!account) throw new StorageContinuityError();
    const commitment = account.to_commitment();
    accounts.push({ accountId, nonce: account.nonce().asInt().toString(), commitment: commitment.toHex() });
    commitment.free();
  }
  const notes = includeNotes ? await readNoteBaseline(client, generation, check) : [];
  if (retainedNotes.length > JOURNAL_MAX_ENTRIES) throw new StorageContinuityError();
  for (const retained of retainedNotes) {
    if (retained.provenance !== 'input') continue;
    check();
    const file = NoteFile.deserialize(retained.noteFile);
    try {
      const full = file.note();
      const details = file.noteDetails() ?? full;
      if (!details) throw new StorageContinuityError();
      const commitment = noteDetailsCommitment(details);
      const id = file.noteId()?.toString();
      if (id) {
        const records = await client.notes.list({ ids: [id] });
        check();
        if (records.length !== 1) throw new StorageContinuityError();
        assertRetainedInputRecord(records[0]!, commitment, full !== undefined);
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
  check();
  if (includeNotes) {
    const current = await readSdkGeneration(client);
    check();
    if (current !== generation) throw new Error('Recovery baseline generation changed');
  }
  if (canonicalNoteFamilies.length > 0) {
    const canonicalNotes = await readCanonicalNoteFamilies(client, canonicalNoteFamilies, check);
    check();
    if ((await readSdkGeneration(client)) !== generation) throw new StorageContinuityError();
    check();
    return { generation, accounts, notes, canonicalNotes };
  }
  return { generation, accounts, notes };
}

export function decodeSdkRecoverySnapshot(
  value: unknown,
  canonicalFamilies: readonly RecoveryNoteEntry[] = []
): SdkRecoverySnapshot {
  assertSdkRecoverySnapshotWire(value);
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
  const canonicalWire: unknown = Reflect.get(value, 'canonicalNotes');
  if (canonicalWire === undefined) return { generation, accounts: decoded.accounts, notes };
  const canonicalDecoded: unknown = fromSerializable(canonicalWire);
  if (!Array.isArray(canonicalDecoded) || canonicalDecoded.length > canonicalFamilies.length)
    throw new StorageContinuityError();
  const canonicalNotes: CanonicalNoteReadback[] = [];
  const seen = new Set<string>();
  for (const canonical of canonicalDecoded) {
    if (typeof canonical !== 'object' || canonical === null) throw new StorageContinuityError();
    const familyId: unknown = Reflect.get(canonical, 'familyId');
    const id: unknown = Reflect.get(canonical, 'id');
    const detailsId: unknown = Reflect.get(canonical, 'detailsId');
    const noteFile: unknown = Reflect.get(canonical, 'noteFile');
    if (
      typeof familyId !== 'string' ||
      typeof id !== 'string' ||
      typeof detailsId !== 'string' ||
      !(noteFile instanceof Uint8Array) ||
      seen.has(familyId)
    )
      throw new StorageContinuityError();
    const family = canonicalFamilies.find(note => note.id === familyId);
    if (!family || family.provenance !== 'input' || (family.detailsId !== undefined && family.detailsId !== detailsId))
      throw new StorageContinuityError();
    seen.add(familyId);
    canonicalNotes.push({ familyId, id, detailsId, noteFile });
  }
  return { generation, accounts: decoded.accounts, notes, canonicalNotes };
}

export function decodeCanonicalNoteFamilies(value: unknown): RecoveryNoteEntry[] {
  assertCanonicalNotesWire(value);
  return decodeRetainedRecoveryNotes(value);
}

export function decodeRetainedRecoveryNotes(value: unknown): RecoveryNoteEntry[] {
  assertRetainedNotesWire(value);
  if (value === undefined) return [];
  const decoded: unknown = fromSerializable(value);
  if (!Array.isArray(decoded) || decoded.length > JOURNAL_MAX_ENTRIES || !decoded.every(isRecoveryNote))
    throw new StorageContinuityError();
  const usage = recoveryNoteUsage(decoded);
  if (usage.count > JOURNAL_MAX_ENTRIES || usage.bytes > JOURNAL_MAX_BYTES) throw new StorageContinuityError();
  return decoded;
}
