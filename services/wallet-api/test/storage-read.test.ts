/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { featurePageSql } from './fake-d1';
import {
  KDF_PARAMS,
  SALT_HEX,
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
  sha256HexOf,
  textField,
  toBase64
} from './harness';
import type { Harness, Session } from './harness';
import { featureEtag, profileEtag } from '../src/etag';
import type { ProfileMetadataRow } from '../src/rows';

/** The feature ETag as the README defines it, computed without etag.ts. */
async function expectedFeatureEtag(
  saltHex: string,
  rows: readonly { key: string; revision: number }[]
): Promise<string> {
  const lines = rows
    .map(row => `${row.key}:${row.revision}`)
    .sort()
    .join('\n');
  return sha256HexOf(`${saltHex}\n${lines}`);
}

async function readPage(harness: Harness, session: Session, query: string): Promise<Response> {
  return send(harness, `/v1/storage/accounts${query}`, { token: session.token });
}

async function pageKeys(response: Response): Promise<{ keys: string[]; next: unknown; etag: string }> {
  const body = await bodyOf(response);
  return {
    keys: recordsField(body, 'entries').map(entry => textField(entry, 'hashedKey')),
    next: body.next,
    etag: textField(body, 'etag')
  };
}

/** Make a ready profile with `count` accounts entries, keys 1 to count. */
async function profileWithEntries(harness: Harness, count: number): Promise<Session> {
  const session = await readyProfile(harness);
  const keys = Array.from({ length: count }, (_unused, index) => hashedKey(index + 1));
  for (let start = 0; start < keys.length; start += 100) {
    expect((await putBatch(harness, session, 'accounts', keys.slice(start, start + 100))).status).toBe(200);
  }
  return session;
}

