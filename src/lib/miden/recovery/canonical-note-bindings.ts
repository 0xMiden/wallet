import { NoteFile } from '@miden-sdk/miden-sdk/lazy';

import { assertCanonicalNoteRequest, type CanonicalNoteReadback } from './canonical-note-readback';
import { recoveryNoteMaterials } from './note-candidates';
import type { RecoveryNoteCandidate, RecoveryNoteEntry } from './types';
import { normalizedCommitment, noteDetailsCommitment } from '../sdk/note-details-commitment';

interface MaterialIdentity {
  detailsId: string;
  id?: string;
  nullifier?: string;
  fromBlock?: number;
}
interface BoundIdentity {
  nullifier: string;
  fromBlock: number;
}
interface CanonicalFamilyBinding {
  primary: RecoveryNoteCandidate;
  original: RecoveryNoteEntry;
  materials: { material: RecoveryNoteCandidate; identity?: BoundIdentity }[];
}

function sameMaterial(first: RecoveryNoteCandidate, second: RecoveryNoteCandidate): boolean {
  return (
    normalizedCommitment(first.id) === normalizedCommitment(second.id) &&
    first.accountId === second.accountId &&
    first.provenance === second.provenance &&
    (first.detailsId === undefined ||
      second.detailsId === undefined ||
      normalizedCommitment(first.detailsId) === normalizedCommitment(second.detailsId)) &&
    first.noteFile.length === second.noteFile.length &&
    first.noteFile.every((byte, index) => byte === second.noteFile[index])
  );
}

function materialIdentity(material: RecoveryNoteCandidate): MaterialIdentity | undefined {
  if (material.provenance !== 'input') return undefined;
  const file = NoteFile.deserialize(material.noteFile);
  try {
    const full = file.note();
    const details = file.noteDetails();
    const id = file.noteId();
    const proof = file.inclusionProof();
    const location = proof?.location();
    try {
      const body = full ?? details;
      if (!body) return undefined;
      const detailsId = normalizedCommitment(noteDetailsCommitment(body));
      const noteId = id ? normalizedCommitment(id.toString()) : undefined;
      if (
        !detailsId ||
        normalizedCommitment(material.id) !== (noteId ?? detailsId) ||
        (material.detailsId !== undefined && normalizedCommitment(material.detailsId) !== detailsId)
      )
        return undefined;
      if (!full && !noteId) return { detailsId };
      const nullifier = file.nullifier();
      const fromBlock = location?.blockNum();
      if (
        !full ||
        !noteId ||
        !nullifier ||
        fromBlock === undefined ||
        !Number.isSafeInteger(fromBlock) ||
        fromBlock < 0 ||
        fromBlock > 0xffffffff
      )
        return undefined;
      return { detailsId, id: noteId, nullifier: normalizedCommitment(nullifier), fromBlock };
    } finally {
      location?.free();
      proof?.free();
      id?.free();
      details?.free();
      full?.free();
    }
  } finally {
    file.free();
  }
}

/** The owned authenticated export binds deletion authority; staged bytes alone never do. */
export function bindCanonicalNoteFamilies(
  families: readonly RecoveryNoteEntry[],
  canonicalNotes: readonly CanonicalNoteReadback[]
): (note: RecoveryNoteEntry, family: RecoveryNoteEntry) => { identity?: BoundIdentity } | undefined {
  assertCanonicalNoteRequest(families);
  const bindings: CanonicalFamilyBinding[] = [];
  for (const canonical of canonicalNotes) {
    const original = families.find(family => family.id === canonical.familyId);
    if (!original) continue;
    const primary: RecoveryNoteCandidate = {
      id: canonical.id,
      detailsId: canonical.detailsId,
      accountId: original.accountId,
      noteFile: canonical.noteFile,
      provenance: 'input',
      format: 'full'
    };
    const materials: CanonicalFamilyBinding['materials'] = [...recoveryNoteMaterials(original), primary].map(
      material => ({ material })
    );
    bindings.push({ primary, original, materials });
    try {
      const target = materialIdentity(primary);
      const source = materialIdentity(original);
      if (
        !target?.id ||
        !target.nullifier ||
        target.fromBlock === undefined ||
        !source ||
        source.detailsId !== target.detailsId ||
        (source.id !== undefined && source.id !== target.id) ||
        (source.nullifier !== undefined && source.nullifier !== target.nullifier)
      )
        continue;
      for (const bound of materials) {
        try {
          const identity = materialIdentity(bound.material);
          if (
            identity?.detailsId === target.detailsId &&
            (identity.id === undefined || identity.id === target.id) &&
            (identity.nullifier === undefined || identity.nullifier === target.nullifier)
          )
            bound.identity = { nullifier: `0x${target.nullifier}`, fromBlock: target.fromBlock };
        } catch {
          // Unreadable candidates stay quarantined and prevent whole-family deletion.
        }
      }
    } catch {
      // A failed binding preserves the entire captured family.
    }
  }
  return (note, family) => {
    const binding = bindings.find(value => sameMaterial(family, value.primary) || sameMaterial(family, value.original));
    if (!binding) return undefined;
    return { identity: binding.materials.find(value => sameMaterial(note, value.material))?.identity };
  };
}
