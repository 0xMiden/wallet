import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPrivateJson } from './auth.mjs';

const callbackPath = '/oauth/callback';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const scopes = {
  chrome: 'https://www.googleapis.com/auth/chromewebstore',
  play: 'https://www.googleapis.com/auth/androidpublisher'
};

function requestedScope(value) {
  const scope = scopes[value] ?? value;
  if (!Object.values(scopes).includes(scope)) throw new Error('Choose one explicit chrome or play scope');
  return scope;
}

function required(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new Error(`${label} is required`);
  return value;
}

function clientCredentials(value) {
  const client = value?.installed ?? value;
  return {
    client_id: required(client?.client_id, 'Installed-app client ID'),
    client_secret: required(client?.client_secret, 'Installed-app client secret')
  };
}

function validatePaths(options) {
  const paths = ['client', 'output', 'urlFile'].map(key => resolve(required(options[key], key)));
  if (new Set(paths).size !== paths.length) throw new Error('Client, output and URL file paths must be distinct');
  requestedScope(options.scope);
  return options;
}

export function parseArguments(argv) {
  const options = { overwrite: false };
  const names = { '--client': 'client', '--output': 'output', '--url-file': 'urlFile', '--scope': 'scope' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error('Duplicate authorization option');
    seen.add(flag);
    if (flag === '--overwrite') options.overwrite = true;
    else if (names[flag] && argv[index + 1] && !argv[index + 1].startsWith('--')) options[names[flag]] = argv[++index];
    else throw new Error('Invalid authorization option');
  }
  return validatePaths(options);
}

function loopbackRedirect(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('An exact loopback callback is required');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== callbackPath ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('An exact loopback callback is required');
  return url.href;
}

export function createAuthorization({
  clientId,
  redirectUri,
  scope,
  state = randomBytes(32).toString('base64url'),
  verifier = randomBytes(32).toString('base64url')
}) {
  required(clientId, 'Installed-app client ID');
  const redirect = loopbackRedirect(redirectUri);
  const selectedScope = requestedScope(scope);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(state) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
    throw new Error('Invalid OAuth state or verifier');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: selectedScope,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false'
  }).toString();
  return { url: url.href, state, verifier, redirectUri: redirect, scope: selectedScope };
}

