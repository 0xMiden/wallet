import { logger } from 'shared/logger';

import { midenClientProxy } from '../back/miden-client-proxy';
import { fetchFromStorage, putToStorage } from '../front';
import { isLikelyNetworkError } from './connectivity-classify';
import { addToNoteDeadletter } from '../note-deadletter';
import { withWasmClientLock } from '../sdk/miden-client';
import { isWasmClientPoisonedError, WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';
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

// "The client already has this note" is a DONE verdict, not a failure: the SDK's
// import is an upsert, but a consumed note is refused by text.
const isAlreadyImported = (error: unknown): boolean => {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return message.includes('already been consumed') || message.includes('already exists');
};

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

/**
 * The number of passes started. A pass that was ABANDONED — a watchdog eviction
 * rejects the lock holder's promise but does not stop its callback, which resumes
 * whenever its parked `importNoteBytes` finally settles — must not write the queue
 * on the way out. Its view is minutes stale, and a stale write both regresses the
 * attempt counts the failure path has since banked and (before `commitQueue`
 * stopped keying on array position) deleted every note enqueued in the meantime.
 */
let importPassToken = 0;

const isUsableEntry = (entry: StoredEntry): boolean =>
  typeof entry === 'string' ? entry.length > 0 : typeof entry?.bytes === 'string';

export const importAllNotes = async () => {
  const rawQueue = (await fetchFromStorage<StoredEntry[]>(IMPORT_NOTES_KEY)) || [];
  // A corrupt value is skipped rather than thrown on: `DesktopStorage.get` hands
  // back the raw string when `JSON.parse` fails, and normalizing that used to
  // throw from OUTSIDE the pass's try — jamming note import permanently with no
  // banking, no dead-letter and no drain. Unusable entries are left in place by
  // `commitQueue` (it only removes what it recognises), so nothing is destroyed.
  if (!Array.isArray(rawQueue) || rawQueue.length === 0) {
    return;
  }
  const snapshot = rawQueue.filter(isUsableEntry).map(normalizeEntry);
  if (snapshot.length === 0) {
    return;
  }

  const myToken = ++importPassToken;
  let committed = false;

  // Rewrite the queue as `retry` plus every entry that is not ours.
  //
  // Refused outright once this pass has committed, or once a newer pass has
  // started, so only ONE write per pass lands. That is what makes an abandoned
  // pass safe: an eviction rejects the holder's promise but does not stop its
  // callback, which resumes when its parked import finally settles and tries to
  // commit a minutes-stale view — over a queue a successor has since rewritten,
  // and over notes enqueued in the meantime whose bytes, for a private note, are
  // the only copy of the funds they carry.
  //
  // Entries are matched by BYTES as a multiset rather than by array position,
  // which the guard above makes belt-and-braces rather than load-bearing: with one
  // writer per pass, position and identity agree. It stops being redundant the
  // moment a second writer exists (a frontend call site, another realm), because
  // `current.slice(rawQueue.length)` silently DELETES the difference whenever the
  // queue has shrunk, where a multiset merge can only ever re-add our own notes.
  const commitQueue = (retry: QueuedNoteImport[]) =>
    withQueueLock(async () => {
      if (committed || myToken !== importPassToken) {
        logger.warning('[importAllNotes] dropping a superseded queue write from an abandoned import pass');
        return;
      }
      const current = (await fetchFromStorage<StoredEntry[]>(IMPORT_NOTES_KEY)) || [];
      const owed = new Map<string, number>();
      for (const note of snapshot) owed.set(note.bytes, (owed.get(note.bytes) ?? 0) + 1);
      const notOurs = current.filter(entry => {
        const bytes = typeof entry === 'string' ? entry : entry?.bytes;
        const remaining = owed.get(bytes) ?? 0;
        if (remaining === 0) return true;
        owed.set(bytes, remaining - 1);
        return false;
      });
      await putToStorage(IMPORT_NOTES_KEY, [...retry, ...notOurs]);
      committed = true;
    });

  // A wall-clock stamp stepped forward (a device whose RTC is wrong until NTP
  // settles) would otherwise strand a note forever: never eligible, and never
  // expired either, because the elapsed budget goes negative. Clamped both ways,
  // the same way the sync breaker clamps its persisted deadline (#777).
  const isEligible = (note: QueuedNoteImport, now: number) =>
    note.nextEligibleAt === undefined || note.nextEligibleAt <= now || note.nextEligibleAt - now > BACKOFF_MAX_MS;
  const elapsedSince = (from: number | undefined, now: number) => Math.max(0, now - (from ?? now));

  // The note whose import is in flight. An eviction abandons the callback mid-call,
  // so this is the ONLY note the failure path can charge: the loop is sequential,
  // so every other entry either finished or was never attempted.
  // A holder rather than a bare `let`: the assignments happen inside the lock
  // callback, which control-flow analysis does not see, so a plain variable narrows
  // to `null` for the whole failure path.
  const inFlight: { note: QueuedNoteImport | null } = { note: null };
  // The retry list the loop built, once it finished building it. If the throw came
  // from the commit rather than the imports, this is the correct write and the
  // failure path re-issues it — banking from the snapshot instead would re-queue
  // notes the loop had just imported or dead-lettered.
  let loopRetry: QueuedNoteImport[] | null = null;

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
          if (!isEligible(note, now)) {
            retry.push(note);
            continue;
          }
          try {
            const byteArray = new Uint8Array(Buffer.from(note.bytes, 'base64'));
            inFlight.note = note;
            await midenClientProxy.importNoteBytes(byteArray);
            // Success: the note is intentionally NOT pushed to `retry`, so it drops
            // out of the queue.
          } catch (e) {
            const attempts = note.attempts + 1;
            const firstFailureAt = note.firstFailureAt ?? now;
            // An already-consumed note is DONE, not poison: re-importing one is
            // routine here (an abandoned pass carries notes it may already have
            // imported), and counting it toward the poison cap dead-lettered a
            // note whose funds were safely claimed — and burned the one signal
            // this store exists to raise.
            if (isAlreadyImported(e)) {
              logger.info('Queued note is already in the client; dropping it from the import queue');
              continue;
            }
            // A poison eviction is transport-shaped, per the repo-wide rule that
            // `WasmClientPoisonedError` is an abandonment rather than a verdict.
            // Left on the poison cap it dead-lettered a perfectly good note as
            // `malformed` after three wedged laps.
            const transient = isLikelyNetworkError(e) || isWasmClientPoisonedError(e);
            const giveUp = transient
              ? elapsedSince(firstFailureAt, now) >= TRANSIENT_RETRY_BUDGET_MS
              : attempts >= POISON_MAX_ATTEMPTS;

            if (giveUp) {
              // Never silently drop: move to the dead-letter store (recoverable +
              // surfaceable). The note only leaves the active queue if the
              // dead-letter write actually landed — a full storage quota otherwise
              // took the bytes out of both stores at once.
              const stored = await addToNoteDeadletter({
                bytes: note.bytes,
                reason: transient ? 'transport' : 'malformed',
                failedAt: now,
                attempts
              });
              if (!stored) retry.push({ bytes: note.bytes, attempts, firstFailureAt });
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
          } finally {
            inFlight.note = null;
          }
        }

        loopRetry = retry;
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
    // The hold failed. Two shapes, and they need opposite writes.
    //
    // If the loop finished, the throw came from the commit itself: `loopRetry` IS
    // the correct queue, so re-issue it rather than rebuilding from the snapshot.
    //
    // Otherwise the hold was torn down mid-import (an eviction abandons its
    // callback, so neither the per-note catch nor the commit ran) and the attempt
    // has to be banked here. Without it the queue is byte-identical next lap and
    // the same note re-enters the same hold forever: nothing spends an attempt, so
    // `POISON_MAX_ATTEMPTS` never caps, the dead-letter store is never reached, and
    // the anti-brick property this queue is built on is lost. The backoff is what
    // ends it for that note — carried, it stops being eligible.
    //
    // Only the IN-FLIGHT note is charged. The loop is sequential, so it is the one
    // note the tear-down interrupted; charging the rest would inflate attempts
    // toward the poison cap and anchor a 24h budget on notes that were never tried.
    // Every other note is carried unchanged, including ones this pass may already
    // have imported — which of them landed is unknowable, and a re-import is what
    // every other retry here already does.
    const now = Date.now();
    const charged = inFlight.note;
    const banked: QueuedNoteImport[] = [];
    for (const note of snapshot) {
      if (note !== charged) {
        banked.push(note);
        continue;
      }
      const attempts = note.attempts + 1;
      const firstFailureAt = note.firstFailureAt ?? now;
      if (elapsedSince(firstFailureAt, now) >= TRANSIENT_RETRY_BUDGET_MS) {
        const stored = await addToNoteDeadletter({ bytes: note.bytes, reason: 'transport', failedAt: now, attempts });
        if (!stored) banked.push({ bytes: note.bytes, attempts, firstFailureAt });
        continue;
      }
      const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
      banked.push({ bytes: note.bytes, attempts, firstFailureAt, nextEligibleAt: now + backoffMs });
    }
    await commitQueue(loopRetry ?? banked);
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
