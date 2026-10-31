import { InputNoteState, NoteFile, type InputNoteRecord } from '@miden-sdk/miden-sdk/lazy';

import { JOURNAL_MAX_BYTES, JOURNAL_MAX_ENTRIES } from './journal';
import type { RecoverySdkReader } from './sdk-snapshot';
import type { RecoveryNoteEntry } from './types';
import { isRecoveryNote } from './validation';
import { normalizedCommitment, noteDetailsCommitment } from '../sdk/note-details-commitment';

export interface CanonicalNoteReadback {
  familyId: string;
  id: string;
  detailsId: string;
  noteFile: Uint8Array;
}

interface NoteIdentity {
  detailsId: string;
  id?: string;
  nullifier?: string;
  block?: number;
}

function commitment(value: string | undefined): string | undefined {
  const normalized = value === undefined ? undefined : normalizedCommitment(value);
  return normalized !== undefined && /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export function assertCanonicalNoteRequest(families: readonly RecoveryNoteEntry[]): void {
  let count = 0;
  let bytes = 0;
  if (families.length > 4) throw new Error('Recovery canonical note request exceeds limits');
  for (const family of families) {
    count += 1 + (family.candidates?.length ?? 0);
    if (count > JOURNAL_MAX_ENTRIES) throw new Error('Recovery canonical note request exceeds limits');
    for (const material of [family, ...(family.candidates ?? [])]) {
      bytes += material.noteFile.byteLength;
      if (bytes > JOURNAL_MAX_BYTES) throw new Error('Recovery canonical note request exceeds limits');
    }
    if (!isRecoveryNote(family)) throw new Error('Invalid recovery canonical note request');
  }
}

function fileIdentity(file: NoteFile): NoteIdentity | undefined {
  const full = file.note();
  const details = file.noteDetails();
  const id = file.noteId();
  const proof = file.inclusionProof();
  const location = proof?.location();
  try {
    const body = full ?? details;
    if (!body) return undefined;
    const detailsId = commitment(noteDetailsCommitment(body));
    if (!detailsId) return undefined;
    if (!full) return { detailsId };
    const noteId = commitment(id?.toString());
    const nullifier = commitment(file.nullifier());
    const block = location?.blockNum();
    if (!noteId || !nullifier || block === undefined || !Number.isSafeInteger(block) || block < 0 || block > 0xffffffff)
      return undefined;
    return { detailsId, id: noteId, nullifier, block };
  } finally {
    location?.free();
    proof?.free();
    id?.free();
    details?.free();
    full?.free();
  }
}

function primaryIdentity(family: RecoveryNoteEntry): NoteIdentity | undefined {
  if (family.provenance !== 'input') return undefined;
  const file = NoteFile.deserialize(family.noteFile);
  try {
    const identity = fileIdentity(file);
    if (
      !identity ||
      (family.detailsId !== undefined && commitment(family.detailsId) !== identity.detailsId) ||
      commitment(family.id) !== (identity.id ?? identity.detailsId)
    )
      return undefined;
    return identity;
  } finally {
    file.free();
  }
}

function exportAuthenticatedRecord(
  record: InputNoteRecord,
  primary: NoteIdentity,
  maxBytes: number
): Uint8Array | undefined {
  const state = record.state();
  if (
    !record.isAuthenticated() ||
    (state !== InputNoteState.Committed &&
      state !== InputNoteState.ProcessingAuthenticated &&
      state !== InputNoteState.ConsumedAuthenticatedLocal)
  )
    return undefined;
  const id = record.id();
  const proof = record.inclusionProof();
  const location = proof?.location();
  try {
    const noteId = commitment(id?.toString());
    const nullifier = commitment(record.nullifier());
    const block = location?.blockNum();
    if (
      !noteId ||
      !nullifier ||
      block === undefined ||
      !Number.isSafeInteger(block) ||
      block < 0 ||
      block > 0xffffffff ||
      (primary.id !== undefined && primary.id !== noteId) ||
      (primary.nullifier !== undefined && primary.nullifier !== nullifier)
    )
      return undefined;
    const file = NoteFile.fromInputNote(record.toInputNote());
    try {
      const exported = fileIdentity(file);
      if (
        !exported ||
        exported.detailsId !== primary.detailsId ||
        exported.id !== noteId ||
        exported.nullifier !== nullifier ||
        exported.block !== block
      )
        return undefined;
      const bytes = file.serialize();
      return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes.slice() : undefined;
    } finally {
      file.free();
    }
  } finally {
    location?.free();
    proof?.free();
    id?.free();
  }
}

export async function readCanonicalNoteFamilies(
  client: RecoverySdkReader,
  families: readonly RecoveryNoteEntry[],
  assertCurrent: () => void
): Promise<CanonicalNoteReadback[]> {
  assertCanonicalNoteRequest(families);
  const requested = new Map<RecoveryNoteEntry, NoteIdentity>();
  for (const family of families) {
    assertCurrent();
    try {
      const identity = primaryIdentity(family);
      if (identity) requested.set(family, identity);
    } catch {
      // Untrusted primary bytes do not establish canonical identity.
    }
  }
  const detailsCommitments = [...new Set([...requested.values()].map(identity => identity.detailsId))];
  if (detailsCommitments.length === 0) return [];
  assertCurrent();
  const records = await client.notes.list({ detailsCommitments: detailsCommitments.map(value => `0x${value}`) });
  try {
    assertCurrent();
    if (records.length > detailsCommitments.length) return [];
    const byDetails = new Map<string, InputNoteRecord>();
    for (const record of records) {
      const details = record.details();
      try {
        const identity = commitment(noteDetailsCommitment(details));
        if (!identity || !detailsCommitments.includes(identity) || byDetails.has(identity)) return [];
        byDetails.set(identity, record);
      } finally {
        details.free();
      }
    }
    const resolved: CanonicalNoteReadback[] = [];
    let bytes = 0;
    for (const [family, primary] of requested) {
      assertCurrent();
      const record = byDetails.get(primary.detailsId);
      if (!record) continue;
      try {
        const noteFile = exportAuthenticatedRecord(record, primary, JOURNAL_MAX_BYTES - bytes);
        if (!noteFile) continue;
        const id = record.id();
        try {
          const canonicalId = commitment(id?.toString());
          if (!canonicalId) continue;
          bytes += noteFile.byteLength;
          resolved.push({ familyId: family.id, id: canonicalId, detailsId: primary.detailsId, noteFile });
        } finally {
          id?.free();
        }
      } catch {
        // A conversion refusal leaves this family unresolved and its retained bytes untouched.
      }
    }
    assertCurrent();
    return resolved;
  } finally {
    for (const record of records) record.free();
  }
}
