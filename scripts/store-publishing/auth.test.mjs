import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApiClient, createAppleToken, googleAccessToken, loadPrivateJson } from './auth.mjs';

const appleKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const googleKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key => key.export({ type: 'pkcs8', format: 'pem' });
const scope = 'https://www.googleapis.com/auth/chromewebstore';
const endpoint = 'https://oauth2.googleapis.com/token';
const now = 1700000000;
const oauth = {
  client_id: 'client-id',
  client_secret: 'private-client-secret',
  refresh_token: 'private-refresh-token'
};
const account = {
  type: 'service_account',
  client_email: 'publisher@example.iam.gserviceaccount.com',
  private_key: pem(googleKeys.privateKey),
  private_key_id: 'key-id',
  token_uri: 'https://untrusted.invalid/token',
  sub: 'never-impersonate@example.com'
};
const json = body =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

function fetchQueue(...responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (...args) => {
      calls.push(args);
      assert.ok(responses.length, 'unexpected fetch');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    }
  };
}

test('private JSON loads only a regular owner-private credential file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'store-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credentials.json');
  await writeFile(file, JSON.stringify(oauth), { mode: 0o600 });
  assert.deepEqual(await loadPrivateJson(file), oauth);
  for (const mode of [0o644, 0o620, 0o601]) {
    await chmod(file, mode);
    await assert.rejects(loadPrivateJson(file), /private|permission/);
  }
});

test('private JSON rejects symlinks and directories without disclosing content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'store-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credentials.json');
  await writeFile(file, JSON.stringify(oauth), { mode: 0o600 });
  const link = join(directory, 'link.json');
  await symlink(file, link);
  await assert.rejects(loadPrivateJson(link), /credential|private/);
  const folder = join(directory, 'folder');
  await mkdir(folder, { mode: 0o700 });
  await assert.rejects(loadPrivateJson(folder), /credential|private/);
});

test('invalid credential JSON errors never echo the private document', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'store-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credentials.json');
  for (const text of ['private-client-secret INVALID', '[]', 'null']) {
    await writeFile(file, text, { mode: 0o600 });
    await assert.rejects(loadPrivateJson(file), error => {
      assert.doesNotMatch(error.message, /private-client-secret|INVALID/);
      return true;
    });
  }
});

test('Apple JWT uses ES256 P1363, the exact issuer and a ten-minute lifetime', () => {
  const token = createAppleToken({ keyId: 'APPLEKEY', issuerId: 'team-issuer', key: pem(appleKeys.privateKey) }, now);
  const [header, claims, signature] = token.split('.');
  assert.deepEqual(decode(header), { alg: 'ES256', kid: 'APPLEKEY', typ: 'JWT' });
  assert.deepEqual(decode(claims), { iss: 'team-issuer', iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.equal(
    verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: appleKeys.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    ),
    true
  );
});

test('Apple JWT accepts an existing private KeyObject and rejects incorrect algorithms or missing identity', () => {
  assert.equal(
    typeof createAppleToken({ keyId: 'APPLEKEY', issuerId: 'issuer', key: appleKeys.privateKey }, now),
    'string'
  );
  for (const extra of [
    { keyId: '' },
    { issuerId: '' },
    { key: pem(googleKeys.privateKey) },
    { key: 'private-malformed-key' }
  ]) {
    assert.throws(
      () => createAppleToken({ keyId: 'APPLEKEY', issuerId: 'issuer', key: appleKeys.privateKey, ...extra }, now),
      error => {
        assert.doesNotMatch(error.message, /private-malformed-key/);
        return true;
      }
    );
  }
  assert.throws(() => createAppleToken({ keyId: 'KEY', issuerId: 'issuer', key: appleKeys.privateKey }, NaN));
});

test('Google service-account assertion is RS256 and cannot choose a token host or impersonate a user', async () => {
  const queue = fetchQueue(json({ access_token: 'issued-token', token_type: 'Bearer', scope }));
  assert.equal(await googleAccessToken(account, scope, { ...queue, nowSeconds: now }), 'issued-token');
  const [url, init] = queue.calls[0];
  assert.equal(url, endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(init.signal instanceof AbortSignal);
  const form = new URLSearchParams(init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = form.get('assertion').split('.');
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT', kid: 'key-id' });
  assert.deepEqual(decode(claims), { iss: account.client_email, scope, aud: endpoint, iat: now, exp: now + 3600 });
  assert.equal(
    verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), googleKeys.publicKey, Buffer.from(signature, 'base64url')),
    true
  );
});

test('Google OAuth refresh requests contain only the explicit scope and required credentials', async () => {
  const queue = fetchQueue(json({ access_token: 'issued-token', token_type: 'Bearer' }));
  assert.equal(
    await googleAccessToken({ ...oauth, token_uri: 'https://untrusted.invalid/token' }, scope, queue),
    'issued-token'
  );
  assert.equal(queue.calls[0][0], endpoint);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(queue.calls[0][1].body)), {
    grant_type: 'refresh_token',
    client_id: oauth.client_id,
    client_secret: oauth.client_secret,
    refresh_token: oauth.refresh_token,
    scope
  });
});

