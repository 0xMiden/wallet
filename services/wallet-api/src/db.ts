import { MAX_ENTRIES_PER_FEATURE } from './constants';
import { bytesToHex, encodeBase64, hexToBytes } from './encoding';
import { ApiError, notConfigured, profileGone } from './errors';
import { parseProfileStateRow, parseWriteRow, resultAt } from './rows';
import type { EntryRow } from './rows';
import { ENTRY_COLUMNS, PROFILE_STATE, UPSERT_ENTRY } from './sql';
import type { BatchItem, EntryView, Env, Feature, Principal, ReadPage, WriteAck } from './types';

export function database(env: Env): D1Database {
  if (!env.DB) throw notConfigured();
  return env.DB;
}

/** The salt and the generation of the profile. */
export function profileStatement(db: D1Database, profileId: string): D1PreparedStatement {
  return db.prepare(PROFILE_STATE).bind(profileId);
}

export function featureMetadataStatement(db: D1Database, profileId: string, feature: Feature): D1PreparedStatement {
  return db
    .prepare('SELECT hashed_key, revision FROM entries WHERE profile_id = ? AND feature = ? ORDER BY hashed_key')
    .bind(profileId, feature);
}

/**
 * One page of a feature, ordered by hashed key, with one row more than the page
 * holds so the caller knows whether a next page exists.
 */
export function featureEntriesStatement(
  db: D1Database,
  profileId: string,
  feature: Feature,
  page: ReadPage
): D1PreparedStatement {
  const conditions = ['profile_id = ?', 'feature = ?'];
  const values: (string | number | Uint8Array)[] = [profileId, feature];
  if (page.since !== null) {
    conditions.push('updated_at >= ?');
    values.push(page.since);
  }
  if (page.after !== null) {
    conditions.push('hashed_key > ?');
    values.push(hexToBytes(page.after));
  }
  values.push(page.limit + 1);
  return db.prepare(`${ENTRY_COLUMNS} WHERE ${conditions.join(' AND ')} ORDER BY hashed_key LIMIT ?`).bind(...values);
}

export function entryStatement(db: D1Database, profileId: string, feature: Feature, hashedKey: string): D1PreparedStatement {
  return db
    .prepare(`${ENTRY_COLUMNS} WHERE profile_id = ? AND feature = ? AND hashed_key = ?`)
    .bind(profileId, feature, hexToBytes(hashedKey));
}

/**
 * Return the salt hex of the profile the token belongs to. Refuse a token whose
 * profile is deleted, or made again since the token was issued (another generation).
 */
export function saltHexOf(result: D1Result<unknown>, principal: Principal): string {
  const [row] = result.results;
  if (row === undefined) throw profileGone();
  const { salt, generation } = parseProfileStateRow(row);
  if (bytesToHex(generation) !== principal.generation) throw profileGone();
  return salt === null ? '' : bytesToHex(salt);
}

export function entryView(row: EntryRow): EntryView {
  return {
    hashedKey: row.hashedKey,
    revision: row.revision,
    updatedAt: row.updatedAt,
    entry: { envelope: row.envelope, kdfParams: row.kdfParams, blob: encodeBase64(row.blob) }
  };
}

function messageOf(value: unknown): string | null {
  return value instanceof Error ? value.message : null;
}

export function isGuardFailure(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return [messageOf(error), messageOf(cause)].some(message => message?.includes('CHECK constraint failed') === true);
}

/** Find why the batch guard refused a write. */
export async function refusedWriteError(db: D1Database, principal: Principal): Promise<ApiError> {
  const row = await profileStatement(db, principal.profileId).first();
  if (row === null) return profileGone();
  const { salt, generation } = parseProfileStateRow(row);
  if (bytesToHex(generation) !== principal.generation) return profileGone();
  if (salt === null) return new ApiError(409, 'salt_not_set', 'Set the profile salt before you write entries.');
  return new ApiError(413, 'entry_limit', `A feature holds at most ${MAX_ENTRIES_PER_FEATURE} entries.`);
}

/**
 * Upsert the entries of one feature in one D1 batch. The batch writes all entries
 * or none. The generation check is inside each statement, so a profile delete that
 * lands between the token check and the batch refuses the whole batch.
 */
export async function writeEntries(
  db: D1Database,
  principal: Principal,
  feature: Feature,
  items: readonly BatchItem[]
): Promise<WriteAck[]> {
  const generation = hexToBytes(principal.generation);
  const statements = items.map(item =>
    db
      .prepare(UPSERT_ENTRY)
      .bind(
        principal.profileId,
        feature,
        hexToBytes(item.hashedKey),
        item.entry.envelope,
        item.entry.kdfParams,
        item.entry.blob,
        MAX_ENTRIES_PER_FEATURE,
        generation
      )
  );
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isGuardFailure(error)) throw await refusedWriteError(db, principal);
    throw error;
  }
  return items.map((item, index) => {
    const [row] = resultAt(results, index).results;
    const { revision, updatedAt } = parseWriteRow(row);
    return { hashedKey: item.hashedKey, revision, updatedAt };
  });
}
