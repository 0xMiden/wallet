import { createPrivateKey, KeyObject, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const googleTokenEndpoint = 'https://oauth2.googleapis.com/token';
const apiOrigins = new Set([
  'https://api.appstoreconnect.apple.com',
  'https://androidpublisher.googleapis.com',
  'https://chromewebstore.googleapis.com'
]);
const epoch = () => Math.floor(Date.now() / 1000);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function failure(message, status) {
  const error = new Error(Number.isInteger(status) ? `${message} (HTTP ${status})` : message);
  if (Number.isInteger(status)) error.status = status;
  return error;
}

const apiStatuses = new Set([
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'RESOURCE_EXHAUSTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED'
]);
const apiReasons = new Set([
  'forbidden',
  'insufficientPermissions',
  'badRequest',
  'invalidArgument',
  'editExpired',
  'editNotFound',
  'invalidEdit',
  'changesInReview',
  'notFound',
  'rateLimitExceeded',
  'CHANGES_ALREADY_IN_REVIEW',
  'ONLY_ONE_COMPLETED_RELEASE'
]);
const appleCodes = new Set([
  'ENTITY_ERROR',
  'ENTITY_ERROR.ATTRIBUTE.REQUIRED',
  'ENTITY_ERROR.ATTRIBUTE.INVALID',
  'ENTITY_ERROR.RELATIONSHIP.INVALID',
  'ENTITY_ERROR.RELATIONSHIP.REQUIRED',
  'STATE_ERROR',
  'STATE_ERROR.INVALID',
  'PARAMETER_ERROR.INVALID',
  'FORBIDDEN_ERROR',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'RATE_LIMIT_EXCEEDED'
]);
const failureStages = new Set([
  'apple-submit-preflight',
  'apple-release-notes-update',
  'apple-build-link',
  'apple-review-create',
  'apple-review-item-create',
  'apple-review-submit',
  'store-operation',
  'play-submit-track-read',
  'play-submit-track-update',
  'play-submit-validate',
  'play-submit-commit',
  'play-status-releases',
  'play-inspect-edit',
  'play-inspect-track'
]);

export function safeStoreFailure(error) {
  return {
    stage: failureStages.has(error?.stage) ? error.stage : 'store-operation',
    ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
      ? { httpStatus: error.status }
      : {}),
    ...(Array.isArray(error?.appleCodes)
      ? { appleCodes: [...new Set(error.appleCodes.filter(code => appleCodes.has(code)))] }
      : {}),
    ...(apiStatuses.has(error?.apiStatus) ? { apiStatus: error.apiStatus } : {}),
    ...(Array.isArray(error?.apiReasons)
      ? { apiReasons: [...new Set(error.apiReasons.filter(reason => apiReasons.has(reason)))] }
      : {})
  };
}

async function apiFailure(response, label) {
  const error = failure(`${label} failed`, response.status);
  if (label !== 'Store API request' || !response.body?.getReader) return error;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) return error;
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const body = parsed?.error;
    if (Array.isArray(parsed?.errors))
      error.appleCodes = [...new Set(parsed.errors.map(item => item?.code).filter(code => appleCodes.has(code)))];
    if (apiStatuses.has(body?.status)) error.apiStatus = body.status;
    const reasons = [
      ...(Array.isArray(body?.errors) ? body.errors.map(item => item?.reason) : []),
      ...(Array.isArray(body?.details)
        ? body.details
            .filter(item => item?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')
            .map(item => item?.reason)
        : [])
    ];
    if (response.status === 400 && body?.message === 'Only one completed release is allowed.') {
      reasons.push('ONLY_ONE_COMPLETED_RELEASE');
    }
    error.apiReasons = [...new Set(reasons.filter(reason => apiReasons.has(reason)))];
  } catch {
    // Bodies and parse errors may contain credentials; keep only the HTTP status.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return error;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw failure(`${label} is required`);
  return value;
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure('A valid token timestamp is required');
  return value;
}

function signingKey(value, algorithm) {
  try {
    const key = value instanceof KeyObject ? value : createPrivateKey(value);
    if (key.type !== 'private' || key.asymmetricKeyType !== algorithm) throw failure('Incorrect key type');
    if (algorithm === 'ec' && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw failure('Incorrect EC curve');
    }
    if (algorithm === 'rsa' && key.asymmetricKeyDetails?.modulusLength < 2048) {
      throw failure('Insufficient RSA key size');
    }
    return key;
  } catch {
    throw failure('Invalid publishing signing key');
  }
}

/** Read a credential through its verified descriptor, refusing final-component symlinks. */
export async function loadPrivateJson(path) {
  let file;
  try {
    if (constants.O_NOFOLLOW === undefined) throw failure('Safe credential access is unavailable');
    // NONBLOCK prevents a named pipe from blocking before the regular-file check.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      info.size > 1024 * 1024
    ) {
      throw failure('Private credential permissions are required');
    }
    const value = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Invalid credential object');
    return value;
  } catch {
    // Parse and filesystem errors can contain paths or fragments of private JSON.
    throw failure('Unable to read a private credential JSON file; check ownership, permissions and format');
  } finally {
    await file?.close();
  }
}