test('Google OAuth refresh supports a downloaded installed client with a separately stored refresh token', async () => {
  const queue = fetchQueue(json({ access_token: 'issued-token' }));
  assert.equal(
    await googleAccessToken(
      {
        installed: { client_id: oauth.client_id, client_secret: oauth.client_secret },
        refresh_token: oauth.refresh_token
      },
      scope,
      queue
    ),
    'issued-token'
  );
});

test('Google rejects malformed credentials, signing keys and scopes before networking', async () => {
  for (const [credentials, requestedScope] of [
    [{}, scope],
    [{ ...account, private_key: 'invalid-private-key' }, scope],
    [{ ...account, private_key: pem(appleKeys.privateKey) }, scope],
    [{ ...oauth, refresh_token: '' }, scope],
    [oauth, ''],
    [oauth, `${scope}\nother-scope`]
  ]) {
    const queue = fetchQueue();
    await assert.rejects(googleAccessToken(credentials, requestedScope, queue));
    assert.equal(queue.calls.length, 0);
  }
});

test('Google authentication failures redact provider bodies and do not retry', async () => {
  for (const response of [
    new Response('private-refresh-token rejected', { status: 400 }),
    new Error('private-client-secret leaked by transport'),
    new Response('private-client-secret invalid JSON', { status: 200 })
  ]) {
    const queue = fetchQueue(response);
    await assert.rejects(googleAccessToken(oauth, scope, queue), error => {
      assert.doesNotMatch(error.message, /private-refresh-token|private-client-secret/);
      return true;
    });
    assert.equal(queue.calls.length, 1);
  }
});

test('Google rejects redirects, missing tokens and differently scoped tokens', async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid/' } }),
    json({ access_token: '' }),
    json({ access_token: 'issued-token', token_type: 'Basic' }),
    json({ access_token: 'issued-token', token_type: 42 }),
    json({ access_token: 'issued-token', scope: `${scope} https://www.googleapis.com/auth/drive` })
  ]) {
    const queue = fetchQueue(response);
    await assert.rejects(googleAccessToken(oauth, scope, queue));
    assert.equal(queue.calls.length, 1);
  }
});

test('API client pins the origin and authorization and serializes JSON', async () => {
  const queue = fetchQueue(json({ data: 'accepted' }));
  const client = createApiClient({ origin: 'https://api.appstoreconnect.apple.com', token: 'private-token', ...queue });
  assert.deepEqual(await client.request('POST', '/v1/reviewSubmissions', { body: { data: 'request' } }), {
    data: 'accepted'
  });
  const [url, init] = queue.calls[0];
  assert.equal(url, 'https://api.appstoreconnect.apple.com/v1/reviewSubmissions');
  assert.equal(init.headers.get('Authorization'), 'Bearer private-token');
  assert.equal(init.headers.get('Content-Type'), 'application/json');
  assert.equal(init.body, JSON.stringify({ data: 'request' }));
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.ok(init.signal instanceof AbortSignal);
});

test('API client refuses unapproved origins, absolute paths and authorization overrides before fetching', async () => {
  for (const origin of [
    'http://api.appstoreconnect.apple.com',
    'https://untrusted.invalid',
    'https://api.appstoreconnect.apple.com/v1',
    'https://user:pass@api.appstoreconnect.apple.com'
  ]) {
    assert.throws(() => createApiClient({ origin, token: 'private-token' }));
  }
  for (const [path, init] of [
    ['https://untrusted.invalid/', {}],
    ['//untrusted.invalid/', {}],
    ['/\\untrusted.invalid/', {}],
    ['/v1/apps#fragment', {}],
    ['/v1/apps', { headers: { aUtHoRiZaTiOn: 'another-token' } }],
    ['/v1/apps', { headers: { Host: 'untrusted.invalid' } }]
  ]) {
    const queue = fetchQueue();
    const client = createApiClient({
      origin: 'https://api.appstoreconnect.apple.com',
      token: 'private-token',
      ...queue
    });
    await assert.rejects(client.request('GET', path, init));
    assert.equal(queue.calls.length, 0);
  }
});

test('API client sends raw upload bytes without serializing or overriding media headers', async () => {
  const queue = fetchQueue(json({ uploadState: 'SUCCEEDED' }));
  const client = createApiClient({ origin: 'https://chromewebstore.googleapis.com', token: 'private-token', ...queue });
  const bytes = new Uint8Array([1, 2, 3]);
  await client.request('POST', '/upload/v2/publishers/example/items/example:upload', {
    rawBody: bytes,
    headers: { 'Content-Type': 'application/zip' },
    timeoutMs: 120000
  });
  assert.equal(queue.calls[0][1].body, bytes);
  assert.equal(queue.calls[0][1].headers.get('Content-Type'), 'application/zip');
});

