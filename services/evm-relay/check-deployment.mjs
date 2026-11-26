// Post-deploy probe of the evm-relay Worker. The deploy workflow runs it after `wrangler deploy`. It checks that the
// deployed revision answers `/healthz`, that a configured wallet origin passes the CORS preflight, that an unknown
// origin is refused, that `GET /v1/account` with no query answers `400 invalid_request`, and that `POST /v1/quote`
// with the body `{}` answers `400 fee_not_needed` (sponsor mode) or `400 invalid_request` (deduct mode). The last two
// requests prove that the router and the config are live, and they read no chain and ask no price source. The probe
// sends no relay and writes no data.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FOREIGN_ORIGIN = 'https://evm-relay-probe.invalid';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const noStore = response => /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '');
/** The methods and the request headers the wallet sends to the relay (src/http.ts allows exactly these). */
const WALLET_METHODS = ['GET', 'POST'];
const WALLET_HEADERS = ['content-type'];
/** The answers of `POST /v1/quote` with the body `{}`: sponsor mode, then deduct mode. */
const QUOTE_PROBE_ERRORS = ['fee_not_needed', 'invalid_request'];

/** True when the comma-separated list holds every name as a whole token; header names ignore case. */
const allowsEvery = (list, names, ignoreCase) => {
  const tokens = new Set(
    (list ?? '')
      .split(',')
      .map(token => (ignoreCase ? token.trim().toLowerCase() : token.trim()))
      .filter(token => token.length > 0)
  );
  return names.every(name => tokens.has(name));
};

/** True when the Vary header names Origin. */
const variesByOrigin = response =>
  (response.headers.get('Vary') ?? '').split(',').some(value => value.trim().toLowerCase() === 'origin');

/**
 * The base URL the wallet-config document names as `relay.url`: https, no credentials, query, fragment or trailing
 * slash. Returns the base as a string with no trailing slash, so a path appends to it.
 */
export function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Set a public HTTPS EVM relay base URL');
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
    throw new Error('EVM relay base URL must use HTTPS with no credentials, query, fragment or trailing slash');
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

/** Read a JSON body. Null when the body is not JSON. */
async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
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

  // The wallet reads with GET and sends a relay with POST and a JSON body.
  const preflight = await request('/v1/relay', {
    method: 'OPTIONS',
    headers: {
      Origin: allowed[0],
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  const allowsMethods = allowsEvery(preflight.headers.get('Access-Control-Allow-Methods'), WALLET_METHODS, false);
  const allowsHeaders = allowsEvery(preflight.headers.get('Access-Control-Allow-Headers'), WALLET_HEADERS, true);
  if (
    preflight.status !== 204 ||
    preflight.headers.get('Access-Control-Allow-Origin') !== allowed[0] ||
    !variesByOrigin(preflight) ||
    !allowsMethods ||
    !allowsHeaders
  ) {
    throw new Error('Deployed service does not accept the configured wallet origin');
  }

  const foreign = await request('/healthz', { method: 'GET', headers: { Origin: FOREIGN_ORIGIN } });
  if (foreign.status !== 403 || foreign.headers.get('Access-Control-Allow-Origin') !== null) {
    throw new Error('Deployed service accepts an origin that is not configured');
  }

  // The account route parses the config before it checks the query, so a broken config answers 503 here.
  const account = await request('/v1/account', { method: 'GET', headers: { Origin: allowed[0] } });
  const accountBody = await readBody(account);
  if (
    account.status !== 400 ||
    !record(accountBody) ||
    accountBody.error !== 'invalid_request' ||
    account.headers.get('Access-Control-Allow-Origin') !== allowed[0] ||
    !noStore(account)
  ) {
    throw new Error('Deployed service does not route an account read with its config');
  }

  // The quote route parses the config and checks the gas mode before it reads the body: sponsor mode answers
  // fee_not_needed, deduct mode refuses the empty body. Both stop before a chain read and a price request.
  const quote = await request('/v1/quote', {
    method: 'POST',
    headers: { Origin: allowed[0], 'Content-Type': 'application/json' },
    body: '{}'
  });
  const quoteBody = await readBody(quote);
  if (
    quote.status !== 400 ||
    !record(quoteBody) ||
    !QUOTE_PROBE_ERRORS.includes(quoteBody.error) ||
    quote.headers.get('Access-Control-Allow-Origin') !== allowed[0] ||
    !noStore(quote)
  ) {
    throw new Error('Deployed service does not route a quote with its config');
  }

  return { endpoint: base };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await checkDeployment({
      endpoint: process.env.EVM_RELAY_URL,
      origins: JSON.parse(process.env.EVM_RELAY_ALLOWED_ORIGINS ?? '[]'),
      revision: process.env.EVM_RELAY_REVISION,
      healthAttempts: 5
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `endpoint=${result.endpoint}\n`);
    console.log(`EVM relay ready at ${result.endpoint}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'EVM relay readiness failed');
    process.exitCode = 1;
  }
}
