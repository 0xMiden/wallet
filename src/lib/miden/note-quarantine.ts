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
 * Lifecycle: the dry-run QUARANTINES the ids it actually INTRODUCED; CONFIRM
 * RELEASES them (the transaction will consume them; if it fails to submit
 * they simply reappear as claimable, which is correct); CANCEL/decline
 * releases nothing, so notes the dry-run introduced stay hidden.
 *
 * TWO bounds make "stay hidden" safe, because the ids come from
 * dApp-controlled bytes and this wallet is the user's only view of their own
 * notes:
 *
 *  1. PROVENANCE. `simulate-custom-tx.ts` quarantines only the ids the client
 *     did NOT already hold before the dry-run imported them. A note the user
 *     already owned (one the dApp delivered earlier, or any public note the
 *     wallet had already discovered) is therefore never hidden by a dApp
 *     opening — and the user declining — a confirm dialog.
 *  2. TTL. Every entry carries the wall-clock time it was quarantined and is
 *     ignored once it is older than `QUARANTINE_TTL_MS`. Quarantine is a
 *     short-lived "don't surprise the user with a note their cancelled dry-run
 *     imported" measure, NOT a permanent censor: the note is on chain and is
 *     the user's, so a declined simulation must not be able to hide it from
 *     the claimable UI forever.
 *
 * Storage: a deduped array (insertion order) of `{ id, at }` entries under a
 * single shared chrome.storage key, capped to the most recent
 * `MAX_QUARANTINED` ids so a user who repeatedly opens-and-declines dApp
 * transactions can't grow this unboundedly. Entries persisted by an earlier
 * build were bare id strings with no timestamp; those are dropped on read
 * (see `parseEntries`) — un-hiding a note is the safe direction, and the ids
 * are re-quarantined by any dry-run that imports them again. Every export here
 * is defensive — a quarantine read/write failure must never break sync or
 * simulation, so all storage access is wrapped in try/catch with safe
 * fallbacks.
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
 * How long a quarantined id stays hidden. Past this, the entry is ignored (and
 * pruned by the next write). Bounds the blast radius of a hide that is never
 * explicitly released: the notes are the user's own on-chain funds, so "hidden
 * until the user resets the wallet" is not an acceptable terminal state.
 * Matches the bridge-in registry's 7-day cutoff.
 */
const QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A quarantined note id plus the wall-clock ms at which it was quarantined. */
interface QuarantineEntry {
  id: string;
  at: number;
}

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

/**
 * Accepts only well-formed `{ id, at }` entries. Anything else — most notably
 * the bare-id-string entries written by builds before the TTL existed — is
 * dropped, so a legacy id stops hiding its note instead of hiding it forever
 * with no recorded age.
 */
function parseEntries(raw: unknown): QuarantineEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, at } = entry as Partial<QuarantineEntry>;
    return typeof id === 'string' && typeof at === 'number' ? [{ id, at }] : [];
  });
}

/** Entries that are still within the TTL, oldest first. */
async function readLiveEntries(): Promise<QuarantineEntry[]> {
  const cutoff = Date.now() - QUARANTINE_TTL_MS;
  return parseEntries(await fetchFromStorage<unknown>(QUARANTINE_KEY)).filter(entry => entry.at > cutoff);
}

/** Adds `ids` to the quarantine set (deduped, capped to the last MAX_QUARANTINED). Never throws. */
export async function quarantineNoteIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const existing = await readLiveEntries();
    const now = Date.now();
    const merged = [...existing.filter(entry => !ids.includes(entry.id)), ...ids.map(id => ({ id, at: now }))];
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
    const existing = await readLiveEntries();
    const remaining = existing.filter(entry => !ids.includes(entry.id));
    await putToStorage(QUARANTINE_KEY, remaining);
  } catch {
    // Quarantine failures must never break confirm.
  }
}

/** Reads the currently-hidden ids as a Set (empty on missing/error). Never throws. */
export async function getQuarantinedNoteIds(): Promise<Set<string>> {
  try {
    return new Set((await readLiveEntries()).map(entry => entry.id));
  } catch {
    return new Set();
  }
}
