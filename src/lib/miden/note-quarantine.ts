/**
 * Simulation note quarantine.
 *
 * The custom-tx confirm popup dry-runs the transaction BEFORE the user
 * approves it (`simulate-custom-tx.ts`), which imports the request's carried
 * notes into the real client DB so `executeForSummary` can resolve them.
 * That import has a side effect the user never asked for: the notes
 * immediately become visible in the claimable-notes UI (pending-notes list,
 * unclaimed badge, "Claim All") — even if the user goes on to CANCEL the
 * transaction. We cannot delete notes (web-sdk limitation), so instead we
 * track a "quarantine" set of note ids and filter them out of every
 * claimable-notes read path until the transaction is actually confirmed.
 *
 * Lifecycle: the dry-run QUARANTINES the imported notes' ids; CONFIRM
 * RELEASES them (the transaction will consume them; if it fails to submit
 * they simply reappear as claimable, which is correct); CANCEL/decline does
 * nothing, so the notes stay hidden.
 *
 * Storage: a deduped array (insertion order) under a single shared
 * chrome.storage key, capped to the most recent `MAX_QUARANTINED` ids so a
 * user who repeatedly opens-and-declines dApp transactions can't grow this
 * unboundedly. Every export here is defensive — a quarantine read/write
 * failure must never break sync or simulation, so all storage access is
 * wrapped in try/catch with safe fallbacks.
 */
import { Note, NoteFile } from '@miden-sdk/miden-sdk/lazy';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { b64ToU8 } from 'lib/shared/helpers';

/**
 * Derives a note id from imported note bytes, mirroring exactly how
 * `importNoteBytes` (`deserializeNoteFileOrNote`) parses them: the bytes may be
 * a serialized `NoteFile` OR a bare `Note` — two mutually incompatible formats,
 * and the dApp controls which it sends. Deriving the id from only one format
 * would let notes in the other format be imported but never quarantined (they'd
 * leak into the claimable UI). Tries NoteFile first (as the import does), then a
 * bare Note. Returns null if neither parses.
 */
function noteIdFromBytes(bytes: Uint8Array): string | null {
  try {
    const noteFile = NoteFile.deserialize(bytes);
    const id = noteFile.noteId() ?? noteFile.note()?.id();
    if (id) return id.toString();
  } catch {
    // Not a NoteFile — fall through to a bare Note.
  }
  try {
    return Note.deserialize(bytes).id().toString();
  } catch {
    return null;
  }
}

const QUARANTINE_KEY = 'simulation_quarantined_note_ids';
// Bounds growth: declined/abandoned simulations accumulate ids that are
// never released, so the set is capped to the most recently quarantined
// MAX_QUARANTINED ids rather than growing forever.
const MAX_QUARANTINED = 500;

/**
 * Derives the note ids for a custom-tx's `importNotes` (base64 note bytes),
 * deterministically — the SAME way `getConsumableNotes` derives ids for the
 * notes it returns. `importNoteBytes`'s return value is NOT reliably the
 * note id (for raw-note bytes it can be a details commitment instead), so we
 * must decode the note and read `.id()` ourselves. A note that fails to
 * deserialize is skipped rather than throwing, so one malformed entry can't
 * blow up quarantine/release for the rest of the batch.
 */
export function importedNoteIds(importNotes: string[] | undefined): string[] {
  return (importNotes ?? [])
    .map(b64 => {
      try {
        return noteIdFromBytes(b64ToU8(b64));
      } catch {
        return null;
      }
    })
    .filter((x): x is string => !!x);
}

async function readQuarantinedIds(): Promise<string[]> {
  return (await fetchFromStorage<string[]>(QUARANTINE_KEY)) ?? [];
}

/** Adds `ids` to the quarantine set (deduped, capped to the last MAX_QUARANTINED). Never throws. */
export async function quarantineNoteIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const existing = await readQuarantinedIds();
    const merged = [...existing.filter(id => !ids.includes(id)), ...ids];
    const capped = merged.slice(-MAX_QUARANTINED);
    await putToStorage(QUARANTINE_KEY, capped);
  } catch {
    // Quarantine failures must never break simulation.
  }
}

/** Removes `ids` from the quarantine set. Never throws. */
export async function releaseNoteIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const existing = await readQuarantinedIds();
    const remaining = existing.filter(id => !ids.includes(id));
    await putToStorage(QUARANTINE_KEY, remaining);
  } catch {
    // Quarantine failures must never break confirm.
  }
}

/** Reads the current quarantine set as a Set (empty on missing/error). Never throws. */
export async function getQuarantinedNoteIds(): Promise<Set<string>> {
  try {
    return new Set(await readQuarantinedIds());
  } catch {
    return new Set();
  }
}
