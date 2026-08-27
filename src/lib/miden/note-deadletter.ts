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
 * safe fallbacks (mirrors `note-quarantine.ts`). Defensive is not the same as
 * silent, though — `addToNoteDeadletter` REPORTS whether the note landed, because
 * its caller drops the bytes from the import queue on the strength of that answer.
 * A read failure, a write failure and a full store are all refusals, not successes.
 */

import { logger } from 'shared/logger';

import { fetchFromStorage, putToStorage } from './front';

const DEADLETTER_KEY = 'miden-note-import-deadletter';

// Cap so a pathological run (an endpoint that deserializes every note as poison)
// can't grow storage unboundedly. At the cap the ADD is refused — the oldest
// entries are NOT evicted, because their bytes may be the only copy of the funds
// they carry, and the import queue stops carrying a note on the strength of this
// store accepting it. A refusal keeps the new note on the queue instead, which is
// bounded growth of a live queue rather than a silent loss.
const MAX_DEADLETTERED = 200;

export type NoteDeadletterReason = 'transport' | 'malformed' | 'rejected';

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

/**
 * Serializes every read-modify-write of this key.
 *
 * `addToNoteDeadletter` is a read → filter → write, and two of them can overlap:
 * an import pass evicted by the WASM-lock watchdog is ABANDONED, not cancelled, so
 * its callback keeps running and can give up on a note while its successor gives
 * up on a different one. Unserialized, both read the same snapshot and the second
 * write erases the first note's record — after the import queue has already
 * stopped carrying it, on the strength of a `true` return. Both notes were then
 * gone from both stores.
 *
 * Same shape and same reason as `withQueueLock` in `activity/notes.ts`, and the
 * same bound: it serializes one realm. Cross-realm writes to this key would need
 * a Web Lock, which is the import queue's open limitation too.
 */
let writeTail: Promise<unknown> = Promise.resolve();
const withDeadletterLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = writeTail.then(fn, fn);
  writeTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

/**
 * `null` when the read itself failed, which is NOT the same as an empty store.
 * Conflating them let a transient read failure turn the following write into a
 * store-wide erase: every previously dead-lettered note replaced by the one being
 * added, and none of them still on the import queue to re-derive from.
 */
/** A stored member this module can actually work with: it has bytes to preserve. */
const isRecord = (value: unknown): value is DeadletteredNote =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { bytes?: unknown }).bytes === 'string' &&
  (value as { bytes: string }).bytes.length > 0;

async function readAllOrFail(): Promise<DeadletteredNote[] | null> {
  try {
    const stored = await fetchFromStorage<DeadletteredNote[]>(DEADLETTER_KEY);
    if (stored === undefined || stored === null) return [];
    // A present-but-unusable value counts as a FAILED read, not an empty store.
    // The desktop and Capacitor adapters hand back the raw string when the stored
    // JSON does not parse, and `addToNoteDeadletter` went straight into
    // `existing.filter(...)` on it — a `TypeError` thrown out of the give-up path,
    // past a caller with no try around it, so the import pass rejected on every
    // lap and no note could ever be dead-lettered again. Refusing is also why this
    // is not "reset to empty": the value may be a truncated write over records
    // whose bytes are the only copy of the funds they carry.
    // A LONE RECORD that lost its array wrapper is salvaged, matching the import
    // queue's own `salvageEntries` — the same adapter fault produced it, and its
    // bytes may be the only copy of the funds they carry, so the two sides of the
    // give-up must not disagree about whether it is recoverable.
    if (!Array.isArray(stored)) {
      const salvaged = isRecord(stored) ? [stored] : null;
      if (!salvaged) {
        logger.error('[note-deadletter] stored value is not an array; treating it as an unreadable store');
        return null;
      }
      logger.warning('[note-deadletter] salvaged a lone record that lost its array wrapper');
      return salvaged;
    }
    // An ARRAY is not enough: `JSON.parse('[null]')` passes the check above and
    // then `existing.filter(n => n.bytes !== ...)` throws on the member — out of
    // the give-up path, whose caller has no try, so the import pass rejected on
    // every lap and the poison cap could never stick. Members are dropped rather
    // than refused: a member with no `bytes` carries nothing to preserve.
    const usable = stored.filter(isRecord);
    if (usable.length !== stored.length) {
      logger.error(`[note-deadletter] dropped ${stored.length - usable.length} unusable record(s) from the store`);
    }
    return usable;
  } catch (e) {
    logger.warning('[note-deadletter] read failed', e);
    return null;
  }
}

async function readAll(): Promise<DeadletteredNote[]> {
  return (await readAllOrFail()) ?? [];
}

/**
 * Whether the write landed. A caller that is about to DROP the note it just
 * dead-lettered has to know: swallowing the failure and reporting success meant a
 * full storage quota took the note out of both stores at once.
 *
 * Writes exactly what it is given. It deliberately does NOT trim to
 * `MAX_DEADLETTERED` — a silent `slice` here evicted the oldest record's bytes,
 * which may be the only copy of the funds it carries, while still reporting
 * success to a caller that then stopped carrying a DIFFERENT note. Capacity is
 * enforced by refusing the add instead (see `addToNoteDeadletter`).
 */
