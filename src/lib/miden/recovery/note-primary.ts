import type { CanonicalNoteReadback } from './canonical-note-readback';
import { JOURNAL_MAX_BYTES } from './journal';
import { recoveryNoteMaterials, recoveryNoteUsage } from './note-candidates';
import type { RecoveryEntry, RecoveryJournalSnapshot, RecoveryNoteCandidate } from './types';
import { validateJournal } from './validation';
import { normalizedCommitment } from '../sdk/note-details-commitment';

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

/** Uses the captured authenticated SDK readback; acquisition bytes alone cannot authorize primary replacement. */
export function promoteRecoveryNotePrimaries(
  snapshot: RecoveryJournalSnapshot,
  canonicalNotes: readonly CanonicalNoteReadback[]
): RecoveryEntry[] {
  if (canonicalNotes.length > 4 || new Set(canonicalNotes.map(note => note.familyId)).size !== canonicalNotes.length)
    throw new Error('Invalid canonical recovery notes');
  const entries = [...snapshot.entries];
  let changed = false;
  for (const canonical of canonicalNotes) {
    const index = entries.findIndex(entry => entry.kind === 'note' && entry.id === canonical.familyId);
    const primary = entries[index];
    if (
      primary?.kind !== 'note' ||
      primary.provenance !== 'input' ||
      !/^[a-f0-9]{64}$/.test(canonical.id) ||
      !/^[a-f0-9]{64}$/.test(canonical.detailsId) ||
      !(canonical.noteFile instanceof Uint8Array) ||
      canonical.noteFile.length === 0 ||
      (primary.detailsId !== undefined && primary.detailsId !== canonical.detailsId)
    )
      throw new Error('Canonical recovery note binding changed');
    const matches = (material: RecoveryNoteCandidate) =>
      material.provenance === 'input' &&
      material.accountId === primary.accountId &&
      normalizedCommitment(material.id) === canonical.id &&
      (material.detailsId === undefined || material.detailsId === canonical.detailsId) &&
      sameBytes(material.noteFile, canonical.noteFile);
    if (matches(primary)) continue;
    const materials = recoveryNoteMaterials(primary);
    const canonicalIndex = materials.findIndex(matches);
    const retained = materials.filter((_, materialIndex) => materialIndex !== canonicalIndex);
    entries[index] = {
      ...primary,
      id: materials[canonicalIndex]?.id ?? canonical.id,
      detailsId: canonical.detailsId,
      noteFile: canonical.noteFile.slice(),
      format: 'full',
      candidates: retained
    };
    changed = true;
  }
  if (!changed) return snapshot.entries;
  validateJournal({ ...snapshot, entries });
  const notes = entries.flatMap(entry => (entry.kind === 'note' ? [entry] : []));
  if (recoveryNoteUsage(notes).bytes > JOURNAL_MAX_BYTES) throw new Error('Recovery journal capacity exceeded');
  return entries;
}
