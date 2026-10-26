import { fetchBoundedJson, type JsonResponse } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

import type { EligibilityFailure } from './eligibility-failure';
import type { EligibilityAnswer } from './geo';

const failed = (reason: EligibilityFailure): EligibilityAnswer => ({ state: 'failed', reason });

function readEligibility(body: unknown, network: string, version: number): EligibilityAnswer {
  if (!isRecord(body) || !isRecord(body.allowed)) return failed('bad_body');
  if (typeof body.network !== 'string' || typeof body.version !== 'number') return failed('bad_body');
  const { wallet, earn, swap } = body.allowed;
  if (typeof wallet !== 'boolean' || typeof earn !== 'boolean' || typeof swap !== 'boolean') return failed('bad_body');
  if (body.network !== network || body.version !== version) return failed('version_mismatch');
  return { state: 'ready', network, version, allowed: { wallet, earn, swap } };
}

/**
 * `yarn dev` allows every feature without calling the service.
 * Read the flag as its own `process.env` property so Vite can replace it.
 * The configs bake `true` only for an explicit non-E2E development build.
 */
function localDevelopmentEligibility(network: string, version: number): EligibilityAnswer | null {
  if (process.env.MIDEN_ELIGIBILITY_OPEN !== 'true') return null;
  return { state: 'ready', network, version, allowed: { wallet: true, earn: true, swap: true } };
}

function eligibilityUrl(network: string): URL | null {
  const endpoint = process.env.FEATURE_ELIGIBILITY_URL;
  if (!endpoint) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const loopbackTest =
    process.env.MIDEN_E2E_TEST === 'true' &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  if ((!loopbackTest && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return null;
  url.searchParams.set('network', network);
  return url;
}

function statusClass(status: number | undefined): EligibilityFailure {
  if (status !== undefined && status >= 400 && status <= 499) return 'http_4xx';
  if (status !== undefined && status >= 500 && status <= 599) return 'http_5xx';
  return 'http_other';
}

/**
 * The request timer aborts with a TimeoutError, and its reason stays on the signal after the request
 * settles. An AbortError can only come from that timer, since nothing else aborts before settlement.
 */
function timedOut(error: unknown, signal: AbortSignal | undefined): boolean {
  const name = isRecord(error) ? error.name : undefined;
  return (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    (isRecord(signal?.reason) && signal.reason.name === 'TimeoutError')
  );
}

function failureReason(error: unknown, seen: { response?: JsonResponse; signal?: AbortSignal }): EligibilityFailure {
  if (seen.response && !seen.response.ok) return statusClass(seen.response.status);
  if (timedOut(error, seen.signal)) return 'timeout';
  // A body stream fails with a TypeError when the connection drops after the headers.
  return seen.response && !(error instanceof TypeError) ? 'bad_body' : 'network';
}

/** The server owns paid-service credentials and returns only decisions for the accepted policy. */
export async function lookupFeatureEligibility(
  network: string,
  version: number,
  options: { fetchImpl?: (url: string, init: RequestInit) => Promise<JsonResponse> } = {}
): Promise<EligibilityAnswer> {
  const openForDevelopment = localDevelopmentEligibility(network, version);
  if (openForDevelopment) return openForDevelopment;
  const url = eligibilityUrl(network);
  if (!url) return failed('not_configured');
  // The bounded read reports every failure as a thrown error; what arrived tells them apart.
  const seen: { response?: JsonResponse; signal?: AbortSignal } = {};
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const body = await fetchBoundedJson(
      async (requestUrl, init) => {
        seen.signal = init.signal;
        seen.response = await fetchImpl(requestUrl, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
        return seen.response;
      },
      url.href,
      { maxBytes: 4 * 1_024, timeoutMs: 10_000 }
    );
    return readEligibility(body, network, version);
  } catch (error) {
    return failed(failureReason(error, seen));
  }
}
