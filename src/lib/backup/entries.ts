/**
 * The generic encrypted-entry layer of the backup (architecture doc 5.3).
 *
 * Read rules:
 * - Reads of one profile run one at a time, full and `since` reads alike, so
 *   an older response cannot replace a newer ETag or cursor.
 * - An entry is applied only when this device has no copy of it or the server
 *   copy has a higher revision. Revisions are compared only for the same
 *   hashed key in the same key generation (the state is cleared on a salt change).
 * - The ETag and the cursor move only after the feature applied every entry.
 *
 * Write rules:
 * - Uploads of this device run one at a time, so a late retry cannot replace a
 *   newer upload.
 * - A batch carries only entries whose plaintext changed since the server copy
 *   this device knows.
 * - An acknowledgement records the revision and time of the entries it wrote.
 *   It never moves the ETag or the cursor: another device may have written
 *   entries that this device did not read.
 *
 * Session rule: a lock, a wipe or a profile change closes the session while a
 * task may still hold it (`isSessionLive`). So the session is checked before
 * every request (`withSessionToken`), before a read is applied and before an
 * acknowledgement is recorded. A closed session throws
 * `BackupSessionClosedError` and nothing is written.
 */
import {
  type BackupFeature,
  MAX_BATCH_ENTRIES,
  MAX_REQUEST_BODY_BYTES,
  type StoredEntry,
  getFeature,
  putEntries
} from './api-client';
import {
  DEFAULT_BLOB_CAP,
  type EncryptedEntry,
  HISTORY_BLOB_CAP,
  decryptEntry,
  encryptEntry,
  encryptedBlobLength,
  hashedEntryKey,
  plaintextDigest
} from './crypto';
import { type BackupSession, assertSessionLive, withSessionToken } from './session';
import { persistBackupState } from './state';

/** One decrypted server entry that this device has not applied yet. */
export interface IncomingEntry {
  hashedKey: string;
  revision: number;
  updatedAt: number;
  plaintext: string;
}

/** One entry this device wants the server to hold. */
export interface OutgoingEntry {
  /** The entry key before hashing, such as `contacts` or `history:<deviceId>:<n>`. */
  entryKey: string;
  plaintext: string;
}

/** `not-modified`: a 304. `no-new-entries`: a 200 with nothing this device had not applied. `applied`: new entries. */
export type ReadOutcome = 'not-modified' | 'no-new-entries' | 'applied';

/** The decoded blob cap of a feature. */
export function blobCapOf(feature: BackupFeature): number {
  switch (feature) {
    case 'history':
      return HISTORY_BLOB_CAP;
    case 'accounts':
    case 'contacts':
      return DEFAULT_BLOB_CAP;
  }
}

/** The hashed key of an entry key in this session's key generation. */
export function hashedKeyOf(session: BackupSession, entryKey: string): string {
  return hashedEntryKey(entryKey, session.storageKey);
}

let readChain: Promise<unknown> = Promise.resolve();
let uploadChain: Promise<unknown> = Promise.resolve();

/** Run `task` after every earlier task of `chain`, whatever their outcome. */
function enqueue<T>(chain: 'read' | 'upload', task: () => Promise<T>): Promise<T> {
  const previous = chain === 'read' ? readChain : uploadChain;
  const run = previous.then(task, task);
  const settled = run.catch(() => undefined);
  if (chain === 'read') readChain = settled;
  else uploadChain = settled;
  return run;
}

export interface ReadFeatureOptions {
  /** Ask only for entries written at or after the cursor of the last applied read. */
  since: boolean;
  /** Hashed keys this device writes itself (its own history chunks); never applied from the server. */
  ownHashedKeys?: ReadonlySet<string>;
  /**
   * Apply the entries to local state. It runs once per read, also with an
   * empty list. A rejection keeps the ETag and cursor where they were.
   */
  apply: (entries: IncomingEntry[]) => Promise<void>;
}

/** The most pages one read follows. The server holds at most 1000 entries per feature at 100 per page. */
const MAX_READ_PAGES = 16;

/**
 * Read every page of a feature. Only the first page is conditional: a 304 ends
 * the read. The ETag kept is the FIRST page's, on purpose. A write that lands
 * between two pages moves the feature's ETag past it, so the next conditional
 * read is a 200 and reads the write; the last page's ETag could match the
 * server after such a write and hide it behind a 304.
 */
async function readPages(
  session: BackupSession,
  feature: BackupFeature,
  ifNoneMatch: string | null,
  since: number | null
): Promise<{ etag: string; entries: StoredEntry[] } | null> {
  const entries: StoredEntry[] = [];
  let etag: string | null = null;
  let after: string | null = null;
  for (let page = 0; page < MAX_READ_PAGES; page += 1) {
    const startAfter = after;
    const conditional = page === 0 ? ifNoneMatch : null;
    const read = await withSessionToken(session, token => getFeature(token, feature, conditional, since, startAfter));
    if (read === null) return null;
    etag ??= read.etag;
    entries.push(...read.entries);
    if (read.next === null) return { etag, entries };
    after = read.next;
  }
  throw new Error(`The ${feature} read did not end within ${MAX_READ_PAGES} pages`);
}