export function validateCallback(target, authorization) {
  let url;
  try {
    if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || /[\\\r\n#]/.test(target))
      throw new Error();
    url = new URL(target, authorization.redirectUri);
  } catch {
    throw new Error('Invalid authorization callback');
  }
  const states = url.searchParams.getAll('state');
  const codes = url.searchParams.getAll('code');
  const state = Buffer.from(states[0] ?? '');
  const expected = Buffer.from(authorization.state);
  if (
    url.pathname !== callbackPath ||
    url.origin !== new URL(authorization.redirectUri).origin ||
    url.searchParams.has('error') ||
    states.length !== 1 ||
    codes.length !== 1 ||
    state.length !== expected.length ||
    !timingSafeEqual(state, expected) ||
    !codes[0] ||
    codes[0].length > 4096 ||
    /\s/.test(codes[0])
  )
    throw new Error('Authorization callback verification failed');
  return codes[0];
}

export async function exchangeAuthorizationCode(credentials, authorization, { fetchImpl = fetch, signal } = {}) {
  const client = clientCredentials(credentials);
  const scope = requestedScope(authorization.scope);
  const redirectUri = loopbackRedirect(authorization.redirectUri);
  required(authorization.code, 'Authorization code');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(authorization.verifier)) throw new Error('Invalid OAuth verifier');
  let response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...client,
        grant_type: 'authorization_code',
        code: authorization.code,
        code_verifier: authorization.verifier,
        redirect_uri: redirectUri
      }).toString(),
      redirect: 'error',
      credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    });
    if (response.redirected || (response.url && new URL(response.url).origin !== new URL(tokenEndpoint).origin))
      throw new Error();
  } catch {
    throw new Error('Google authorization exchange failed');
  }
  if (!response.ok) {
    const error = new Error(`Google authorization exchange failed (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Google authorization returned an invalid response');
  }
  if (
    typeof result?.refresh_token !== 'string' ||
    !/^\S+$/.test(result.refresh_token) ||
    typeof result?.access_token !== 'string' ||
    !/^\S+$/.test(result.access_token) ||
    result.scope !== scope
  )
    throw new Error('Google authorization did not return the requested offline scope');
  return { ...client, refresh_token: result.refresh_token, scope };
}

async function ensurePrivateParent(path) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())
  ) {
    throw new Error('An owner-private output directory with permissions 700 is required');
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeExclusive(path, text) {
  await ensurePrivateParent(path);
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function persistCredentials(path, credentials, { overwrite = false } = {}) {
  await ensurePrivateParent(path);
  const record = {
    ...clientCredentials(credentials),
    refresh_token: required(credentials.refresh_token, 'Refresh token'),
    scope: requestedScope(credentials.scope)
  };
  if (await exists(path)) {
    const current = await loadPrivateJson(path);
    if (Object.keys(current).length === 4 && Object.keys(record).every(key => current[key] === record[key])) return;
    if (!overwrite) throw new Error('Refusing to overwrite different existing credentials');
    const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await writeExclusive(temporary, JSON.stringify(record) + '\n');
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  } else {
    await writeExclusive(path, JSON.stringify(record) + '\n');
  }
}

function reply(response, status, message) {
  response.statusCode = status;
  for (const [name, value] of Object.entries({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close'
  }))
    response.setHeader(name, value);
  response.end(message);
}

/** One listener, one callback, one exchange. Browser navigation stays with the caller. */
export async function authorizeGoogle(
  options,
  {
    fetchImpl = fetch,
    createServerImpl = createServer,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    onReady = ({ urlFile, port }) => console.log(JSON.stringify({ status: 'ready', urlFile, port }))
  } = {}
) {
  validatePaths(options);
  const client = clientCredentials(await loadPrivateJson(options.client));
  await ensurePrivateParent(options.output);
  await ensurePrivateParent(options.urlFile);
  if ((!options.overwrite && (await exists(options.output))) || (await exists(options.urlFile)))
    throw new Error('Authorization output already exists');
  const abort = new AbortController();
  return new Promise((resolveResult, rejectResult) => {
    let server;
    let timer;
    let authorization;
    let consumed = false;
    let settled = false;
    let urlCreated = false;
    const finish = async error => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      abort.abort();
      if (urlCreated) await unlink(options.urlFile).catch(() => {});
      if (server) {
        if (error) server.closeAllConnections?.();
        await new Promise(done => {
          try {
            server.close(() => done());
            server.closeIdleConnections?.();
          } catch {
            done();
          }
        });
      }
      if (error) rejectResult(error);
      else resolveResult({ output: options.output, scope: authorization.scope });
    };
    const handler = async (request, response) => {
      if (settled) {
        reply(response, 410, 'Authorization is no longer active.');
        return;
      }
      if (request.method !== 'GET') {
        reply(response, 405, 'Only GET is supported.');
        return;
      }
      if (!authorization) {
        reply(response, 503, 'Authorization is not ready.');
        return;
      }
      if (request.url?.split('?')[0] !== callbackPath) {
        reply(response, 404, 'Not found.');
        return;
      }
      if (consumed) {
        reply(response, 409, 'Authorization is already processing.');
        return;
      }
      consumed = true;
      try {
        if (request.headers?.host !== new URL(authorization.redirectUri).host) throw new Error('Invalid callback host');
        const code = validateCallback(request.url, authorization);
        const credentials = await exchangeAuthorizationCode(
          client,
          { ...authorization, code },
          { fetchImpl, signal: abort.signal }
        );
        if (settled) return;
        await persistCredentials(options.output, credentials, { overwrite: options.overwrite });
        if (settled) return;
        reply(response, 200, 'Authorization complete. You can close this tab.');
        await finish();
      } catch {
        if (settled) return;
        reply(response, 400, 'Authorization did not complete. Return to the release setup.');
        await finish(new Error('Google authorization did not complete'));
      }
    };
    try {
      server = createServerImpl(handler);
      server.on('error', () => {
        void finish(new Error('The loopback authorization listener failed'));
      });
      timer = setTimeoutImpl(() => finish(new Error('Google authorization timed out')), 600000);
      timer.unref?.();
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        void (async () => {
          const address = server.address();
          if (!address || typeof address === 'string' || !Number.isInteger(address.port)) throw new Error();
          authorization = createAuthorization({
            clientId: client.client_id,
            redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
            scope: options.scope
          });
          await writeExclusive(options.urlFile, authorization.url + '\n');
          urlCreated = true;
          if (settled) {
            await unlink(options.urlFile).catch(() => {});
            return;
          }
          await onReady({ urlFile: options.urlFile, port: address.port });
        })().catch(() => finish(new Error('The private authorization URL could not be prepared')));
      });
    } catch {
      void finish(new Error('The loopback authorization listener could not start'));
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await authorizeGoogle(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify({ status: 'authorized', output: result.output }));
  } catch {
    console.error('Google authorization did not complete. No credential values were printed.');
    process.exitCode = 1;
  }
}
