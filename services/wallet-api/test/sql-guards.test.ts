/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import { afterEach, describe, expect, it } from '@jest/globals';

import { NONCE_INSERT_SQL, NONCE_SWEEP_SQL } from './fake-d1';
import { KDF_PARAMS, START_MS, blobBytes, hashedKey } from './harness';
import {
  DELETE_ENTRIES_OF_GENERATION,
  DELETE_PROFILE_OF_GENERATION,
  SET_SALT,
  SPEND_NONCE,
  UPSERT_ENTRY,
  UPSERT_PROFILE
} from '../src/sql';

// The fake in fake-d1.ts finds each statement by its text and enforces its guards in JavaScript, so a guard
// removed from the SQL would keep the route tests green. This block runs the production statements of
// src/sql.ts and routes/auth.ts on the schema of migrations/0001_init.sql in a real SQLite (node:sqlite,
// unflagged from Node 22.13), with the bindings the routes use. It is its own file, so a runtime without
// node:sqlite fails only this suite.
describe('production SQL on SQLite', () => {
  const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');
  const PROFILE = 'profile-1';
  const GENERATION = new Uint8Array(16).fill(1);
  const STALE_GENERATION = new Uint8Array(16).fill(2);
  const SALT = new Uint8Array(16).fill(3);
  const BLOB = blobBytes(40);
  const open: DatabaseSync[] = [];

  afterEach(() => {
    open.splice(0).forEach(db => db.close());
  });

  function database(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATION);
    open.push(db);
    return db;
  }

  const keyBytes = (index: number): Uint8Array => Uint8Array.from(Buffer.from(hashedKey(index), 'hex'));

  function makeProfile(db: DatabaseSync, generation = GENERATION): Record<string, SQLInputValue> | undefined {
    return db.prepare(UPSERT_PROFILE).get(PROFILE, new Uint8Array(33).fill(4), START_MS, generation);
  }

  function setSaltRow(db: DatabaseSync, generation = GENERATION): Record<string, SQLInputValue> | undefined {
    return db.prepare(SET_SALT).get(SALT, PROFILE, generation);
  }

  /** UPSERT_ENTRY with the bindings of writeEntries, and a small capacity so a test can fill a feature. */
  function upsert(
    db: DatabaseSync,
    key: number,
    { generation = GENERATION, feature = 'accounts', capacity = 3 } = {}
  ): Record<string, SQLInputValue> | undefined {
    return db.prepare(UPSERT_ENTRY).get(PROFILE, feature, keyBytes(key), 1, KDF_PARAMS, BLOB, capacity, generation);
  }

  function revisions(db: DatabaseSync, feature = 'accounts'): number[] {
    return db
      .prepare('SELECT revision FROM entries WHERE profile_id = ? AND feature = ? ORDER BY hashed_key')
      .all(PROFILE, feature)
      .map(row => Number(row.revision));
  }

  const CHECK = /CHECK constraint failed: revision >= 1/;

  it('keeps the generation and the salt of a profile, and takes the proposed generation after a delete', () => {
    const db = database();
    makeProfile(db);
    setSaltRow(db);
    const again = makeProfile(db, STALE_GENERATION);
    expect(again?.generation).toEqual(GENERATION);
    expect(again?.salt).toEqual(SALT);
    db.prepare(DELETE_ENTRIES_OF_GENERATION).run(PROFILE, GENERATION);
    expect(db.prepare(DELETE_PROFILE_OF_GENERATION).run(PROFILE, GENERATION).changes).toBe(1);
    const remade = makeProfile(db, STALE_GENERATION);
    expect(remade?.generation).toEqual(STALE_GENERATION);
    expect(remade?.salt).toBeNull();
  });

  it('sets the salt once, and never from a stale generation', () => {
    const db = database();
    makeProfile(db);
    expect(setSaltRow(db, STALE_GENERATION)).toBeUndefined();
    expect(setSaltRow(db)?.salt).toEqual(SALT);
    expect(db.prepare(SET_SALT).get(new Uint8Array(16).fill(9), PROFILE, GENERATION)).toBeUndefined();
    expect(db.prepare('SELECT salt FROM profiles WHERE profile_id = ?').get(PROFILE)?.salt).toEqual(SALT);
  });

  it('refuses an entry write while the salt is NULL', () => {
    const db = database();
    makeProfile(db);
    expect(() => upsert(db, 1)).toThrow(CHECK);
    expect(revisions(db)).toEqual([]);
  });

  it('refuses an insert and an update from a stale generation', () => {
    const db = database();
    makeProfile(db);
    setSaltRow(db);
    expect(upsert(db, 1)).toMatchObject({ revision: 1 });
    expect(() => upsert(db, 2, { generation: STALE_GENERATION })).toThrow(CHECK);
    expect(() => upsert(db, 1, { generation: STALE_GENERATION })).toThrow(CHECK);
    expect(revisions(db)).toEqual([1]);
  });

  it('refuses a new key in a full feature, and still updates a key it holds and fills another feature', () => {
    const db = database();
    makeProfile(db);
    setSaltRow(db);
    [1, 2, 3].forEach(key => upsert(db, key));
    expect(() => upsert(db, 4)).toThrow(CHECK);
    expect(upsert(db, 2)).toMatchObject({ revision: 2 });
    expect(upsert(db, 4, { feature: 'contacts' })).toMatchObject({ revision: 1 });
    expect(revisions(db)).toEqual([1, 2, 1]);
  });

  it('rolls back every earlier statement of a batch that one guard refuses', () => {
    const db = database();
    makeProfile(db);
    setSaltRow(db);
    [1, 2].forEach(key => upsert(db, key));
    db.exec('BEGIN');
    expect(() => {
      try {
        upsert(db, 1);
        upsert(db, 3);
        upsert(db, 4);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }).toThrow(CHECK);
    expect(revisions(db)).toEqual([1, 1]);
  });

  it('deletes nothing for a stale generation', () => {
    const db = database();
    makeProfile(db);
    setSaltRow(db);
    upsert(db, 1);
    expect(db.prepare(DELETE_ENTRIES_OF_GENERATION).run(PROFILE, STALE_GENERATION).changes).toBe(0);
    expect(db.prepare(DELETE_PROFILE_OF_GENERATION).run(PROFILE, STALE_GENERATION).changes).toBe(0);
    expect(revisions(db)).toEqual([1]);
  });

  it('refuses a row with revision 0', () => {
    const db = database();
    expect(() =>
      db
        .prepare(
          'INSERT INTO entries (profile_id, feature, hashed_key, revision, envelope, kdf_params, blob, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?)'
        )
        .run(PROFILE, 'accounts', keyBytes(1), KDF_PARAMS, BLOB, START_MS)
    ).toThrow(CHECK);
  });

  describe('auth nonces', () => {
    const KEY = new Uint8Array(33).fill(4);
    const OTHER_KEY = new Uint8Array(33).fill(5);
    const nonceBytes = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

    function insertNonce(db: DatabaseSync, fill: number, expiresAt: number, key = KEY): void {
      db.prepare(NONCE_INSERT_SQL).run(key, nonceBytes(fill), expiresAt);
    }

    function spend(db: DatabaseSync, fill: number, now: number, key = KEY): Record<string, SQLInputValue> | undefined {
      return db.prepare(SPEND_NONCE).get(key, nonceBytes(fill), now);
    }

    it('spends a nonce once', () => {
      const db = database();
      insertNonce(db, 1, START_MS + 1000);
      expect(spend(db, 1, START_MS)?.nonce).toEqual(nonceBytes(1));
      expect(spend(db, 1, START_MS)).toBeUndefined();
    });

    it('refuses a nonce at its expiry and spends it one ms before', () => {
      const db = database();
      insertNonce(db, 1, START_MS);
      insertNonce(db, 2, START_MS + 1);
      expect(spend(db, 1, START_MS)).toBeUndefined();
      expect(spend(db, 2, START_MS)?.nonce).toEqual(nonceBytes(2));
    });

    it('does not spend the nonce of another public key', () => {
      const db = database();
      insertNonce(db, 1, START_MS + 1000);
      expect(spend(db, 1, START_MS, OTHER_KEY)).toBeUndefined();
      expect(spend(db, 1, START_MS)?.nonce).toEqual(nonceBytes(1));
    });

    it('sweeps at most the limit of expired nonces, oldest first, and keeps one that expires now', () => {
      const db = database();
      [5, 1, 4, 2, 3].forEach(age => insertNonce(db, age, START_MS - age));
      insertNonce(db, 9, START_MS);
      expect(db.prepare(NONCE_SWEEP_SQL).run(START_MS, 3).changes).toBe(3);
      const left = db
        .prepare('SELECT expires_at FROM auth_nonces ORDER BY expires_at')
        .all()
        .map(row => Number(row.expires_at));
      expect(left).toEqual([START_MS - 2, START_MS - 1, START_MS]);
    });
  });
});
