import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  authorizeGoogle,
  createAuthorization,
  exchangeAuthorizationCode,
  parseArguments,
  persistCredentials,
  validateCallback
} from './authorize-google.mjs';

const chromeScope = 'https://www.googleapis.com/auth/chromewebstore';
const client = { client_id: 'client-id', client_secret: 'client-private-secret' };
const redirectUri = 'http://127.0.0.1:34567/oauth/callback';
const grant = () => createAuthorization({ clientId: client.client_id, redirectUri, scope: 'chrome' });
const tokenResponse = extra =>
  new Response(
    JSON.stringify({
      access_token: 'private-access-token',
      refresh_token: 'private-refresh-token',
      scope: chromeScope,
      ...extra
    })
  );
const record = { ...client, refresh_token: 'private-refresh-token', scope: chromeScope };

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'store-oauth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('CLI parsing requires one explicit store scope and distinct paths', () => {
  const args = [
    '--client',
    '/private/client.json',
    '--output',
    '/private/output.json',
    '--url-file',
    '/private/url.txt',
    '--scope',
    'chrome'
  ];
  assert.deepEqual(parseArguments(args), {
    client: '/private/client.json',
    output: '/private/output.json',
    urlFile: '/private/url.txt',
    scope: 'chrome',
    overwrite: false
  });
  assert.equal(parseArguments([...args, '--overwrite']).overwrite, true);
  for (const invalid of [
    args.slice(0, -2),
    [...args, '--scope', 'play'],
    [...args, '--unknown'],
    args.map(value => (value === 'chrome' ? 'chrome play' : value)),
    args.map(value => (value === '/private/output.json' ? '/private/client.json' : value))
  ]) {
    assert.throws(() => parseArguments(invalid));
  }
});

test('authorization URL pins endpoints, a single scope and S256 PKCE without exposing the verifier or secret', () => {
  const authorization = grant();
  const url = new URL(authorization.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('scope'), chromeScope);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(authorization.verifier).digest('base64url')
  );
  assert.match(authorization.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorization.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(authorization.state, grant().state);
  assert.equal(url.searchParams.has('code_verifier'), false);
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('authorization refuses a non-loopback, nonexact callback or combined scope', () => {
  for (const extra of [
    { redirectUri: 'https://untrusted.invalid/oauth/callback' },
    { redirectUri: 'http://localhost:1234/oauth/callback' },
    { redirectUri: 'http://127.0.0.1:1234/other' },
    { scope: 'chrome play' }
  ]) {
    assert.throws(() => createAuthorization({ clientId: client.client_id, redirectUri, scope: 'chrome', ...extra }));
  }
});

test('callback accepts only one code with the exact cryptographic state and path', () => {
  const authorization = grant();
  const callback = `/oauth/callback?state=${authorization.state}&code=private-code`;
  assert.equal(validateCallback(callback, authorization), 'private-code');
  for (const invalid of [
    '/oauth/callback?state=wrong&code=private-code',
    `/other?state=${authorization.state}&code=private-code`,
    `${callback}&state=${authorization.state}`,
    `${callback}&code=another-code`,
    `/oauth/callback?state=${authorization.state}&error=access_denied`,
    `/oauth/callback?state=${authorization.state}`,
    `https://untrusted.invalid${callback}`
  ]) {
    assert.throws(
      () => validateCallback(invalid, authorization),
      error => {
        assert.doesNotMatch(error.message, /private-code|another-code|access_denied/);
        return true;
      }
    );
  }
});

test('code exchange uses the fixed token endpoint, exact redirect and verifier and discards the access token', async () => {
  const authorization = grant();
  const calls = [];
  const result = await exchangeAuthorizationCode(
    client,
    { ...authorization, code: 'private-code' },
    {
      fetchImpl: async (...args) => {
        calls.push(args);
        return tokenResponse();
      }
    }
  );
  assert.deepEqual(result, record);
  assert.equal(result.access_token, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0][1].redirect, 'error');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0][1].body)), {
    client_id: client.client_id,
    client_secret: client.client_secret,
    grant_type: 'authorization_code',
    code: 'private-code',
    code_verifier: authorization.verifier,
    redirect_uri: redirectUri
  });
});

