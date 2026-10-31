import type { RecoveryNoteCandidate, RecoveryNoteEntry } from './types';

function material(note: RecoveryNoteCandidate): RecoveryNoteCandidate {
  const { id, accountId, detailsId, noteFile, provenance, format } = note;
  return { id, accountId, detailsId, noteFile, provenance, format };
}

export function recoveryNoteMaterials(note: RecoveryNoteEntry): RecoveryNoteCandidate[] {
  return [material(note), ...(note.candidates ?? [])];
}

export function recoveryNoteUsage(notes: readonly RecoveryNoteEntry[]): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const note of notes) {
    for (const candidate of recoveryNoteMaterials(note)) {
      count++;
      bytes += candidate.noteFile.byteLength;
    }
  }
  return { count, bytes };
}

export function retainNoteCandidates(previous: RecoveryNoteEntry, incoming: RecoveryNoteEntry): RecoveryNoteEntry {
  const retained = recoveryNoteMaterials(previous);
  for (const candidate of recoveryNoteMaterials(incoming)) {
    if (
      retained.some(
        old =>
          old.provenance === candidate.provenance &&
          (candidate.accountId === undefined || old.accountId === candidate.accountId) &&
          old.noteFile.length === candidate.noteFile.length &&
          old.noteFile.every((byte, index) => byte === candidate.noteFile[index])
      )
    )
      continue;
    retained.push(candidate);
  }
  return retained.length === 1 ? previous : { ...previous, candidates: retained.slice(1) };
}
