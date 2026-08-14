import { logger } from 'shared/logger';

import { midenClientProxy } from '../back/miden-client-proxy';
import { fetchFromStorage, putToStorage } from '../front';
import { isLikelyNetworkError } from './connectivity-classify';
import { addToNoteDeadletter } from '../note-deadletter';
import { withWasmClientLock } from '../sdk/miden-client';

const IMPORT_NOTES_KEY = 'miden-notes-pending-import';

// How a queued note is given up on depends on WHY it fails (issue: resilience
// gap 1). The old design used a single iteration-count cap (3) for every
// failure, which meant a genuinely transient outage lasting a few loop ticks
// (seconds) silently dropped a recoverable note — a private note's bytes can be
// the only copy of its funds, so that's unrecoverable fund loss.
//
//   - TRANSIENT (network/RPC transport error): keep retrying on a WALL-CLOCK
//     budget with exponential backoff. A brief blip can never exhaust it; only a
//     sustained multi-hour outage does. On give-up the note is DEAD-LETTERED
//     (never silently dropped) so it stays recoverable and a signal can surface.
//   - POISON (non-transport error, e.g. NoteFile deserialization): will never
//     import. Retry a couple of times in case of misclassification, then
//     DEAD-LETTER it promptly — this preserves the anti-brick property (a poison
//     note must drain fast so it can't re-throw forever and jam the tx loop)
//     WITHOUT the old silent drop.
const TRANSIENT_RETRY_BUDGET_MS = 24 * 60 * 60 * 1000; // 24h wall-clock
const POISON_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

// Persisted queue entries. Legacy entries were bare base64 strings; they are
// normalized to the object form on read, so no migration step is needed.
// `firstFailureAt` anchors the transient wall-clock budget; `nextEligibleAt`
// implements per-note backoff (a note not yet eligible is skipped this pass).
type QueuedNoteImport = { bytes: string; attempts: number; firstFailureAt?: number; nextEligibleAt?: number };
type StoredEntry = string | QueuedNoteImport;

const normalizeEntry = (entry: StoredEntry): QueuedNoteImport =>
  typeof entry === 'string' ? { bytes: entry, attempts: 0 } : entry;

// Serializes every read-modify-write of IMPORT_NOTES_KEY so enqueues and the
// import-pass rewrite can't interleave. Without it, an enqueue landing between
// the rewrite's read and write is clobbered — losing a private note whose bytes
// are its only copy — or a processed note is re-added. The lock is intentionally
// scoped to just the storage read/slice/write, never the WASM import work or the
// syncState delay, so enqueues are never blocked for more than a storage round-trip.
let queueTail: Promise<unknown> = Promise.resolve();
const withQueueLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queueTail.then(fn, fn);
  queueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

export const queueNoteImport = async (noteBytes: string) =>
  withQueueLock(async () => {
    const queuedImports = (await fetchFromStorage<StoredEntry[]>(IMPORT_NOTES_KEY)) || [];
    await putToStorage(IMPORT_NOTES_KEY, [...queuedImports, noteBytes]);
  });

export const importAllNotes = async () => {
  const rawQueue = (await fetchFromStorage<StoredEntry[]>(IMPORT_NOTES_KEY)) || [];
  if (rawQueue.length === 0) {
    return;
  }
  const snapshot = rawQueue.map(normalizeEntry);

  // Wrap all WASM client operations in a lock to prevent concurrent access.
  // Both the import and the trailing sync route through `midenClientProxy` (issue
  // #260, slice 7a) so flag-ON they hit the OFFSCREEN client's store — the realm
  // that syncs + consumes, so an imported (possibly private) note isn't stranded in
  // the dormant SW store. Flag-OFF is byte-identical to the inline calls under this
  // lock.
  await withWasmClientLock(async () => {
    const now = Date.now();
    const retry: QueuedNoteImport[] = [];
    for (const note of snapshot) {
      // Respect per-note backoff: a note not yet eligible is carried to a later
      // pass untouched (no attempt is spent, so backoff actually spaces retries).
      if (note.nextEligibleAt && note.nextEligibleAt > now) {
        retry.push(note);
        continue;
      }
      try {
        const byteArray = new Uint8Array(Buffer.from(note.bytes, 'base64'));
        await midenClientProxy.importNoteBytes(byteArray);
        // Success: the note is intentionally NOT pushed to `retry`, so it drops
        // out of the queue.
      } catch (e) {
        const attempts = note.attempts + 1;
        const firstFailureAt = note.firstFailureAt ?? now;
        const transient = isLikelyNetworkError(e);
        const giveUp = transient ? now - firstFailureAt >= TRANSIENT_RETRY_BUDGET_MS : attempts >= POISON_MAX_ATTEMPTS;

        if (giveUp) {
          // Never silently drop: move to the dead-letter store (recoverable +
          // surfaceable). The note leaves the active queue (not pushed to retry).
          await addToNoteDeadletter({
            bytes: note.bytes,
            reason: transient ? 'transport' : 'malformed',
            failedAt: now,
            attempts
          });
        } else if (transient) {
          // Back off before the next attempt so a persistent outage doesn't
          // hammer a recovering node every loop tick.
          const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
          logger.warning(`Failed to import queued note (transient, attempt ${attempts}); backing off then retrying`, e);
          retry.push({ bytes: note.bytes, attempts, firstFailureAt, nextEligibleAt: now + backoffMs });
        } else {
          // Poison and not yet at cap: retry promptly (no backoff) so it either
          // succeeds (misclassification) or hits the cap fast and dead-letters.
          logger.warning(
            `Failed to import queued note (poison, attempt ${attempts}/${POISON_MAX_ATTEMPTS}); will retry`,
            e
          );
          retry.push({ bytes: note.bytes, attempts, firstFailureAt });
        }
      }
    }

    // Rebuild the queue as the retry-eligible notes plus anything queueNoteImport
    // appended during this pass — it only ever appends, so those are exactly the
    // entries beyond our snapshot. Doing this inside the lock and before syncState
    // means a syncState throw can't leave processed notes queued for retry without
    // bumping their attempt count, which would let a poison note loop unbounded.
    //
    // The read-slice-write runs under withQueueLock, the same lock queueNoteImport
    // holds, so a concurrent enqueue can't land between the read and write and be
    // clobbered (or cause a processed note to be re-added). The lock covers only
    // this storage rewrite — not the import work above or the syncState delay
    // below — so enqueues are never blocked for more than a storage round-trip.
    await withQueueLock(async () => {
      const current = (await fetchFromStorage<StoredEntry[]>(IMPORT_NOTES_KEY)) || [];
      const appendedDuringPass = current.slice(rawQueue.length);
      await putToStorage(IMPORT_NOTES_KEY, [...retry, ...appendedDuringPass]);
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
    await midenClientProxy.syncState();
  });
};
