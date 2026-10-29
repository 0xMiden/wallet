// An in-memory fake of the D1 binding for the unit tests.
// It runs only the SQL statements that the Worker sends. It finds each statement by its exact text.
// It models the tables of migrations/0001_init.sql. An unknown statement throws, so a changed query fails the tests.
import { bytesToHex, hexToBytes } from '../src/encoding';
import {
  DELETE_ENTRIES_OF_GENERATION,
  DELETE_PROFILE_OF_GENERATION,
  ENTRY_COLUMNS,
  PROFILE_METADATA,
  PROFILE_STATE,
  SET_SALT,
  SPEND_NONCE,
  UPSERT_ENTRY,
  UPSERT_PROFILE
} from '../src/sql';

/** The inline statements of db.ts and routes/auth.ts. Keep them equal to the source text. */
export const FEATURE_METADATA_SQL =
  'SELECT hashed_key, revision FROM entries WHERE profile_id = ? AND feature = ? ORDER BY hashed_key';
export const NONCE_SWEEP_SQL =
  'DELETE FROM auth_nonces WHERE rowid IN (SELECT rowid FROM auth_nonces WHERE expires_at < ? ORDER BY expires_at LIMIT ?)';
export const NONCE_INSERT_SQL = 'INSERT INTO auth_nonces (public_key, nonce, expires_at) VALUES (?, ?, ?)';
const ENTRY_SQL = `${ENTRY_COLUMNS} WHERE profile_id = ? AND feature = ? AND hashed_key = ?`;

/** The text of a feature page read, as featureEntriesStatement builds it. */
export function featurePageSql(since: boolean, after: boolean): string {
  const conditions = ['profile_id = ?', 'feature = ?'];
  if (since) conditions.push('updated_at >= ?');
  if (after) conditions.push('hashed_key > ?');
  return `${ENTRY_COLUMNS} WHERE ${conditions.join(' AND ')} ORDER BY hashed_key LIMIT ?`;
}

/** The text of the CHECK failure that D1 reports for revision 0. */
export const CHECK_FAILURE = 'D1_ERROR: CHECK constraint failed: revision >= 1: SQLITE_CONSTRAINT';

/** A profile row. The BLOB columns are lowercase hex. */
export interface ProfileRecord {
  profileId: string;
  syncPublicKey: string;
  salt: string | null;
  generation: string;
  createdAt: number;
  lastSeenAt: number;
}

/** An entry row. The hashed key is lowercase hex, so string order is BLOB order. */
export interface EntryRecord {
  profileId: string;
  feature: string;
  hashedKey: string;
  revision: number;
  envelope: number;
  kdfParams: number;
  blob: Uint8Array;
  updatedAt: number;
}

export interface NonceRecord {
  rowid: number;
  publicKey: string;
  nonce: string;
  expiresAt: number;
}

/** A D1 cell. D1 returns a BLOB as an array of numbers. */
type Cell = string | number | number[] | null;
type Row = Record<string, Cell>;

interface Outcome {
  rows: Row[];
  changes: number;
}

interface Tables {
  profiles: Map<string, ProfileRecord>;
  entries: EntryRecord[];
  nonces: NonceRecord[];
  nextRowid: number;
}

/** One statement that the fake executed, with its bound values. */
export interface ExecutedStatement {
  sql: string;
  values: readonly unknown[];
}

function blobCell(hex: string | null): number[] | null {
  return hex === null ? null : Array.from(hexToBytes(hex));
}

function textAt(values: readonly unknown[], index: number): string {
  const value = values[index];
  if (typeof value !== 'string') throw new Error(`Bound value ${index} is not TEXT`);
  return value;
}