describe('feature read paging', () => {
  it('returns the entries of a feature with their metadata and decoded blob', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const entry = { envelope: 1, kdfParams: KDF_PARAMS, blob: toBase64(blobBytes(40, 3)) };
    await putEntry(harness, session, 'accounts', hashedKey(1), entry);
    const response = await readPage(harness, session, '');
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body).toEqual({
      etag: await expectedFeatureEtag(SALT_HEX, [{ key: hashedKey(1), revision: 1 }]),
      entries: [{ hashedKey: hashedKey(1), revision: 1, updatedAt: START_MS, entry }],
      next: null
    });
    expect(response.headers.get('ETag')).toBe(`"${textField(body, 'etag')}"`);
  });

  it('walks the pages with limit, after and next, ordered by hashed key', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    // Write the keys out of order. The read orders them.
    await putBatch(harness, session, 'accounts', [
      hashedKey(5),
      hashedKey(2),
      hashedKey(4),
      hashedKey(1),
      hashedKey(3)
    ]);
    const first = await pageKeys(await readPage(harness, session, '?limit=2'));
    expect(first.keys).toEqual([hashedKey(1), hashedKey(2)]);
    expect(first.next).toBe(hashedKey(2));
    const second = await pageKeys(await readPage(harness, session, `?after=${hashedKey(2)}&limit=2`));
    expect(second.keys).toEqual([hashedKey(3), hashedKey(4)]);
    expect(second.next).toBe(hashedKey(4));
    const last = await pageKeys(await readPage(harness, session, `?limit=2&after=${hashedKey(4)}`));
    expect(last.keys).toEqual([hashedKey(5)]);
    expect(last.next).toBeNull();
    // Every page carries the ETag of the complete feature.
    expect(new Set([first.etag, second.etag, last.etag]).size).toBe(1);
  });

  it('gives no next when the page holds exactly the remaining entries', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 3);
    const page = await pageKeys(await readPage(harness, session, '?limit=3'));
    expect(page.keys).toHaveLength(3);
    expect(page.next).toBeNull();
  });

  it('reads one row more than the limit to find the next page', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 1);
    await readPage(harness, session, '?limit=7');
    const page = harness.db.executed.find(statement => statement.sql === featurePageSql(false, false));
    expect(page?.values).toEqual([session.profileId, 'accounts', 8]);
  });

  it('returns 100 entries and a next key when no limit is given', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 101);
    const first = await pageKeys(await readPage(harness, session, ''));
    expect(first.keys).toHaveLength(100);
    expect(first.next).toBe(hashedKey(100));
    const second = await pageKeys(await readPage(harness, session, `?after=${hashedKey(100)}`));
    expect(second.keys).toEqual([hashedKey(101)]);
    expect(second.next).toBeNull();
  });

  it('accepts the limits 1 and 100', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 2);
    expect((await pageKeys(await readPage(harness, session, '?limit=1'))).keys).toEqual([hashedKey(1)]);
    expect((await pageKeys(await readPage(harness, session, '?limit=100'))).keys).toHaveLength(2);
  });

  it('returns the entries with updated_at at or after since, and the ETag of the complete feature', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    harness.dbClock.now = 1000;
    await putEntry(harness, session, 'accounts', hashedKey(1));
    harness.dbClock.now = 2000;
    await putEntry(harness, session, 'accounts', hashedKey(2));
    const all = await pageKeys(await readPage(harness, session, '?since=0'));
    expect(all.keys).toEqual([hashedKey(1), hashedKey(2)]);
    const boundary = await pageKeys(await readPage(harness, session, '?since=2000'));
    expect(boundary.keys).toEqual([hashedKey(2)]);
    expect(boundary.etag).toBe(all.etag);
    const none = await pageKeys(await readPage(harness, session, '?since=2001'));
    expect(none.keys).toEqual([]);
    expect(none.next).toBeNull();
    expect(none.etag).toBe(all.etag);
  });

  it('combines since, after and limit', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    harness.dbClock.now = 1000;
    await putEntry(harness, session, 'accounts', hashedKey(1));
    harness.dbClock.now = 2000;
    await putBatch(harness, session, 'accounts', [hashedKey(2), hashedKey(3), hashedKey(4)]);
    const page = await pageKeys(await readPage(harness, session, `?since=2000&after=${hashedKey(2)}&limit=1`));
    expect(page.keys).toEqual([hashedKey(3)]);
    expect(page.next).toBe(hashedKey(3));
  });

  it('reads only the feature of the route and only the profile of the token', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness, 1);
    const other = await readyProfile(harness, 2);
    await putEntry(harness, session, 'contacts', hashedKey(1));
    await putEntry(harness, other, 'accounts', hashedKey(2));
    const page = await pageKeys(await readPage(harness, session, ''));
    expect(page.keys).toEqual([]);
  });

  it.each([
    ['a repeated limit', '?limit=1&limit=2'],
    ['a repeated after', `?after=${hashedKey(1)}&after=${hashedKey(2)}`],
    ['a repeated since', '?since=1&since=2'],
    ['an unknown parameter', '?cursor=1'],
    ['an unknown parameter next to a known one', '?limit=1&page=2']
  ])('refuses %s', async (_name, query) => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const response = await readPage(harness, session, query);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'bad_request',
      message: 'The query parameters are since, after, limit, each at most once.'
    });
  });

  it.each(['0', '101', '-1', '01', '1.5', 'ten', ''])('refuses the limit %j', async limit => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const response = await readPage(harness, session, `?limit=${limit}`);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual({ error: 'bad_request', message: 'limit must be 1 to 100.' });
  });

  it.each(['-1', '01', '1.5', '1e3', '9007199254740992', ''])('refuses the since %j', async since => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const response = await readPage(harness, session, `?since=${since}`);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'bad_request',
      message: 'since must be a Unix ms integer.'
    });
  });

  it.each([hashedKey(1).toUpperCase().replace(/0/g, 'A'), hashedKey(1).slice(1), 'g'.repeat(64)])(
    'refuses the after %j',
    async after => {
      const harness = createHarness();
      const session = await readyProfile(harness);
      const response = await readPage(harness, session, `?after=${after}`);
      expect(response.status).toBe(400);
      await expect(bodyOf(response)).resolves.toEqual({
        error: 'bad_request',
        message: 'after must be 64 lowercase hex characters.'
      });
    }
  );
});