async function writeAll(entries: DeadletteredNote[]): Promise<boolean> {
  try {
    await putToStorage(DEADLETTER_KEY, entries);
    return true;
  } catch (e) {
    logger.warning('[note-deadletter] write failed', e);
    return false;
  }
}

/**
 * Move a note to the dead-letter store. Deduped by `bytes` (a re-give-up on the
 * same note refreshes its record rather than duplicating it).
 *
 * Returns whether the note is now safely stored HERE, which the import queue uses
 * to decide whether it may stop carrying those bytes. A private note's bytes can
 * be its only copy, so "dead-lettered" has to mean persisted, not attempted — and
 * every `false` path below is one where it isn't.
 */
export async function addToNoteDeadletter(entry: DeadletteredNote): Promise<boolean> {
  return withDeadletterLock(async () => {
    const existing = await readAllOrFail();
    if (existing === null) {
      logger.error('[note-deadletter] could not read the store; the import queue keeps carrying the note');
      return false;
    }
    const deduped = existing.filter(n => n.bytes !== entry.bytes);
    // Full: refuse rather than evict. The cap exists to bound storage against a
    // pathological run, and dropping the oldest record honours it by destroying
    // note bytes — the one thing this store exists to prevent. Refusing keeps the
    // new note on the import queue, where it is still carried and still retried;
    // `hasDeadletteredNotes()` is already true, so the user-facing signal is up
    // and a manual retry can drain the store and make room.
    if (deduped.length >= MAX_DEADLETTERED) {
      logger.error(
        `[note-deadletter] store is full (${MAX_DEADLETTERED}); refusing to evict an older note's only copy — the import queue keeps carrying this one`
      );
      return false;
    }
    deduped.push(entry);
    const stored = await writeAll(deduped);
    if (!stored) {
      logger.error(
        '[note-deadletter] could not persist a note we gave up importing; the import queue keeps carrying it'
      );
      return false;
    }
    logger.error(
      `[note-deadletter] gave up importing an incoming note (${entry.reason}, ${entry.attempts} attempts, ${entry.bytes.length} b64 chars) — moved to dead-letter for retry`
    );
    return true;
  });
}

/** List all dead-lettered notes (newest last). */
export async function listDeadletteredNotes(): Promise<DeadletteredNote[]> {
  return readAll();
}

/** True if any note is currently dead-lettered — drives a user-facing signal. */
export async function hasDeadletteredNotes(): Promise<boolean> {
  return (await readAll()).length > 0;
}

/**
 * Remove one dead-lettered note — used after a successful manual retry.
 *
 * Under the same lock as the add: this is a read-modify-write too, and racing one
 * against an add resurrects the removed note or erases the added one.
 *
 * Takes the RECORD the caller listed, not just its bytes, and removes only while
 * the stored record is still that one. `addToNoteDeadletter` dedupes by bytes, so
 * a fresh give-up on the same note REPLACES the record rather than adding a
 * second — which means bytes alone cannot tell "the record I drained" from "a
 * record a later import pass has since re-created". Removing by bytes deleted the
 * newer one, and since that pass also still holds those bytes on the import queue
 * and drops them at commit, the note went from both stores at once. That is the
 * give-up invariant broken in the same shape it was broken before, one pass
 * later, and for a private note it is unrecoverable fund loss. `failedAt` is the
 * generation marker: every add stamps a fresh one.
 *
 * Returns whether the store is now provably free of THAT record, the mirror of
 * `addToNoteDeadletter`'s contract. The drain counts drained notes from this, so
 * a swallowed read/write failure reported as success left the notice claiming a
 * smaller store than it has and the user with no way to tell the retry did not
 * land. A record that was already absent counts as removed — that is the same
 * postcondition, reached earlier. A record REPLACED by a newer give-up does not:
 * the note is dead-lettered again, the notice should keep saying so, and the new
 * record's own bytes have not been drained.
 */
export async function removeFromNoteDeadletter(entry: DeadletteredNote): Promise<boolean> {
  return withDeadletterLock(async () => {
    const existing = await readAllOrFail();
    if (existing === null) {
      logger.error('[note-deadletter] could not read the store; the note stays dead-lettered');
      return false;
    }
    const stored = existing.find(n => n.bytes === entry.bytes);
    if (stored === undefined) return true;
    if (stored.failedAt !== entry.failedAt) {
      logger.warning('[note-deadletter] the note was dead-lettered again since it was listed; leaving the new record');
      return false;
    }
    return writeAll(existing.filter(n => n !== stored));
  });
}

/** Clear the whole dead-letter store. */
export async function clearNoteDeadletter(): Promise<void> {
  await withDeadletterLock(() => writeAll([]));
}
