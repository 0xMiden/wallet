import { fetchBoundedJson, type BoundedJsonFailure, type JsonResponse } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

import type { FeatureEligibility, StartupEligibilityReason } from './geo';

function readEligibility(
  body: unknown,
  network: string,
  version: number,
  fail: (reason: StartupEligibilityReason) => null
): FeatureEligibility | null {
  if (
    !isRecord(body) ||
    !isRecord(body.allowed) ||
    typeof body.network !== 'string' ||
    typeof body.version !== 'number'
  )
    return fail('response_invalid');
  if (body.network !== network) return fail('network_mismatch');
  if (body.version !== version) return fail('version_mismatch');
  const { wallet, earn, swap } = body.allowed;
  if (typeof wallet !== 'boolean' || typeof earn !== 'boolean' || typeof swap !== 'boolean')
    return fail('response_invalid');
  return { network, version, allowed: { wallet, earn, swap } };
}

/**
 * `yarn dev` allows every feature without calling the service.
 * Read the flag as its own `process.env` property so Vite can replace it.
 * The configs bake `true` only for an explicit non-E2E development build.
 */
function localDevelopmentEligibility(network: string, version: number): FeatureEligibility | null {
  if (process.env.MIDEN_ELIGIBILITY_OPEN !== 'true') return null;
  return { network, version, allowed: { wallet: true, earn: true, swap: true } };
}

/** The server owns paid-service credentials and returns only decisions for the accepted policy. */
export async function lookupFeatureEligibility(
  network: string,
  version: number,
  options: {
    fetchImpl?: (url: string, init: RequestInit) => Promise<JsonResponse>;
    onFailure?: (reason: StartupEligibilityReason, requestFailure?: BoundedJsonFailure) => void;
  } = {}
): Promise<FeatureEligibility | null> {
  const openForDevelopment = localDevelopmentEligibility(network, version);
  if (openForDevelopment) return openForDevelopment;
  const fail = (reason: StartupEligibilityReason, requestFailure?: BoundedJsonFailure): null => {
    try {
      if (requestFailure === undefined) options.onFailure?.(reason);
      else options.onFailure?.(reason, requestFailure);
    } catch {
      /* Diagnostics never change the decision. */
    }
    return null;
  };
  const endpoint = process.env.FEATURE_ELIGIBILITY_URL;
  if (!endpoint) return fail('endpoint_missing');
  let url: URL;
  try {
    url = new URL(endpoint);
    const loopbackTest =
      process.env.MIDEN_E2E_TEST === 'true' &&
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
    if ((!loopbackTest && url.protocol !== 'https:') || url.username !== '' || url.password !== '')
      return fail('endpoint_invalid');
  } catch {
    return fail('endpoint_invalid');
  }
  let requestFailure: BoundedJsonFailure | undefined;
  try {
    url.searchParams.set('network', network);
    const fetchImpl = options.fetchImpl ?? fetch;
    const body = await fetchBoundedJson(
      (requestUrl, init) => fetchImpl(requestUrl, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }),
      url.href,
      {
        maxBytes: 4 * 1_024,
        timeoutMs: 10_000,
        onFailure: failure => {
          requestFailure = failure;
        }
      }
    );
    return readEligibility(body, network, version, fail);
  } catch {
    return fail('request_failed', requestFailure);
  }
}