/** Sign a short-lived team-key token using Apple's required raw P1363 signature. */
export function createAppleToken({ keyId, issuerId, key }, nowSeconds = epoch()) {
  requiredString(keyId, 'Apple key ID');
  requiredString(issuerId, 'Apple issuer ID');
  const now = timestamp(nowSeconds);
  const input = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({
    iss: issuerId,
    iat: now,
    exp: now + 600,
    aud: 'appstoreconnect-v1'
  })}`;
  const privateKey = signingKey(key, 'ec');
  const signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

async function responseFor(fetchImpl, url, init, label) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw failure(`${label} failed`);
  }
  let redirected;
  try {
    redirected = response.redirected || (response.url && new URL(response.url).origin !== new URL(url).origin);
  } catch {
    throw failure(`${label} returned invalid response metadata`);
  }
  if (redirected) {
    throw failure(`${label} refused a redirect`);
  }
  if (!response.ok) throw await apiFailure(response, label);
  return response;
}

async function responseJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw failure(`${label} returned an invalid JSON response`);
  }
}

/** Obtain only the caller-selected scope; credential token_uri and impersonation fields are ignored. */
export async function googleAccessToken(credentials, scope, { fetchImpl = fetch, nowSeconds = epoch() } = {}) {
  if (typeof scope !== 'string' || !/^\S+(?: \S+)*$/.test(scope)) throw failure('An explicit Google scope is required');
  if (!credentials || typeof credentials !== 'object') throw failure('Google publishing credentials are required');
  let form;
  if (credentials.type === 'service_account') {
    const issuer = requiredString(credentials.client_email, 'Google service-account email');
    const now = timestamp(nowSeconds);
    const header = { alg: 'RS256', typ: 'JWT' };
    if (credentials.private_key_id) header.kid = requiredString(credentials.private_key_id, 'Google key ID');
    const input = `${encode(header)}.${encode({ iss: issuer, scope, aud: googleTokenEndpoint, iat: now, exp: now + 3600 })}`;
    const signature = sign('RSA-SHA256', Buffer.from(input), signingKey(credentials.private_key, 'rsa'));
    form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${input}.${signature.toString('base64url')}`
    });
  } else {
    if (credentials.type && credentials.type !== 'authorized_user') throw failure('Unsupported Google credential type');
    const client = credentials.installed ?? credentials;
    form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: requiredString(client.client_id, 'Google client ID'),
      client_secret: requiredString(client.client_secret, 'Google client secret'),
      refresh_token: requiredString(credentials.refresh_token ?? client.refresh_token, 'Google refresh token'),
      scope
    });
  }
  const response = await responseFor(
    fetchImpl,
    googleTokenEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(30000)
    },
    'Google authorization'
  );
  const result = await responseJson(response, 'Google authorization');
  if (
    !result ||
    typeof result.access_token !== 'string' ||
    !/^\S+$/.test(result.access_token) ||
    (result.token_type !== undefined &&
      (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer')) ||
    (result.scope !== undefined &&
      (typeof result.scope !== 'string' ||
        [...new Set(result.scope.split(' '))].sort().join(' ') !== [...new Set(scope.split(' '))].sort().join(' ')))
  ) {
    throw failure('Google authorization returned an invalid or differently scoped access token');
  }
  return result.access_token;
}

/** Pin authentication to a supported store origin and make one bounded request with no retries. */
export function createApiClient({ origin, token, fetchImpl = fetch }) {
  let base;
  try {
    base = new URL(origin);
  } catch {
    throw failure('A supported store API origin is required');
  }
  if (
    !apiOrigins.has(base.origin) ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw failure('A supported store API origin is required');
  }
  if (typeof token !== 'string' || !/^\S+$/.test(token)) throw failure('A valid publishing access token is required');
  return {
    async request(method, path, { body, headers, rawBody, timeoutMs } = {}) {
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw failure('Unsupported store API method');
      if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\\\s#]/.test(path)) {
        throw failure('A relative store API path is required');
      }
      const url = new URL(path, base);
      if (url.origin !== base.origin) throw failure('Cross-origin store API requests are refused');
      if (body !== undefined && rawBody !== undefined) throw failure('Choose either JSON or raw upload content');
      if (rawBody !== undefined && !(rawBody instanceof Uint8Array)) throw failure('Raw upload bytes are required');
      if (method === 'GET' && (body !== undefined || rawBody !== undefined))
        throw failure('GET request content is refused');
      const timeout = timeoutMs ?? (rawBody === undefined ? 30000 : 120000);
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw failure('Invalid store API timeout');
      let requestHeaders;
      let requestBody;
      try {
        requestHeaders = new Headers(headers);
        for (const name of ['authorization', 'proxy-authorization', 'host', 'cookie']) {
          if (requestHeaders.has(name)) throw failure('Protected request headers cannot be overridden');
        }
        requestHeaders.set('Authorization', `Bearer ${token}`);
        if (body !== undefined) {
          requestHeaders.set('Content-Type', 'application/json');
          requestBody = JSON.stringify(body);
        } else {
          requestBody = rawBody;
        }
      } catch {
        throw failure('Invalid store API request headers or JSON content');
      }
      const response = await responseFor(
        fetchImpl,
        url.href,
        {
          method,
          headers: requestHeaders,
          ...(requestBody === undefined ? {} : { body: requestBody }),
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(timeout)
        },
        'Store API request'
      );
      return response.status === 204 ? undefined : responseJson(response, 'Store API request');
    }
  };
}
