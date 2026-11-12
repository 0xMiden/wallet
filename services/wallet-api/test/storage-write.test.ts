/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { CHECK_FAILURE } from './fake-d1';
import {
  KDF_PARAMS,
  START_MS,
  blobBytes,
  bodyOf,
  createHarness,
  hashedKey,
  logIn,
  privateKey,
  putBatch,
  putEntry,
  readyProfile,
  recordsField,
  send,
  toBase64
} from './harness';
import type { Harness, Session } from './harness';
import { MAX_ENTRIES_PER_FEATURE } from '../src/constants';
import { isGuardFailure } from '../src/db';
import { batchWriteCost } from '../src/rate-limit';

const ENTRY_LIMIT = { error: 'entry_limit', message: 'A feature holds at most 1000 entries.' };

/** Put `count` entries in the feature directly, keys 1 to count. */
function fillFeature(harness: Harness, session: Session, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    harness.db.seedEntry({
      profileId: session.profileId,
      feature: 'accounts',
      hashedKey: hashedKey(index),
      revision: 1,
      envelope: 1,
      kdfParams: KDF_PARAMS,
      blob: blobBytes(28),
      updatedAt: START_MS
    });
  }
}

describe('single entry write', () => {
  it('starts a new entry at revision 1 and adds 1 on each update', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const created = await putEntry(harness, session, 'contacts', hashedKey(1));
    expect(created.status).toBe(200);
    await expect(bodyOf(created)).resolves.toEqual({ hashedKey: hashedKey(1), revision: 1, updatedAt: START_MS });
    const entry = { envelope: 1, kdfParams: KDF_PARAMS, blob: toBase64(blobBytes(32, 4)) };
    harness.dbClock.advance(5);
    const updated = await putEntry(harness, session, 'contacts', hashedKey(1), entry);
    await expect(bodyOf(updated)).resolves.toEqual({ hashedKey: hashedKey(1), revision: 2, updatedAt: START_MS + 5 });
    expect(harness.db.entriesOf(session.profileId, 'contacts')).toEqual([
      {
        profileId: session.profileId,
        feature: 'contacts',
        hashedKey: hashedKey(1),
        revision: 2,
        envelope: 1,
        kdfParams: KDF_PARAMS,
        blob: blobBytes(32, 4),
        updatedAt: START_MS + 5
      }
    ]);
  });

  it('never moves updated_at of a profile back when the database clock goes back', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    harness.dbClock.now = 5000;
    await putEntry(harness, session, 'accounts', hashedKey(1));
    harness.dbClock.now = 4000;
    const second = await putEntry(harness, session, 'history', hashedKey(2));
    await expect(bodyOf(second)).resolves.toMatchObject({ updatedAt: 5000 });
  });

  it('refuses a write while the salt is NULL', async () => {
    const harness = createHarness();
    const session = await logIn(harness, privateKey(1));
    const response = await putEntry(harness, session, 'accounts', hashedKey(1));
    expect(response.status).toBe(409);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'salt_not_set',
      message: 'Set the profile salt before you write entries.'
    });
    expect(harness.db.entriesOf(session.profileId, 'accounts')).toEqual([]);
  });

  it('refuses a new key in a full feature and accepts an update of a key it holds', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    fillFeature(harness, session, MAX_ENTRIES_PER_FEATURE);
    const refused = await putEntry(harness, session, 'accounts', hashedKey(MAX_ENTRIES_PER_FEATURE + 1));
    expect(refused.status).toBe(413);
    await expect(bodyOf(refused)).resolves.toEqual(ENTRY_LIMIT);
    const updated = await putEntry(harness, session, 'accounts', hashedKey(1));
    expect(updated.status).toBe(200);
    await expect(bodyOf(updated)).resolves.toMatchObject({ revision: 2 });
    // The limit is per feature.
    expect((await putEntry(harness, session, 'contacts', hashedKey(1))).status).toBe(200);
  });
});