describe('conditional feature read', () => {
  it.each([
    ['a quoted tag', (etag: string) => `"${etag}"`],
    ['a bare tag', (etag: string) => etag],
    ['a weak tag', (etag: string) => `W/"${etag}"`],
    ['a tag in a list', (etag: string) => `"other", "${etag}"`]
  ])('answers 304 with no body for %s', async (_name, header) => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 2);
    const { etag } = await pageKeys(await readPage(harness, session, ''));
    const response = await send(harness, '/v1/storage/accounts', {
      token: session.token,
      headers: { 'If-None-Match': header(etag) }
    });
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe(`"${etag}"`);
    await expect(response.text()).resolves.toBe('');
  });

  it('answers 304 on a later page too, since every page carries the feature ETag', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 3);
    const { etag } = await pageKeys(await readPage(harness, session, '?limit=1'));
    const response = await send(harness, `/v1/storage/accounts?after=${hashedKey(1)}&limit=1`, {
      token: session.token,
      headers: { 'If-None-Match': `"${etag}"` }
    });
    expect(response.status).toBe(304);
  });

  it('answers 200 after a write moved the ETag', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 2);
    const { etag } = await pageKeys(await readPage(harness, session, ''));
    await putEntry(harness, session, 'accounts', hashedKey(1));
    const response = await send(harness, '/v1/storage/accounts', {
      token: session.token,
      headers: { 'If-None-Match': `"${etag}"` }
    });
    expect(response.status).toBe(200);
    expect((await pageKeys(response)).etag).not.toBe(etag);
  });

  it('decides the 304 from hashed_key and revision only, not from the blob', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 2);
    const { etag } = await pageKeys(await readPage(harness, session, ''));
    harness.db.replaceBlob(session.profileId, 'accounts', hashedKey(1), blobBytes(64, 9));
    const response = await send(harness, '/v1/storage/accounts', {
      token: session.token,
      headers: { 'If-None-Match': `"${etag}"` }
    });
    expect(response.status).toBe(304);
  });

  it('answers 200 for an ETag that does not match', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 1);
    const response = await send(harness, '/v1/storage/accounts', {
      token: session.token,
      headers: { 'If-None-Match': '"0000"' }
    });
    expect(response.status).toBe(200);
  });
});

describe('ETag determinism', () => {
  it('hashes the salt hex and a newline for an empty feature', async () => {
    await expect(featureEtag('', [])).resolves.toBe(await sha256HexOf('\n'));
    await expect(featureEtag(SALT_HEX, [])).resolves.toBe(await sha256HexOf(`${SALT_HEX}\n`));
  });

  it('hashes the lines "hashed_key:revision" sorted by key, whatever the input order', async () => {
    const rows = [
      { hashedKey: hashedKey(3), revision: 1 },
      { hashedKey: hashedKey(1), revision: 4 },
      { hashedKey: hashedKey(2), revision: 2 }
    ];
    const expected = await sha256HexOf(`${SALT_HEX}\n${hashedKey(1)}:4\n${hashedKey(2)}:2\n${hashedKey(3)}:1`);
    await expect(featureEtag(SALT_HEX, rows)).resolves.toBe(expected);
    await expect(featureEtag(SALT_HEX, [...rows].reverse())).resolves.toBe(expected);
  });

  it('changes with a revision and with the salt', async () => {
    const rows = [{ hashedKey: hashedKey(1), revision: 1 }];
    const base = await featureEtag(SALT_HEX, rows);
    await expect(featureEtag(SALT_HEX, [{ hashedKey: hashedKey(1), revision: 2 }])).resolves.not.toBe(base);
    await expect(featureEtag('', rows)).resolves.not.toBe(base);
  });

  it('hashes the profile lines "feature:hashed_key:revision" sorted by feature, then by key', async () => {
    const rows: ProfileMetadataRow[] = [
      { feature: 'history', hashedKey: hashedKey(1), revision: 1 },
      { feature: 'accounts', hashedKey: hashedKey(2), revision: 3 },
      { feature: 'accounts', hashedKey: hashedKey(1), revision: 2 }
    ];
    const expected = await sha256HexOf(
      `${SALT_HEX}\naccounts:${hashedKey(1)}:2\naccounts:${hashedKey(2)}:3\nhistory:${hashedKey(1)}:1`
    );
    await expect(profileEtag(SALT_HEX, rows)).resolves.toBe(expected);
  });

  it('serves the same ETag for the same metadata on two reads', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 3);
    const first = await pageKeys(await readPage(harness, session, ''));
    const second = await pageKeys(await readPage(harness, session, ''));
    expect(second.etag).toBe(first.etag);
    expect(first.etag).toBe(
      await expectedFeatureEtag(
        SALT_HEX,
        [1, 2, 3].map(index => ({ key: hashedKey(index), revision: 1 }))
      )
    );
  });

  it('hashes an empty salt while the salt is NULL', async () => {
    const harness = createHarness();
    const session = await logIn(harness, privateKey(1));
    const page = await pageKeys(await readPage(harness, session, ''));
    expect(page.etag).toBe(await sha256HexOf('\n'));
  });
});