/** Read one feature, conditional on its last applied ETag, and apply the new entries. */
export function readFeature(
  session: BackupSession,
  feature: BackupFeature,
  options: ReadFeatureOptions
): Promise<ReadOutcome> {
  return enqueue('read', async () => {
    const featureState = session.state.features[feature];
    const since = options.since ? featureState.cursor : null;
    const read = await readPages(session, feature, featureState.etag, since);
    if (read === null) return 'not-modified';

    const incoming: IncomingEntry[] = [];
    let cursor = featureState.cursor ?? 0;
    for (const stored of read.entries) {
      cursor = Math.max(cursor, stored.updatedAt);
      if (options.ownHashedKeys?.has(stored.hashedKey)) continue;
      const mark = featureState.entries[stored.hashedKey];
      if (mark !== undefined && mark.revision >= stored.revision) continue;
      const plaintext = await openEntry(session, feature, stored.entry);
      if (plaintext === null) continue;
      incoming.push({ hashedKey: stored.hashedKey, revision: stored.revision, updatedAt: stored.updatedAt, plaintext });
    }

    // The decrypt awaited: a lock may have landed. Nothing of a closed session reaches local state.
    assertSessionLive(session);
    await options.apply(incoming);
    assertSessionLive(session);

    // Everything is applied: only now the records, the ETag and the cursor move.
    for (const entry of incoming) {
      featureState.entries[entry.hashedKey] = {
        revision: entry.revision,
        updatedAt: entry.updatedAt,
        digest: plaintextDigest(entry.plaintext)
      };
    }
    featureState.etag = read.etag;
    if (read.entries.length > 0) featureState.cursor = cursor;
    await persistBackupState(session.state);
    return incoming.length > 0 ? 'applied' : 'no-new-entries';
  });
}

/**
 * Decrypt one server entry. An entry this key cannot open (other KDF
 * parameters, a changed byte, a foreign key generation) is logged and skipped:
 * the decryption fails the same way on every read, so failing the read would
 * stop the cursor for good.
 */
async function openEntry(
  session: BackupSession,
  feature: BackupFeature,
  entry: EncryptedEntry
): Promise<string | null> {
  if (entry.kdfParams !== session.kdfParams) {
    console.warn(`[backup] skipped a ${feature} entry with KDF parameters ${entry.kdfParams}`);
    return null;
  }
  try {
    return await decryptEntry(session.encKey, entry, blobCapOf(feature));
  } catch (error) {
    console.warn(`[backup] skipped a ${feature} entry that does not decrypt`, error);
    return null;
  }
}

/**
 * Upload the entries whose plaintext differs from the server copy this device
 * knows. Returns the entry keys the server acknowledged. An entry over the
 * feature's blob cap is skipped and logged.
 */
export function uploadEntries(
  session: BackupSession,
  feature: BackupFeature,
  outgoing: readonly OutgoingEntry[]
): Promise<string[]> {
  return enqueue('upload', async () => {
    // The task waited in the upload lane: the storage key may be zeroed by now.
    assertSessionLive(session);
    const featureState = session.state.features[feature];
    const cap = blobCapOf(feature);
    const pending: { entryKey: string; hashedKey: string; digest: string; entry: EncryptedEntry; size: number }[] = [];
    for (const item of outgoing) {
      const hashedKey = hashedKeyOf(session, item.entryKey);
      const digest = plaintextDigest(item.plaintext);
      if (featureState.entries[hashedKey]?.digest === digest) continue;
      const blobBytes = encryptedBlobLength(new TextEncoder().encode(item.plaintext).byteLength);
      if (blobBytes > cap) {
        console.warn(`[backup] a ${feature} entry of ${blobBytes} bytes is over the ${cap} byte cap; not uploaded`);
        continue;
      }
      const entry = await encryptEntry(session.encKey, item.plaintext, session.kdfParams);
      const size = hashedKey.length + entry.blob.length + 96;
      pending.push({ entryKey: item.entryKey, hashedKey, digest, entry, size });
    }

    const written: string[] = [];
    for (const batch of splitBatches(pending)) {
      const acks = await withSessionToken(session, token =>
        putEntries(
          token,
          feature,
          batch.map(item => ({ hashedKey: item.hashedKey, entry: item.entry }))
        )
      );
      assertSessionLive(session);
      for (const item of batch) {
        const ack = acks.find(candidate => candidate.hashedKey === item.hashedKey);
        if (ack === undefined) continue;
        featureState.entries[item.hashedKey] = {
          revision: ack.revision,
          updatedAt: ack.updatedAt,
          digest: item.digest
        };
        written.push(item.entryKey);
      }
      await persistBackupState(session.state);
    }
    return written;
  });
}

/** Split into batches of at most 100 entries and at most the request body budget. */
function splitBatches<T extends { size: number }>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    if (batch.length > 0 && (batch.length >= MAX_BATCH_ENTRIES || bytes + item.size > MAX_REQUEST_BODY_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += item.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
