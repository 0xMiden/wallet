import { fetchBoundedJson, type JsonResponse } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

import type { FeatureEligibility } from './geo';

function readEligibility(body: unknown, network: string, version: number): FeatureEligibility | null {
  if (!isRecord(body) || body.network !== network || body.version !== version || !isRecord(body.allowed)) return null;
  const { earn, swap } = body.allowed;
  if (typeof earn !== 'boolean' || typeof swap !== 'boolean') return null;
  return { network, version, allowed: { earn, swap } };
}

/** The server owns paid-service credentials and returns only decisions for the accepted policy. */
export async function lookupFeatureEligibility(
  network: string,
  version: number,
  options: { fetchImpl?: (url: string, init: RequestInit) => Promise<JsonResponse> } = {}
): Promise<FeatureEligibility | null> {
  const endpoint = process.env.FEATURE_ELIGIBILITY_URL;
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    url.searchParams.set('network', network);
    const fetchImpl = options.fetchImpl ?? fetch;
    const body = await fetchBoundedJson(
      (requestUrl, init) => fetchImpl(requestUrl, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' }),
      url.href,
      { maxBytes: 4 * 1_024, timeoutMs: 10_000 }
    );
    return readEligibility(body, network, version);
  } catch {
    return null;
  }
}
