import { logger } from 'shared/logger';

import { midenClientProxy } from '../back/miden-client-proxy';
import { fetchFromStorage, putToStorage } from '../front';
import { isLikelyNetworkError } from './connectivity-classify';
import { addToNoteDeadletter } from '../note-deadletter';
import { withWasmClientLock } from '../sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';
import { syncUnderBoundedLock } from '../sync-lock';

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

  const commitQueue = (retry: QueuedNoteImport[]) =>
    // The read-slice-write runs under withQueueLock, the same lock queueNoteImport
    // holds, so a concurrent enqueue can't land between the read and write and be
    // clobbered (or cause a processed note to be re-added). The lock covers only
    // this storage rewrite — not the import work or the trailing sync — so enqueues
    // are never blocked for more than a storage round-trip.
    withQueueLock(async () => {
      const current = (await fetchFromStorage<StoredEntry[]>(IMPORT_NOTES_KEY)) || [];
      // Rebuild as the retry-eligible notes plus anything queueNoteImport appended
      // during this pass — it only ever appends, so those are exactly the entries
      // beyond our snapshot.
      const appendedDuringPass = current.slice(rawQueue.length);
      await putToStorage(IMPORT_NOTES_KEY, [...retry, ...appendedDuringPass]);
    });

  // Wrap the import work in a lock to prevent concurrent WASM access. The import
  // routes through `midenClientProxy` (issue #260, slice 7a) so flag-ON it hits the
  // OFFSCREEN client's store — the realm that syncs + consumes, so an imported
  // (possibly private) note isn't stranded in the dormant SW store. Flag-OFF is
  // byte-identical to the inline call under this lock. The trailing sync goes
  // through the same proxy, in its own bounded hold below.
  try {
    await withWasmClientLock(
      async () => {
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
            const giveUp = transient
              ? now - firstFailureAt >= TRANSIENT_RETRY_BUDGET_MS
              : attempts >= POISON_MAX_ATTEMPTS;

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
              logger.warning(
                `Failed to import queued note (transient, attempt ${attempts}); backing off then retrying`,
                e
              );
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

        // Committed inside the hold and before the trailing sync, so a failure
        // after this point can't leave processed notes queued for retry without
        // bumping their attempt count — which would let a poison note loop
        // unbounded.
        await commitQueue(retry);
      },
      // Bounded like the pure-sync holds (#777): flag-OFF `importNoteBytes` is a
      // raw WASM call whose RPC carries no transport deadline on wasm32, so a node
      // that accepts the request and never answers parked this hold — and with it
      // every send, claim and balance read — on the five-minute last resort, once
      // per lap, for as long as the note stayed queued.
      { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS }
    );
  } catch (e) {
    // The hold was torn down (an eviction abandons its callback mid-loop, so
    // neither the per-note catch nor the commit inside it ran). Bank the attempt
    // here or the queue is byte-identical next lap and the note re-enters the same
    // hold forever: nothing spends an attempt, so `POISON_MAX_ATTEMPTS` never
    // caps, the dead-letter store is never reached, and the anti-brick property
    // this queue is built on — a note that cannot import must DRAIN — is lost.
    //
    // Treated as transient, which is the conservative reading: an eviction says
    // the WASM realm was torn off a parked call, not that the note is malformed,
    // so it earns backoff and the 24h wall-clock budget rather than a prompt
    // dead-letter. The backoff is what ends the loop — a carried note stops being
    // eligible, so the next pass imports nothing and cannot fail this way again.
    //
    // No note is dropped: which imports had already landed before the tear-down is
    // unknowable, so every eligible note is carried. A re-import of a note that did
    // land is what every other retry here already does.
    const now = Date.now();
    const banked = snapshot.map(note => {
      if (note.nextEligibleAt && note.nextEligibleAt > now) return note;
      const attempts = note.attempts + 1;
      const firstFailureAt = note.firstFailureAt ?? now;
      const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
      return { bytes: note.bytes, attempts, firstFailureAt, nextEligibleAt: now + backoffMs };
    });
    const expired = banked.filter(note => now - (note.firstFailureAt ?? now) >= TRANSIENT_RETRY_BUDGET_MS);
    for (const note of expired) {
      await addToNoteDeadletter({ bytes: note.bytes, reason: 'transport', failedAt: now, attempts: note.attempts });
    }
    await commitQueue(banked.filter(note => !expired.includes(note)));
    throw e;
  }

  // Outside the import hold, and bounded (#777).
  //
  // This is a pure-sync tail: nothing follows it, and the queue rewrite above has
  // already committed, so it has no business holding the import's lock — least of
  // all across a 2s sleep. On wasm32 the sync carries no transport deadline, so on
  // the default backstop a parked node froze the whole app's WASM access for five
  // minutes per lap, which is the #777 shape every other pure-sync hold now bounds.
  //
  // Its failure is also swallowed here rather than thrown, and the distinction
  // matters to the caller: by this point every note has either imported or been
  // carried forward with its attempt count banked, so a failed sync says nothing
  // about the queue. What the caller must still see is a failure of the IMPORT
  // phase, because a note that did not import is a note some queued consume is
  // waiting for.
  try {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await syncUnderBoundedLock();
  } catch (e) {
    console.warn('[importAllNotes] post-import sync failed; the queue is already committed', e);
  }
};