describe('batch write', () => {
  it('upserts the entries in one batch and acknowledges them in request order', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    await putEntry(harness, session, 'history', hashedKey(2));
    const batchesBefore = harness.db.batches.length;
    const response = await putBatch(harness, session, 'history', [hashedKey(3), hashedKey(2), hashedKey(1)]);
    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({
      entries: [
        { hashedKey: hashedKey(3), revision: 1, updatedAt: START_MS },
        { hashedKey: hashedKey(2), revision: 2, updatedAt: START_MS },
        { hashedKey: hashedKey(1), revision: 1, updatedAt: START_MS }
      ]
    });
    expect(harness.db.batches.slice(batchesBefore)).toHaveLength(1);
    expect(harness.db.batches[batchesBefore]).toHaveLength(3);
  });

  it('accepts 100 entries in one batch', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const keys = Array.from({ length: 100 }, (_unused, index) => hashedKey(index + 1));
    const response = await putBatch(harness, session, 'accounts', keys);
    expect(response.status).toBe(200);
    expect(recordsField(await bodyOf(response), 'entries')).toHaveLength(100);
  });

  it('writes all entries or none: a batch that crosses the feature limit writes nothing', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    fillFeature(harness, session, MAX_ENTRIES_PER_FEATURE - 1);
    // The first item updates a held key, the second takes the last free place, the third finds the feature full.
    const keys = [hashedKey(1), hashedKey(MAX_ENTRIES_PER_FEATURE), hashedKey(MAX_ENTRIES_PER_FEATURE + 1)];
    const response = await putBatch(harness, session, 'accounts', keys);
    expect(response.status).toBe(413);
    await expect(bodyOf(response)).resolves.toEqual(ENTRY_LIMIT);
    const stored = harness.db.entriesOf(session.profileId, 'accounts');
    expect(stored).toHaveLength(MAX_ENTRIES_PER_FEATURE - 1);
    expect(stored[0]).toMatchObject({ hashedKey: hashedKey(1), revision: 1 });
  });

  it('refuses a batch while the salt is NULL', async () => {
    const harness = createHarness();
    const session = await logIn(harness, privateKey(1));
    const response = await putBatch(harness, session, 'accounts', [hashedKey(1), hashedKey(2)]);
    expect(response.status).toBe(409);
    await expect(bodyOf(response)).resolves.toMatchObject({ error: 'salt_not_set' });
  });
});

describe('batch write cost', () => {
  it.each([
    [0, 1],
    [1, 1],
    [9, 1],
    [10, 1],
    [11, 2],
    [20, 2],
    [21, 3],
    [99, 10],
    [100, 10]
  ])('charges %i entries as %i units', (entries, units) => {
    expect(batchWriteCost(entries)).toBe(units);
  });

  it('charges a batch of 25 entries 3 units of the write key', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const before = harness.storageLimit.keys.length;
    const keys = Array.from({ length: 25 }, (_unused, index) => hashedKey(index + 1));
    expect((await putBatch(harness, session, 'accounts', keys)).status).toBe(200);
    expect(harness.storageLimit.keys.slice(before)).toEqual(Array(3).fill(`write:${session.profileId}`));
  });

  it('charges nothing for a batch that fails validation', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const before = harness.storageLimit.keys.length;
    const response = await send(harness, '/v1/storage/accounts', {
      method: 'PUT',
      token: session.token,
      body: { entries: [] }
    });
    expect(response.status).toBe(400);
    expect(harness.storageLimit.keys.slice(before)).toEqual([]);
  });
});

describe('guard failure detection', () => {
  it('finds the CHECK failure in the error or in its cause', () => {
    expect(isGuardFailure(new Error(CHECK_FAILURE))).toBe(true);
    expect(isGuardFailure(new Error('D1_ERROR', { cause: new Error(CHECK_FAILURE) }))).toBe(true);
    expect(isGuardFailure(new Error('D1_ERROR: UNIQUE constraint failed'))).toBe(false);
    expect(isGuardFailure('CHECK constraint failed')).toBe(false);
  });
});