function integerAt(values: readonly unknown[], index: number): number {
  const value = values[index];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Bound value ${index} is not INTEGER`);
  return value;
}

function blobAt(values: readonly unknown[], index: number): Uint8Array {
  const value = values[index];
  if (!(value instanceof Uint8Array)) throw new Error(`Bound value ${index} is not a BLOB`);
  return value;
}

const hexAt = (values: readonly unknown[], index: number): string => bytesToHex(blobAt(values, index));

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function byKey(left: EntryRecord, right: EntryRecord): number {
  return compareText(left.hashedKey, right.hashedKey);
}

function entryRow(entry: EntryRecord): Row {
  return {
    hashed_key: blobCell(entry.hashedKey),
    revision: entry.revision,
    envelope: entry.envelope,
    kdf_params: entry.kdfParams,
    blob: Array.from(entry.blob),
    updated_at: entry.updatedAt
  };
}

function meta(changes: number): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: 0,
    changed_db: changes > 0,
    changes
  };
}

function copyTables(tables: Tables): Tables {
  return {
    profiles: new Map([...tables.profiles].map(([id, profile]) => [id, { ...profile }])),
    entries: tables.entries.map(entry => ({ ...entry, blob: entry.blob.slice() })),
    nonces: tables.nonces.map(nonce => ({ ...nonce })),
    nextRowid: tables.nextRowid
  };
}

/** A prepared statement of the fake. bind() returns a new statement, as D1 does. */
export class FakeStatement implements D1PreparedStatement {
  constructor(
    private readonly database: FakeD1,
    readonly sql: string,
    readonly values: readonly unknown[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeStatement(this.database, this.sql, values);
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first(colName?: string): Promise<Row | null> {
    if (colName !== undefined) throw new Error('The fake does not read one column');
    const [row] = this.database.runAlone(this).rows;
    return row ?? null;
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  async run(): Promise<D1Result<Row>> {
    return this.database.resultOf(this.database.runAlone(this));
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  async all(): Promise<D1Result<Row>> {
    return this.database.resultOf(this.database.runAlone(this));
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw(): Promise<never> {
    return Promise.reject(new Error('The fake does not support raw()'));
  }
}

/** The fake database. `dbNow` is the database clock of the julianday expression in sql.ts. */
export class FakeD1 implements D1Database {
  private tables: Tables = { profiles: new Map(), entries: [], nonces: [], nextRowid: 1 };
  /** Every executed statement, in order. */
  readonly executed: ExecutedStatement[] = [];
  /** The SQL text of every batch, in order. */
  readonly batches: string[][] = [];

  constructor(private readonly dbNow: () => number) {}

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this, query);
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  async batch(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> {
    const fakes = statements.map(statement => {
      if (!(statement instanceof FakeStatement)) throw new Error('The batch holds a statement of another database');
      return statement;
    });
    this.batches.push(fakes.map(statement => statement.sql));
    const saved = copyTables(this.tables);
    try {
      return fakes.map(statement => this.resultOf(this.execute(statement)));
    } catch (error) {
      // D1 rolls back the full batch when one statement fails.
      this.tables = saved;
      throw error;
    }
  }

  exec(): Promise<D1ExecResult> {
    return Promise.reject(new Error('The fake does not support exec()'));
  }

  withSession(): D1DatabaseSession {
    throw new Error('The fake does not support sessions');
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('The fake does not support dump()'));
  }

  /** Run one statement outside a batch. One statement is atomic. */
  runAlone(statement: FakeStatement): Outcome {
    const saved = copyTables(this.tables);
    try {
      return this.execute(statement);
    } catch (error) {
      this.tables = saved;
      throw error;
    }
  }

  resultOf(outcome: Outcome): D1Result<Row> {
    return { success: true, meta: meta(outcome.changes), results: outcome.rows };
  }

  // ---------------------------------------------------------------- test access

  profile(profileId: string): ProfileRecord | undefined {
    const profile = this.tables.profiles.get(profileId);
    return profile === undefined ? undefined : { ...profile };
  }

  entriesOf(profileId: string, feature: string): EntryRecord[] {
    return this.tables.entries
      .filter(entry => entry.profileId === profileId && entry.feature === feature)
      .sort(byKey)
      .map(entry => ({ ...entry, blob: entry.blob.slice() }));
  }

  get nonces(): NonceRecord[] {
    return this.tables.nonces.map(nonce => ({ ...nonce }));
  }

  seedNonce(publicKey: string, nonce: string, expiresAt: number): void {
    this.tables.nonces.push({ rowid: this.tables.nextRowid, publicKey, nonce, expiresAt });
    this.tables.nextRowid += 1;
  }

  /** Put an entry row directly, without the upsert guard. */
  seedEntry(entry: EntryRecord): void {
    this.tables.entries.push({ ...entry, blob: entry.blob.slice() });
  }

  /** Change the blob of a stored entry. Keep its revision. */
  replaceBlob(profileId: string, feature: string, hashedKey: string, blob: Uint8Array): void {
    const entry = this.findEntry(profileId, feature, hashedKey);
    if (entry === undefined) throw new Error('No such entry');
    entry.blob = blob.slice();
  }

  // ---------------------------------------------------------------- execution

  private findEntry(profileId: string, feature: string, hashedKey: string): EntryRecord | undefined {
    return this.tables.entries.find(
      entry => entry.profileId === profileId && entry.feature === feature && entry.hashedKey === hashedKey
    );
  }

  private featureEntries(profileId: string, feature: string): EntryRecord[] {
    return this.tables.entries.filter(entry => entry.profileId === profileId && entry.feature === feature).sort(byKey);
  }

  private execute(statement: FakeStatement): Outcome {
    this.executed.push({ sql: statement.sql, values: statement.values });
    const { sql, values } = statement;
    switch (sql) {
      case PROFILE_STATE:
        return this.profileState(textAt(values, 0));
      case PROFILE_METADATA:
        return this.profileMetadata(textAt(values, 0));
      case FEATURE_METADATA_SQL:
        return this.featureMetadata(textAt(values, 0), textAt(values, 1));
      case ENTRY_SQL:
        return this.entry(textAt(values, 0), textAt(values, 1), hexAt(values, 2));
      case featurePageSql(false, false):
      case featurePageSql(true, false):
      case featurePageSql(false, true):
      case featurePageSql(true, true):
        return this.featurePage(sql, values);
      case UPSERT_ENTRY:
        return this.upsertEntry(values);
      case UPSERT_PROFILE:
        return this.upsertProfile(values);
      case SPEND_NONCE:
        return this.spendNonce(hexAt(values, 0), hexAt(values, 1), integerAt(values, 2));
      case SET_SALT:
        return this.setSalt(hexAt(values, 0), textAt(values, 1), hexAt(values, 2));
      case DELETE_ENTRIES_OF_GENERATION:
        return this.deleteEntries(textAt(values, 0), hexAt(values, 1));
      case DELETE_PROFILE_OF_GENERATION:
        return this.deleteProfile(textAt(values, 0), hexAt(values, 1));
      case NONCE_SWEEP_SQL:
        return this.sweepNonces(integerAt(values, 0), integerAt(values, 1));
      case NONCE_INSERT_SQL:
        return this.insertNonce(hexAt(values, 0), hexAt(values, 1), integerAt(values, 2));
      default:
        throw new Error(`The fake does not know this statement: ${sql}`);
    }
  }

  private profileState(profileId: string): Outcome {
    const profile = this.tables.profiles.get(profileId);
    const rows =
      profile === undefined ? [] : [{ salt: blobCell(profile.salt), generation: blobCell(profile.generation) }];
    return { rows, changes: 0 };
  }

  private profileMetadata(profileId: string): Outcome {
    const rows = this.tables.entries
      .filter(entry => entry.profileId === profileId)
      .sort((left, right) => compareText(left.feature, right.feature) || byKey(left, right))
      .map(entry => ({ feature: entry.feature, hashed_key: blobCell(entry.hashedKey), revision: entry.revision }));
    return { rows, changes: 0 };
  }

  private featureMetadata(profileId: string, feature: string): Outcome {
    const rows = this.featureEntries(profileId, feature).map(entry => ({
      hashed_key: blobCell(entry.hashedKey),
      revision: entry.revision
    }));
    return { rows, changes: 0 };
  }

  private entry(profileId: string, feature: string, hashedKey: string): Outcome {
    const entry = this.findEntry(profileId, feature, hashedKey);
    return { rows: entry === undefined ? [] : [entryRow(entry)], changes: 0 };
  }

  private featurePage(sql: string, values: readonly unknown[]): Outcome {
    const hasSince = sql.includes('updated_at >= ?');
    const hasAfter = sql.includes('hashed_key > ?');
    let index = 2;
    const since = hasSince ? integerAt(values, index++) : null;
    const after = hasAfter ? hexAt(values, index++) : null;
    const limit = integerAt(values, index);
    if (values.length !== index + 1) throw new Error('The page read has the wrong number of bound values');
    const rows = this.featureEntries(textAt(values, 0), textAt(values, 1))
      .filter(entry => since === null || entry.updatedAt >= since)
      .filter(entry => after === null || entry.hashedKey > after)
      .slice(0, limit)
      .map(entryRow);
    return { rows, changes: 0 };
  }

  private upsertEntry(values: readonly unknown[]): Outcome {
    const profileId = textAt(values, 0);
    const feature = textAt(values, 1);
    const hashedKey = hexAt(values, 2);
    const maxEntries = integerAt(values, 6);
    const generation = hexAt(values, 7);
    const profile = this.tables.profiles.get(profileId);
    const existing = this.findEntry(profileId, feature, hashedKey);
    const profileAccepts = profile !== undefined && profile.salt !== null && profile.generation === generation;
    const roomForKey = existing !== undefined || this.featureEntries(profileId, feature).length < maxEntries;
    // SQLite checks the CHECK constraint before the conflict, so a refused guard fails an update too.
    if (!profileAccepts || !roomForKey) throw new Error(CHECK_FAILURE);
    const latest = this.tables.entries
      .filter(entry => entry.profileId === profileId)
      .reduce((max, entry) => Math.max(max, entry.updatedAt), 0);
    const updatedAt = Math.max(this.dbNow(), latest);
    const envelope = integerAt(values, 3);
    const kdfParams = integerAt(values, 4);
    const blob = blobAt(values, 5).slice();
    if (existing === undefined) {
      this.tables.entries.push({ profileId, feature, hashedKey, revision: 1, envelope, kdfParams, blob, updatedAt });
      return { rows: [{ revision: 1, updated_at: updatedAt }], changes: 1 };
    }
    existing.revision += 1;
    existing.envelope = envelope;
    existing.kdfParams = kdfParams;
    existing.blob = blob;
    existing.updatedAt = updatedAt;
    return { rows: [{ revision: existing.revision, updated_at: updatedAt }], changes: 1 };
  }

  private upsertProfile(values: readonly unknown[]): Outcome {
    const profileId = textAt(values, 0);
    const now = integerAt(values, 2);
    const existing = this.tables.profiles.get(profileId);
    const profile: ProfileRecord =
      existing === undefined
        ? {
            profileId,
            syncPublicKey: hexAt(values, 1),
            salt: null,
            generation: hexAt(values, 3),
            createdAt: now,
            lastSeenAt: now
          }
        : { ...existing, lastSeenAt: now };
    this.tables.profiles.set(profileId, profile);
    const row = {
      sync_public_key: blobCell(profile.syncPublicKey),
      salt: blobCell(profile.salt),
      generation: blobCell(profile.generation)
    };
    return { rows: [row], changes: 1 };
  }

  private spendNonce(publicKey: string, nonce: string, now: number): Outcome {
    const index = this.tables.nonces.findIndex(
      record => record.publicKey === publicKey && record.nonce === nonce && record.expiresAt > now
    );
    if (index < 0) return { rows: [], changes: 0 };
    this.tables.nonces.splice(index, 1);
    return { rows: [{ nonce: blobCell(nonce) }], changes: 1 };
  }

  private setSalt(salt: string, profileId: string, generation: string): Outcome {
    const profile = this.tables.profiles.get(profileId);
    if (profile === undefined || profile.generation !== generation || profile.salt !== null) {
      return { rows: [], changes: 0 };
    }
    profile.salt = salt;
    return { rows: [{ salt: blobCell(salt) }], changes: 1 };
  }

  private deleteEntries(profileId: string, generation: string): Outcome {
    if (this.tables.profiles.get(profileId)?.generation !== generation) return { rows: [], changes: 0 };
    const before = this.tables.entries.length;
    this.tables.entries = this.tables.entries.filter(entry => entry.profileId !== profileId);
    return { rows: [], changes: before - this.tables.entries.length };
  }

  private deleteProfile(profileId: string, generation: string): Outcome {
    if (this.tables.profiles.get(profileId)?.generation !== generation) return { rows: [], changes: 0 };
    this.tables.profiles.delete(profileId);
    return { rows: [], changes: 1 };
  }

  private sweepNonces(now: number, limit: number): Outcome {
    const swept = new Set(
      this.tables.nonces
        .filter(record => record.expiresAt < now)
        .sort((left, right) => left.expiresAt - right.expiresAt || left.rowid - right.rowid)
        .slice(0, limit)
        .map(record => record.rowid)
    );
    this.tables.nonces = this.tables.nonces.filter(record => !swept.has(record.rowid));
    return { rows: [], changes: swept.size };
  }

  private insertNonce(publicKey: string, nonce: string, expiresAt: number): Outcome {
    if (this.tables.nonces.some(record => record.publicKey === publicKey && record.nonce === nonce)) {
      throw new Error('D1_ERROR: UNIQUE constraint failed: auth_nonces.public_key, auth_nonces.nonce');
    }
    this.seedNonce(publicKey, nonce, expiresAt);
    return { rows: [], changes: 1 };
  }
}

/** A fake rate limit binding. Each key has its own budget of successful calls. */
export class FakeRateLimit implements RateLimit {
  /** The key of every call, in order. */
  readonly keys: string[] = [];
  private readonly used = new Map<string, number>();
  private failure: Error | null = null;

  constructor(private budget = Number.POSITIVE_INFINITY) {}

  /** Set the number of successful calls of each key, from the next call on. */
  allow(budget: number): void {
    this.budget = budget;
    this.used.clear();
  }

  /** Make every later call throw this error. */
  failWith(error: Error): void {
    this.failure = error;
  }

  async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
    this.keys.push(key);
    if (this.failure !== null) throw this.failure;
    const used = this.used.get(key) ?? 0;
    if (used >= this.budget) return { success: false };
    this.used.set(key, used + 1);
    return { success: true };
  }
}
