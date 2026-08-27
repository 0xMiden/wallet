import { logger } from 'shared/logger';

import { midenClientProxy } from '../back/miden-client-proxy';
import { fetchFromStorage, putToStorage } from '../front';
import { isLikelyNetworkError } from './connectivity-classify';
import { addToNoteDeadletter } from '../note-deadletter';
import { getCurrentWasmLockHold, withWasmClientLock } from '../sdk/miden-client';
import {
  isWasmClientPoisonedError,
  WasmClientPoisonedError,
  WASM_LOCK_SYNC_WATCHDOG_MS
} from '../sdk/wasm-client-poison';
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
// Exported so the tests can pin a give-up carry AT the ceiling rather than merely
// "in the future" — a stamp of `now + 3s` satisfies the weaker assertion while still
// re-running the whole give-up round trip on the next lap.
export const BACKOFF_MAX_MS = 5 * 60 * 1000;

// Persisted queue entries. Legacy entries were bare base64 strings; they are
// normalized to the object form on read, so no migration step is needed.
// `firstFailureAt` anchors the transient wall-clock budget; `nextEligibleAt`
// implements per-note backoff (a note not yet eligible is skipped this pass).
type QueuedNoteImport = {
  bytes: string;
  attempts: number;
  /**
   * Failures classified as POISON, which is the only counter the poison cap may
   * read. `attempts` counts every failure of any shape and is kept for the
   * dead-letter record, but capping on it conflated two budgets: a note that had
   * already spent three attempts on a transient outage (or on watchdog evictions,
   * which are transient by the repo-wide `WasmClientPoisonedError` rule) was at the
   * cap before its FIRST poison failure, so a single misclassified transport error
   * dead-lettered it as `malformed` with none of the misclassification grace the
   * cap exists to provide.
   */
  poisonAttempts?: number;
  firstFailureAt?: number;
  nextEligibleAt?: number;
};
type StoredEntry = string | QueuedNoteImport;

// Counters come back from storage unvalidated, and a corrupt one strands a note
// permanently rather than loudly: `attempts: "3"` makes every `+ 1` produce a
// string, and a NaN `nextEligibleAt` fails BOTH eligibility comparisons, so the
// note is skipped on every pass forever while still occupying the queue.
const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const optionalFinite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const normalizeEntry = (entry: StoredEntry): QueuedNoteImport =>
  typeof entry === 'string'
    ? { bytes: entry, attempts: 0 }
    : {
        ...entry,
        attempts: finiteOr(entry.attempts, 0),
        poisonAttempts: optionalFinite(entry.poisonAttempts),
        firstFailureAt: optionalFinite(entry.firstFailureAt),
        nextEligibleAt: optionalFinite(entry.nextEligibleAt)
      };

