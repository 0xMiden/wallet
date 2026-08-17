/**
 * Incoming-note import dead-letter store.
 *
 * When the background import loop (`activity/notes.ts`) finally gives up on a
 * queued incoming note — a transient outage that outlasted the wall-clock retry
 * budget, or a note that can't be deserialized — the note is moved HERE instead
 * of being silently `logger.error`-dropped. That matters because a private
 * note's bytes can be the only copy of the funds it carries: a silent drop is
 * unrecoverable fund loss.
 *
 * A dead-lettered note is durable (survives SW restarts) and retrievable: the
 * UI can list these, show a "couldn't import an incoming note" signal, and offer
 * a one-tap retry that re-enqueues the bytes onto the import queue. This module
 * is pure storage — it deliberately does NOT import `activity/notes.ts` (the
 * retry re-enqueue is done by the caller via `queueNoteImport`) so there's no
 * import cycle.
 *
 * Every export is defensive: a dead-letter read/write failure must never break
 * the import loop or sync, so all storage access is wrapped in try/catch with
 * safe fallbacks (mirrors `note-quarantine.ts`).
 */

import { logger } from 'shared/logger';

import { fetchFromStorage, putToStorage } from './front';

const DEADLETTER_KEY = 'miden-note-import-deadletter';

// Cap so a pathological run (an endpoint that deserializes every note as poison)
// can't grow storage unboundedly. Oldest entries are evicted first; the store is
// a diagnostics + manual-recovery aid, not an unbounded archive.
const MAX_DEADLETTERED = 200;

export type NoteDeadletterReason = 'transport' | 'malformed';

export interface DeadletteredNote {
  /** Base64 note bytes — the same form the import queue holds. */
  bytes: string;
  /** Why we gave up: `transport` = sustained outage; `malformed` = unparseable. */
  reason: NoteDeadletterReason;
  /** ms epoch when the note was dead-lettered. */
  failedAt: number;
  /** How many import attempts were made before giving up. */
  attempts: number;
}

async function readAll(): Promise<DeadletteredNote[]> {
  try {
    return (await fetchFromStorage<DeadletteredNote[]>(DEADLETTER_KEY)) ?? [];
  } catch (e) {
    logger.warning('[note-deadletter] read failed', e);
    return [];
  }
}

async function writeAll(entries: DeadletteredNote[]): Promise<void> {
  try {
    await putToStorage(DEADLETTER_KEY, entries.slice(-MAX_DEADLETTERED));
  } catch (e) {
    logger.warning('[note-deadletter] write failed', e);
  }
}

/**
 * Move a note to the dead-letter store. Deduped by `bytes` (a re-give-up on the
 * same note refreshes its record rather than duplicating it).
 */
export async function addToNoteDeadletter(entry: DeadletteredNote): Promise<void> {
  const existing = await readAll();
  const deduped = existing.filter(n => n.bytes !== entry.bytes);
  deduped.push(entry);
  await writeAll(deduped);
  logger.error(
    `[note-deadletter] gave up importing an incoming note (${entry.reason}, ${entry.attempts} attempts, ${entry.bytes.length} b64 chars) — moved to dead-letter for retry`
  );
}

/** List all dead-lettered notes (newest last). */
export async function listDeadletteredNotes(): Promise<DeadletteredNote[]> {
  return readAll();
}

/** True if any note is currently dead-lettered — drives a user-facing signal. */
export async function hasDeadletteredNotes(): Promise<boolean> {
  return (await readAll()).length > 0;
}

/** Remove a single note (by bytes) — used after a successful manual retry. */
export async function removeFromNoteDeadletter(bytes: string): Promise<void> {
  const existing = await readAll();
  const next = existing.filter(n => n.bytes !== bytes);
  if (next.length !== existing.length) await writeAll(next);
}

/** Clear the whole dead-letter store. */
export async function clearNoteDeadletter(): Promise<void> {
  await writeAll([]);
}
