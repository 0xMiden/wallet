/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import {
  SIGNING_KEY,
  bodyOf,
  createHarness,
  hashedKey,
  logIn,
  privateKey,
  putEntry,
  readyProfile,
  send,
  setSalt,
  wireEntry
} from './harness';
import type { Harness, Session } from './harness';
import { verifyToken } from '../src/token';

const PROFILE_GONE = { error: 'unauthorized', message: 'The profile does not exist. Log in again.' };
const OTHER_SALT = 'fedcba9876543210fedcba9876543210';

/** Make a profile with one entry, delete it, and log in again. Return the old and the new session. */
async function remadeProfile(harness: Harness): Promise<{ old: Session; fresh: Session }> {
  const old = await readyProfile(harness);
  expect((await putEntry(harness, old, 'accounts', hashedKey(1))).status).toBe(200);
  const deleted = await send(harness, '/v1/profile', { method: 'DELETE', token: old.token });
  expect(deleted.status).toBe(204);
  const fresh = await logIn(harness, privateKey(1));
  return { old, fresh };
}

async function expectProfileGone(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  await expect(bodyOf(response)).resolves.toEqual(PROFILE_GONE);
}

describe('profile delete', () => {
  it('deletes the profile and every entry, and answers 204 with no body', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    await putEntry(harness, session, 'accounts', hashedKey(1));
    await putEntry(harness, session, 'history', hashedKey(2));
    const response = await send(harness, '/v1/profile', { method: 'DELETE', token: session.token });
    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
    expect(harness.db.profile(session.profileId)).toBeUndefined();
    expect(harness.db.entriesOf(session.profileId, 'accounts')).toEqual([]);
    expect(harness.db.entriesOf(session.profileId, 'history')).toEqual([]);
  });

  it('refuses a second delete with the same token', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    expect((await send(harness, '/v1/profile', { method: 'DELETE', token: session.token })).status).toBe(204);
    await expectProfileGone(await send(harness, '/v1/profile', { method: 'DELETE', token: session.token }));
  });

  it('keeps the entries of another profile', async () => {
    const harness = createHarness();
    const first = await readyProfile(harness, 1);
    const second = await readyProfile(harness, 2);
    await putEntry(harness, second, 'accounts', hashedKey(1));
    await send(harness, '/v1/profile', { method: 'DELETE', token: first.token });
    expect(harness.db.entriesOf(second.profileId, 'accounts')).toHaveLength(1);
  });
});

describe('generation binding', () => {
  it('gives the profile that a login makes again the same id, a NULL salt and a new generation', async () => {
    const harness = createHarness();
    const { old, fresh } = await remadeProfile(harness);
    expect(fresh.profileId).toBe(old.profileId);
    expect(fresh.salt).toBeNull();
    const oldPrincipal = await verifyToken(SIGNING_KEY, old.token, harness.clock.now);
    const freshPrincipal = await verifyToken(SIGNING_KEY, fresh.token, harness.clock.now);
    expect(freshPrincipal.generation).not.toBe(oldPrincipal.generation);
    expect(harness.db.profile(fresh.profileId)?.generation).toBe(freshPrincipal.generation);
  });

  it('refuses every read with a token of the deleted generation', async () => {
    const harness = createHarness();
    const { old, fresh } = await remadeProfile(harness);
    expect((await setSalt(harness, fresh)).status).toBe(200);
    expect((await putEntry(harness, fresh, 'accounts', hashedKey(1))).status).toBe(200);
    await expectProfileGone(await send(harness, '/v1/storage', { token: old.token }));
    await expectProfileGone(await send(harness, '/v1/storage/accounts', { token: old.token }));
    await expectProfileGone(await send(harness, `/v1/storage/accounts/${hashedKey(1)}`, { token: old.token }));
    expect((await send(harness, '/v1/storage/accounts', { token: fresh.token })).status).toBe(200);
  });

  it('refuses an entry write with a token of the deleted generation and writes nothing', async () => {
    const harness = createHarness();
    const { old, fresh } = await remadeProfile(harness);
    expect((await setSalt(harness, fresh)).status).toBe(200);
    await expectProfileGone(await putEntry(harness, old, 'accounts', hashedKey(2)));
    const batch = await send(harness, '/v1/storage/contacts', {
      method: 'PUT',
      token: old.token,
      body: { entries: [{ hashedKey: hashedKey(3), entry: wireEntry() }] }
    });
    await expectProfileGone(batch);
    expect(harness.db.entriesOf(fresh.profileId, 'accounts')).toEqual([]);
    expect(harness.db.entriesOf(fresh.profileId, 'contacts')).toEqual([]);
  });

  it('refuses an update of a key that the new generation wrote', async () => {
    const harness = createHarness();
    const { old, fresh } = await remadeProfile(harness);
    expect((await setSalt(harness, fresh)).status).toBe(200);
    expect((await putEntry(harness, fresh, 'accounts', hashedKey(1))).status).toBe(200);
    await expectProfileGone(await putEntry(harness, old, 'accounts', hashedKey(1)));
    expect(harness.db.entriesOf(fresh.profileId, 'accounts')).toMatchObject([{ revision: 1 }]);
  });

  it('refuses a salt set with a token of the deleted generation and keeps the salt NULL', async () => {
    const harness = createHarness();
    const { old, fresh } = await remadeProfile(harness);
    await expectProfileGone(await setSalt(harness, old, OTHER_SALT));
    expect(harness.db.profile(fresh.profileId)?.salt).toBeNull();
  });

  it('refuses a delete with a token of the deleted generation and keeps the new profile', async () => {
    const harness = createHarness();
    const { old, fresh } = await remadeProfile(harness);
    expect((await setSalt(harness, fresh)).status).toBe(200);
    expect((await putEntry(harness, fresh, 'accounts', hashedKey(1))).status).toBe(200);
    await expectProfileGone(await send(harness, '/v1/profile', { method: 'DELETE', token: old.token }));
    expect(harness.db.profile(fresh.profileId)).toBeDefined();
    expect(harness.db.entriesOf(fresh.profileId, 'accounts')).toHaveLength(1);
  });

  it('refuses every route with a token of a profile that no login made again', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    expect((await send(harness, '/v1/profile', { method: 'DELETE', token: session.token })).status).toBe(204);
    await expectProfileGone(await send(harness, '/v1/storage', { token: session.token }));
    await expectProfileGone(await send(harness, '/v1/storage/history', { token: session.token }));
    await expectProfileGone(await putEntry(harness, session, 'history', hashedKey(1)));
    await expectProfileGone(await setSalt(harness, session));
    expect(harness.db.profile(session.profileId)).toBeUndefined();
  });
});