test('exchange rejects missing refresh tokens, extra scopes and redacts provider failures without retrying', async () => {
  for (const response of [
    tokenResponse({ refresh_token: undefined }),
    tokenResponse({ scope: `${chromeScope} https://www.googleapis.com/auth/drive` }),
    tokenResponse({ scope: undefined }),
    new Response('private-code private-access-token', { status: 400 }),
    new Response('private-refresh-token malformed JSON'),
    new Response(null, { status: 302 }),
    new Error('client-private-secret transport failure')
  ]) {
    let calls = 0;
    await assert.rejects(
      exchangeAuthorizationCode(
        client,
        { ...grant(), code: 'private-code' },
        {
          fetchImpl: async () => {
            calls++;
            if (response instanceof Error) throw response;
            return response;
          }
        }
      ),
      error => {
        assert.doesNotMatch(
          error.message,
          /private-code|private-access-token|private-refresh-token|client-private-secret/
        );
        return true;
      }
    );
    assert.equal(calls, 1);
  }
});

test('credentials are written owner-private and conflicting credentials are never overwritten implicitly', async t => {
  const directory = await temporary(t);
  const output = join(directory, 'private', 'credentials.json');
  await persistCredentials(output, record);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), record);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
  await persistCredentials(output, { ...record });
  const changed = { ...record, refresh_token: 'different-refresh-token' };
  await assert.rejects(persistCredentials(output, changed), /existing|overwrite/);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), record);
  await persistCredentials(output, changed, { overwrite: true });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), changed);
});

test('credential persistence refuses an exposed parent or a final symlink', async t => {
  const directory = await temporary(t);
  const output = join(directory, 'credentials.json');
  await chmod(directory, 0o755);
  await assert.rejects(persistCredentials(output, record), /private|permission/);
  await chmod(directory, 0o700);
  const target = join(directory, 'target.json');
  await writeFile(target, JSON.stringify(record), { mode: 0o600 });
  await symlink(target, output);
  await assert.rejects(persistCredentials(output, record, { overwrite: true }));
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), record);
});

function fakeServer() {
  const server = new EventEmitter();
  server.listen = (options, ready) => {
    server.listenOptions = options;
    queueMicrotask(ready);
    return server;
  };
  server.address = () => ({ address: '127.0.0.1', port: 34567 });
  server.close = done => {
    server.closed = true;
    queueMicrotask(() => done?.());
  };
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {};
  return server;
}

function fakeResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    }
  };
}

async function flowFixture(t, fetchImpl = async () => tokenResponse()) {
  const directory = await temporary(t);
  const options = {
    client: join(directory, 'client.json'),
    output: join(directory, 'output.json'),
    urlFile: join(directory, 'url.txt'),
    scope: 'chrome'
  };
  await writeFile(options.client, JSON.stringify({ installed: client }), { mode: 0o600 });
  const server = fakeServer();
  let callback;
  let deadline;
  let duration;
  let resolveReady;
  const ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  const task = authorizeGoogle(options, {
    fetchImpl,
    createServerImpl: handler => {
      callback = handler;
      return server;
    },
    setTimeoutImpl: (handler, milliseconds) => {
      deadline = handler;
      duration = milliseconds;
      return { unref() {} };
    },
    clearTimeoutImpl: () => {},
    onReady: value => resolveReady(value)
  });
  task.catch(() => {});
  await ready;
  const url = new URL(await readFile(options.urlFile, 'utf8'));
  return { directory, options, server, task, url, duration, deadline, callback };
}

test('one-shot flow binds a random loopback port and persists only after the matching callback', async t => {
  let exchanges = 0;
  const flow = await flowFixture(t, async () => {
    exchanges++;
    return tokenResponse();
  });
  assert.deepEqual(flow.server.listenOptions, { host: '127.0.0.1', port: 0 });
  assert.equal(flow.duration, 600000);
  assert.equal((await stat(flow.options.urlFile)).mode & 0o777, 0o600);
  const response = fakeResponse();
  await flow.callback(
    {
      method: 'GET',
      headers: { host: '127.0.0.1:34567' },
      url: `/oauth/callback?state=${flow.url.searchParams.get('state')}&code=private-code`
    },
    response
  );
  await flow.task;
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /private-code|private-access-token|private-refresh-token/);
  assert.deepEqual(JSON.parse(await readFile(flow.options.output, 'utf8')), record);
  assert.equal(exchanges, 1);
  assert.equal(flow.server.closed, true);
});

