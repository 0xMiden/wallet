import { logger } from 'shared/logger';

import { fetchFromStorage, putToStorage } from '../front';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

const IMPORT_NOTES_KEY = 'miden-notes-pending-import';

// A queued note is dropped after this many failed import attempts. The bound is
// what keeps the queue draining: a deterministically bad note (e.g. a dApp sent
// raw Note bytes where a serialized NoteFile is expected) fails every attempt
// and would otherwise re-throw on every transaction-loop iteration forever,
// jamming all transaction generation and bricking the wallet. The retries before
// the drop give genuinely transient failures (e.g. a NoteId import fetches over
// RPC and can hit a network blip) a chance to succeed, so a recoverable note —
// including a private note whose bytes are its only copy — isn't lost to one blip.
const MAX_IMPORT_ATTEMPTS = 3;

// Persisted queue entries. Legacy entries were bare base64 strings; they are
// normalized to the object form on read, so no migration step is needed.
type QueuedNoteImport = { bytes: string; attempts: number };
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

  // Wrap all WASM client operations in a lock to prevent concurrent access
  await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    const retry: QueuedNoteImport[] = [];
    for (const note of snapshot) {
      try {
        const byteArray = new Uint8Array(Buffer.from(note.bytes, 'base64'));
        await midenClient.importNoteBytes(byteArray);
      } catch (e) {
        const attempts = note.attempts + 1;
        if (attempts >= MAX_IMPORT_ATTEMPTS) {
          logger.error(
            `Dropping queued note after ${attempts} failed import attempts (${note.bytes.length} b64 chars)`,
            e
          );
        } else {
          logger.warning(`Failed to import queued note (attempt ${attempts}/${MAX_IMPORT_ATTEMPTS}); will retry`, e);
          retry.push({ bytes: note.bytes, attempts });
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
    await midenClient.syncState();
  });
};
