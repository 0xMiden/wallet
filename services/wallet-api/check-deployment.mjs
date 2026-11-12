// Post-deploy probe of the wallet-api Worker. The release workflow runs it after
// `wrangler deploy`. It checks that the deployed revision answers `/healthz`,
// that a configured wallet origin passes the CORS preflight, and that an
// unknown origin is refused. It makes no authenticated request and writes no
// data: a login would need a sync key, and the probe must not leave a profile.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FOREIGN_ORIGIN = 'https://wallet-api-probe.invalid';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const noStore = response => /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '');

/**
 * The base URL the wallet-config document names as `backup.baseUrl`: https, no
 * credentials, query, fragment or trailing slash. Returns the base as a string
 * with no trailing slash, so a path appends to it.
 */
export function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Set a public HTTPS wallet-api base URL');
  }
  if (
    typeof value !== 'string' ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.endsWith('/')
  ) {
    throw new Error('Wallet-api base URL must use HTTPS with no credentials, query, fragment or trailing slash');
  }
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
}

export function validateOrigins(origins) {
  if (
    !Array.isArray(origins) ||
    !origins.length ||
    origins.some(origin => typeof origin !== 'string' || !origin || origin.includes('*'))
  ) {
    throw new Error('Configure exact wallet origins before checking the service');
  }
  return origins;
}

export async function checkDeployment({ endpoint, origins, revision, fetchImpl = fetch, healthAttempts = 1 }) {
  const base = validateEndpoint(endpoint);
  const allowed = validateOrigins(origins);
  if (!Number.isInteger(healthAttempts) || healthAttempts < 1 || healthAttempts > 10) {
    throw new Error('Invalid health retry limit');
  }

  const request = (path, init) =>
    fetchImpl(`${base}${path}`, {
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(20_000),
      ...init
    });

  for (let attempt = 1; ; attempt += 1) {
    try {
      let response;
      let body;
      try {
        response = await request('/healthz', { method: 'GET' });
        body = await response.json();
      } catch {
        throw new Error('Deployment health did not return a JSON response');
      }
      if (!response.ok || !record(body) || body.ok !== true || !noStore(response)) {
        throw new Error('Deployed service is not ready');
      }
      if (revision && body.revision !== revision) {
        throw new Error('Deployed service does not report the requested release revision');
      }
      break;
    } catch (error) {
      if (attempt >= healthAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }

  const preflight = await request('/v1/storage', {
    method: 'OPTIONS',
    headers: {
      Origin: allowed[0],
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization, if-none-match'
    }
  });
  const variesByOrigin = (preflight.headers.get('Vary') ?? '')
    .split(',')
    .some(value => value.trim().toLowerCase() === 'origin');
  if (
    preflight.status !== 204 ||
    preflight.headers.get('Access-Control-Allow-Origin') !== allowed[0] ||
    !variesByOrigin
  ) {
    throw new Error('Deployed service does not accept the configured wallet origin');
  }

  const foreign = await request('/healthz', { method: 'GET', headers: { Origin: FOREIGN_ORIGIN } });
  if (foreign.status !== 403 || foreign.headers.get('Access-Control-Allow-Origin') !== null) {
    throw new Error('Deployed service accepts an origin that is not configured');
  }

  return { endpoint: base };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await checkDeployment({
      endpoint: process.env.WALLET_API_URL,
      origins: JSON.parse(process.env.WALLET_API_ALLOWED_ORIGINS ?? '[]'),
      revision: process.env.WALLET_API_REVISION,
      healthAttempts: 5
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `endpoint=${result.endpoint}\n`);
    console.log(`Wallet API ready at ${result.endpoint}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Wallet API readiness failed');
    process.exitCode = 1;
  }
}