test('API client rejects body ambiguity and invalid timeout values', async () => {
  for (const init of [
    { body: {}, rawBody: new Uint8Array([1]) },
    { rawBody: 'not-raw-bytes' },
    { timeoutMs: 0 },
    { timeoutMs: 120001 },
    { timeoutMs: Infinity }
  ]) {
    const queue = fetchQueue();
    const client = createApiClient({
      origin: 'https://androidpublisher.googleapis.com',
      token: 'private-token',
      ...queue
    });
    await assert.rejects(client.request('POST', '/androidpublisher/v3/applications/app/edits', init));
    assert.equal(queue.calls.length, 0);
  }
});

test('API client handles 204 and exposes only numeric HTTP error status', async () => {
  const queue = fetchQueue(
    new Response(null, { status: 204 }),
    new Response('private-token provider details', { status: 403 })
  );
  const client = createApiClient({
    origin: 'https://androidpublisher.googleapis.com',
    token: 'private-token',
    ...queue
  });
  assert.equal(await client.request('DELETE', '/androidpublisher/v3/applications/app/edits/edit'), undefined);
  await assert.rejects(client.request('GET', '/androidpublisher/v3/applications/app'), error => {
    assert.equal(error.status, 403);
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /private-token|provider details/);
    return true;
  });
  assert.equal(queue.calls.length, 2);
});

test('API client errors redact transport and parser details and never retry', async () => {
  for (const response of [new Error('private-token from transport'), new Response('private-token invalid JSON')]) {
    const queue = fetchQueue(response);
    const client = createApiClient({
      origin: 'https://api.appstoreconnect.apple.com',
      token: 'private-token',
      ...queue
    });
    await assert.rejects(client.request('GET', '/v1/apps'), error => {
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    });
    assert.equal(queue.calls.length, 1);
  }
});

test('API client refuses redirects without following them', async () => {
  const queue = fetchQueue(new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid/' } }));
  const client = createApiClient({ origin: 'https://chromewebstore.googleapis.com', token: 'private-token', ...queue });
  await assert.rejects(client.request('GET', '/v2/item:fetchStatus'), /302|redirect/);
  assert.equal(queue.calls.length, 1);
  assert.equal(queue.calls[0][1].redirect, 'error');
});

test('API client applies bounded JSON and upload defaults and the explicit timeout', async t => {
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', value => {
    durations.push(value);
    return new AbortController().signal;
  });
  const queue = fetchQueue(json({}), json({}), json({}));
  const client = createApiClient({ origin: 'https://chromewebstore.googleapis.com', token: 'private-token', ...queue });
  await client.request('GET', '/v2/item:fetchStatus');
  await client.request('POST', '/upload/v2/item:upload', { rawBody: new Uint8Array([1]) });
  await client.request('POST', '/upload/v2/item:upload', { rawBody: new Uint8Array([1]), timeoutMs: 45000 });
  assert.deepEqual(durations, [30000, 120000, 45000]);
});

test('response redirect metadata and malformed URLs cannot leak provider details', async () => {
  for (const metadata of [
    { redirected: true, url: 'https://api.appstoreconnect.apple.com/v1/apps' },
    { redirected: false, url: 'https://untrusted.invalid/private-token' },
    { redirected: false, url: 'private-token malformed URL' }
  ]) {
    const queue = fetchQueue({ ...metadata, ok: true, status: 200, json: async () => ({}) });
    const client = createApiClient({
      origin: 'https://api.appstoreconnect.apple.com',
      token: 'private-token',
      ...queue
    });
    await assert.rejects(client.request('GET', '/v1/apps'), error => {
      assert.doesNotMatch(JSON.stringify(error), /private-token/);
      return true;
    });
    assert.equal(queue.calls.length, 1);
  }
});

test('Play failures retain only closed status and reason metadata, never provider messages', async () => {
  const client = createApiClient({
    origin: 'https://androidpublisher.googleapis.com',
    token: 'secret-token',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            status: 'PERMISSION_DENIED',
            message: 'secret-token private content',
            errors: [{ reason: 'forbidden' }, { reason: 'secret-token' }]
          }
        }),
        { status: 403 }
      )
  });
  await assert.rejects(client.request('GET', '/androidpublisher/v3/applications/app'), error => {
    assert.equal(error.status, 403);
    assert.equal(error.apiStatus, 'PERMISSION_DENIED');
    assert.deepEqual(error.apiReasons, ['forbidden']);
    assert.doesNotMatch(JSON.stringify(error), /secret-token|private content/);
    return true;
  });
});