describe('storage summary read', () => {
  it('returns the full-profile ETag and the ETag of every feature', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    await putEntry(harness, session, 'accounts', hashedKey(2));
    await putEntry(harness, session, 'accounts', hashedKey(2));
    await putEntry(harness, session, 'history', hashedKey(1));
    const response = await send(harness, '/v1/storage', { token: session.token });
    expect(response.status).toBe(200);
    const profile = await sha256HexOf(`${SALT_HEX}\naccounts:${hashedKey(2)}:2\nhistory:${hashedKey(1)}:1`);
    await expect(bodyOf(response)).resolves.toEqual({
      etag: profile,
      features: {
        accounts: { etag: await expectedFeatureEtag(SALT_HEX, [{ key: hashedKey(2), revision: 2 }]) },
        contacts: { etag: await sha256HexOf(`${SALT_HEX}\n`) },
        history: { etag: await expectedFeatureEtag(SALT_HEX, [{ key: hashedKey(1), revision: 1 }]) }
      }
    });
    expect(response.headers.get('ETag')).toBe(`"${profile}"`);
    // The summary ETag of a feature is the ETag that its feature read serves.
    expect((await pageKeys(await readPage(harness, session, ''))).etag).toBe(
      await expectedFeatureEtag(SALT_HEX, [{ key: hashedKey(2), revision: 2 }])
    );
  });

  it('answers 304 for the full-profile ETag and 200 after a write', async () => {
    const harness = createHarness();
    const session = await profileWithEntries(harness, 1);
    const etag = textField(await bodyOf(await send(harness, '/v1/storage', { token: session.token })), 'etag');
    const unchanged = await send(harness, '/v1/storage', { token: session.token, headers: { 'If-None-Match': etag } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('ETag')).toBe(`"${etag}"`);
    await putEntry(harness, session, 'contacts', hashedKey(9));
    const changed = await send(harness, '/v1/storage', { token: session.token, headers: { 'If-None-Match': etag } });
    expect(changed.status).toBe(200);
  });
});

describe('entry read', () => {
  it('returns one entry and 404 for a key that does not exist', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    const entry = { envelope: 1, kdfParams: KDF_PARAMS, blob: toBase64(blobBytes(30, 5)) };
    await putEntry(harness, session, 'history', hashedKey(1), entry);
    const found = await send(harness, `/v1/storage/history/${hashedKey(1)}`, { token: session.token });
    expect(found.status).toBe(200);
    await expect(bodyOf(found)).resolves.toEqual({ hashedKey: hashedKey(1), revision: 1, updatedAt: START_MS, entry });
    const missing = await send(harness, `/v1/storage/history/${hashedKey(2)}`, { token: session.token });
    expect(missing.status).toBe(404);
    await expect(bodyOf(missing)).resolves.toEqual({ error: 'not_found', message: 'The entry does not exist.' });
  });

  it('does not find an entry of another feature under the same key', async () => {
    const harness = createHarness();
    const session = await readyProfile(harness);
    await putEntry(harness, session, 'history', hashedKey(1));
    const response = await send(harness, `/v1/storage/accounts/${hashedKey(1)}`, { token: session.token });
    expect(response.status).toBe(404);
  });
});