// "The client already has this note" is a DONE verdict, not a failure: the SDK's
// import is an upsert, so a duplicate does not throw at all — only a CONSUMED note
// is refused, and only by text.
//
// Matching is deliberately narrow, for the reason `note-delivery-sweep.ts` spells
// out at length about the same substring: a bare "already exists" also comes back
// from tonic's stock `AlreadyExists` blurb, from Dexie's `ConstraintError` (and the
// import writes a Dexie-backed store), and from the SDK's own account-tree and
// asset-vault errors. Since a match DROPS the note from the queue, matching that
// spelling would delete the only copy of a note that was never stored.
const isAlreadyImported = (error: unknown): boolean =>
  (error instanceof Error ? error.message : String(error ?? '')).toLowerCase().includes('already been consumed');

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
    const stored = await fetchFromStorage<StoredEntry[]>(IMPORT_NOTES_KEY);
    // A corrupt value must not take the incoming note down with it. `DesktopStorage`
    // and `CapacitorStorage` hand back the raw string when `JSON.parse` fails, and
    // spreading that produced a queue of single characters; spreading a non-iterable
    // object THREW, and both call sites that matter swallow this function's rejection
    // (`back/main.ts`, `back/dapp.ts`), so the note was silently lost at the door.
    // Starting fresh is the safe branch here: the unparseable value holds no notes we
    // can recover, and the alternative is dropping one we can.
    const queuedImports = Array.isArray(stored) ? stored : [];
    if (stored && !Array.isArray(stored)) {
      logger.error('[queueNoteImport] pending-import queue was unreadable; starting a fresh queue for the new note');
    }
    // Identical bytes are the same note, and the import is an upsert, so a second
    // copy only buys a second WASM import per pass — and a second entry to carry,
    // back off and eventually dead-letter. The delivery sweep and the dApp path can
    // both offer the same note, so this is a routine collision rather than a bug.
    if (queuedImports.some(entry => (typeof entry === 'string' ? entry : entry?.bytes) === noteBytes)) {
      return;
    }
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
  // Written back in the LEGACY bare-string form when it carries no retry metadata,
  // which is the shape most carried notes have (skipped for backoff, or untouched by
  // an eviction on their first pass). Normalizing on read means an entry that arrived
  // as a string would otherwise be rewritten as an object, and a build that predates
  // the object form reads that object's `bytes` as the base64 itself — an unimportable
  // note that drains through the attempt cap. Downgrading is not a supported path, but
  // it should not eat notes when the equivalent legacy encoding is free.
  const serializeEntry = (note: QueuedNoteImport): StoredEntry => {
    // A zero poison count is the absence of one, and writing it out would keep an
    // otherwise-metadata-free entry off the legacy encoding below (every transient
    // failure carries one).
    const written = { ...note };
    if (!written.poisonAttempts) delete written.poisonAttempts;
    return written.attempts === 0 &&
      written.poisonAttempts === undefined &&
      written.firstFailureAt === undefined &&
      written.nextEligibleAt === undefined
      ? written.bytes
      : written;
  };

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
      await putToStorage(IMPORT_NOTES_KEY, [...retry.map(serializeEntry), ...notOurs]);
      committed = true;
    });

  // A wall-clock stamp stepped forward (a device whose RTC is wrong until NTP
  // settles) would otherwise strand a note forever: never eligible, and never
  // expired either, because the elapsed budget goes negative. Clamped both ways,
  // the same way the sync breaker clamps its persisted deadline (#777).
  const isEligible = (note: QueuedNoteImport, now: number) =>
    note.nextEligibleAt === undefined || note.nextEligibleAt <= now || note.nextEligibleAt - now > BACKOFF_MAX_MS;
  // The budget's anchor needs the same treatment, and clamping elapsed time at zero
  // is not enough on its own: a stamp written while the clock was AHEAD stays ahead
  // after the correction, so elapsed reads zero on every later pass and the 24h
  // budget never expires — the note is retried forever and never dead-lettered.
  // A first failure cannot be in the future, so a stamp that is gets re-anchored,
  // which restarts the budget rather than voiding it.
  const anchorOf = (note: QueuedNoteImport, now: number) =>
    note.firstFailureAt === undefined || note.firstFailureAt > now ? now : note.firstFailureAt;
  const elapsedSince = (from: number, now: number) => Math.max(0, now - from);

  // The note whose import is in flight. An eviction abandons the callback mid-call,
  // so this is the ONLY note the failure path can charge: the loop is sequential,
  // so every other entry either finished or was never attempted.
  // A holder rather than a bare `let`: the assignments happen inside the lock
  // callback, which control-flow analysis does not see, so a plain variable narrows
  // to `null` for the whole failure path.
  const inFlight: { note: QueuedNoteImport | null } = { note: null };
  // Notes this pass imported successfully, so the failure path can leave them out.
  // Banking the whole snapshot minus the in-flight note re-queued them, and a
  // re-import of a note the client already holds is only recognised as done once it
  // has been CONSUMED — before that it either succeeds silently (the import is an
  // upsert) or comes back as something this code has to classify, and every
  // classification that is not "done" spends an attempt. Three laps of that
  // dead-lettered a perfectly good note as `malformed`, which is the one signal the
  // dead-letter store exists to raise.
  const imported = new Set<QueuedNoteImport>();
  // What the loop DECIDED for each note it finished with — the carried entry, or
  // `null` for one it dead-lettered. The tear-down path used to rebuild from the raw
  // snapshot, which threw away every decision made earlier in the same pass: a note
  // that failed as poison went back with its counter at zero (so `POISON_MAX_ATTEMPTS`
  // could never cap it — the anti-brick property this queue is built on), and a note
  // carried with a five-minute backoff went back bare, eligible again next lap. With a
  // parked import later in the same snapshot, both repeat every lap forever.
  const decided = new Map<QueuedNoteImport, QueuedNoteImport | null>();
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
      async hold => {
        const now = Date.now();
        const retry: QueuedNoteImport[] = [];
        for (const note of snapshot) {
          // Stop the moment this pass no longer holds the mutex. An eviction rejects
          // the holder's promise but does NOT stop this callback: it resumes when the
          // parked `importNoteBytes` settles and imports the REST of the snapshot with
          // no mutex held, alongside the successor that legitimately holds it — the
          // "recursive use of an object / RefCell already borrowed" double-borrow the
          // lock exists to prevent, and on mobile/desktop that successor is typically
          // this same realm's idle `syncState`. Same guard, same reason, as the
          // offscreen confirmation poll.
          //
          // THROWS rather than breaking: a break falls through to `commitQueue(retry)`,
          // and every note the loop had not reached yet is absent from `retry` — the
          // commit would delete bytes that may be the only copy of the funds they
          // carry. Throwing hands the pass to the catch below, which banks the
          // in-flight note and carries the untouched rest. The lock parks a no-op
          // handler on this callback, so the throw is silent rather than an unhandled
          // rejection re-entering trap recovery.
          if (getCurrentWasmLockHold() !== hold) {
            throw new WasmClientPoisonedError(
              'watchdog',
              new Error('note import pass abandoned: the WASM lock hold is no longer ours')
            );
          }
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
            imported.add(note);
            decided.set(note, null);
          } catch (e) {
            const attempts = note.attempts + 1;
            const firstFailureAt = anchorOf(note, now);
            // An already-consumed note is DONE, not poison: re-importing one is
            // routine here (an abandoned pass carries notes it may already have
            // imported), and counting it toward the poison cap dead-lettered a
            // note whose funds were safely claimed — and burned the one signal
            // this store exists to raise.
            if (isAlreadyImported(e)) {
              logger.info('Queued note is already in the client; dropping it from the import queue');
              imported.add(note);
              decided.set(note, null);
              continue;
            }
            // A poison eviction is transport-shaped, per the repo-wide rule that
            // `WasmClientPoisonedError` is an abandonment rather than a verdict.
            // Left on the poison cap it dead-lettered a perfectly good note as
            // `malformed` after three wedged laps.
            const transient = isLikelyNetworkError(e) || isWasmClientPoisonedError(e);
            const poisonAttempts = (note.poisonAttempts ?? 0) + (transient ? 0 : 1);
            const giveUp = transient
              ? elapsedSince(firstFailureAt, now) >= TRANSIENT_RETRY_BUDGET_MS
              : poisonAttempts >= POISON_MAX_ATTEMPTS;

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
              // Carried with a MAXIMUM backoff stamp, not bare. `giveUp` stays true
              // from here on, so a bare carry is eligible on every later pass and the
              // note re-runs a full import + dead-letter round trip every lap, forever
              // — the hot loop the give-up exists to end. The dead-letter store being
              // full or unwritable is a condition that changes on a timescale of
              // minutes at best, so this is spaced at the curve's ceiling.
              decided.set(note, null);
              if (!stored) {
                const carried = {
                  ...note,
                  attempts,
                  poisonAttempts,
                  firstFailureAt,
                  nextEligibleAt: now + BACKOFF_MAX_MS
                };
                decided.set(note, carried);
                retry.push(carried);
              }
            } else if (transient) {
              // Back off before the next attempt so a persistent outage doesn't
              // hammer a recovering node every loop tick.
              const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
              logger.warning(
                `Failed to import queued note (transient, attempt ${attempts}); backing off then retrying`,
                e
              );
              const carried = { ...note, attempts, poisonAttempts, firstFailureAt, nextEligibleAt: now + backoffMs };
              decided.set(note, carried);
              retry.push(carried);
            } else {
              // Poison and not yet at cap: retry promptly (no backoff) so it either
              // succeeds (misclassification) or hits the cap fast and dead-letters.
              logger.warning(
                `Failed to import queued note (poison, attempt ${poisonAttempts}/${POISON_MAX_ATTEMPTS}); will retry`,
                e
              );
              const carried = { ...note, attempts, poisonAttempts, firstFailureAt };
              decided.set(note, carried);
              retry.push(carried);
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
    // Notes the loop had already imported are dropped rather than carried: they are
    // in the client, and re-queueing them made every later pass re-import a note it
    // already held (see `imported`).
    const now = Date.now();
    const charged = inFlight.note;
    const banked: QueuedNoteImport[] = [];
    for (const note of snapshot) {
      if (imported.has(note)) continue;
      if (note !== charged) {
        // The loop's own decision when it had one, the untouched entry otherwise (a
        // note it never reached, which must go back with nothing spent on it).
        const decision = decided.has(note) ? decided.get(note) : note;
        if (decision) banked.push(decision);
        continue;
      }
      const attempts = note.attempts + 1;
      const firstFailureAt = anchorOf(note, now);
      if (elapsedSince(firstFailureAt, now) >= TRANSIENT_RETRY_BUDGET_MS) {
        const stored = await addToNoteDeadletter({ bytes: note.bytes, reason: 'transport', failedAt: now, attempts });
        // Backoff-stamped for the same reason as the per-note give-up above: bare, it
        // would be eligible every lap with `giveUp` permanently true.
        if (!stored) {
          banked.push({ ...note, attempts, firstFailureAt, nextEligibleAt: now + BACKOFF_MAX_MS });
        }
        continue;
      }
      const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
      // `poisonAttempts` is left as it was: an eviction is an abandonment, not a
      // verdict on the note, so it must not spend the misclassification grace.
      banked.push({ ...note, attempts, firstFailureAt, nextEligibleAt: now + backoffMs });
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
  //
  // Skipped outright when the pass landed nothing. The sync exists to surface the
  // notes this pass imported; with none, a queue that is entirely backed-off or
  // dead-lettered still paid a 2s sleep and a full sync hold on every lap of the
  // caller's loop, which on mobile is once a second.
  if (imported.size === 0) return;
  try {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await syncUnderBoundedLock();
  } catch (e) {
    console.warn('[importAllNotes] post-import sync failed; the queue is already committed', e);
  }
};