test('a mismatched callback terminates the flow without exchanging or persisting credentials', async t => {
  let exchanges = 0;
  const flow = await flowFixture(t, async () => {
    exchanges++;
    return tokenResponse();
  });
  const response = fakeResponse();
  await flow.callback(
    { method: 'GET', headers: { host: '127.0.0.1:34567' }, url: '/oauth/callback?state=wrong&code=private-code' },
    response
  );
  await assert.rejects(flow.task);
  assert.equal(response.statusCode, 400);
  assert.equal(exchanges, 0);
  await assert.rejects(readFile(flow.options.output), { code: 'ENOENT' });
  assert.equal(flow.server.closed, true);
});

test('timeout closes the listener and an unrelated path never consumes the OAuth callback', async t => {
  const flow = await flowFixture(t);
  const response = fakeResponse();
  await flow.callback({ method: 'GET', headers: { host: '127.0.0.1:34567' }, url: '/favicon.ico' }, response);
  assert.equal(response.statusCode, 404);
  assert.notEqual(flow.server.closed, true);
  await flow.deadline();
  await assert.rejects(flow.task, /timed out/);
  assert.equal(flow.server.closed, true);
});

test('concurrent callbacks exchange only once and a replay after completion is refused', async t => {
  let resolveExchange;
  let exchanges = 0;
  let exchangeStarted;
  const started = new Promise(resolve => {
    exchangeStarted = resolve;
  });
  const flow = await flowFixture(t, () => {
    exchanges++;
    exchangeStarted();
    return new Promise(resolve => {
      resolveExchange = resolve;
    });
  });
  const request = {
    method: 'GET',
    headers: { host: '127.0.0.1:34567' },
    url: `/oauth/callback?state=${flow.url.searchParams.get('state')}&code=private-code`
  };
  const first = fakeResponse();
  const pending = flow.callback(request, first);
  await started;
  const duplicate = fakeResponse();
  await flow.callback(request, duplicate);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(exchanges, 1);
  resolveExchange(tokenResponse());
  await pending;
  await flow.task;
  const replay = fakeResponse();
  await flow.callback(request, replay);
  assert.equal(replay.statusCode, 410);
  assert.equal(exchanges, 1);
});

test('timed-out token exchange cannot later persist a credential', async t => {
  let resolveExchange;
  let exchangeStarted;
  const started = new Promise(resolve => {
    exchangeStarted = resolve;
  });
  const flow = await flowFixture(t, () => {
    exchangeStarted();
    return new Promise(resolve => {
      resolveExchange = resolve;
    });
  });
  const pending = flow.callback(
    {
      method: 'GET',
      headers: { host: '127.0.0.1:34567' },
      url: `/oauth/callback?state=${flow.url.searchParams.get('state')}&code=private-code`
    },
    fakeResponse()
  );
  await started;
  await flow.deadline();
  await assert.rejects(flow.task, /timed out/);
  resolveExchange(tokenResponse());
  await pending;
  await assert.rejects(readFile(flow.options.output), { code: 'ENOENT' });
});

test('a callback for a non-loopback host cannot exchange a code', async t => {
  let exchanges = 0;
  const flow = await flowFixture(t, async () => {
    exchanges++;
    return tokenResponse();
  });
  const response = fakeResponse();
  await flow.callback(
    {
      method: 'GET',
      headers: { host: 'untrusted.invalid' },
      url: `/oauth/callback?state=${flow.url.searchParams.get('state')}&code=private-code`
    },
    response
  );
  await assert.rejects(flow.task);
  assert.equal(response.statusCode, 400);
  assert.equal(exchanges, 0);
});
