import type { GeoPlace } from './geo';

const LOOKUP_URL = 'https://api.ipinfo.io/lookup/me';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Country and region only. The address and the rest of the payload are not kept. */
function readPlace(body: unknown): GeoPlace | null {
  if (!isRecord(body) || !isRecord(body.geo)) return null;
  const { country_code: countryCode, region_code: regionCode } = body.geo;
  if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) return null;
  const place: GeoPlace = { country: countryCode.toUpperCase() };
  if (typeof regionCode === 'string' && /^[A-Za-z0-9]{1,3}$/.test(regionCode)) place.region = regionCode.toUpperCase();
  return place;
}

async function requestPlace(fetchImpl: typeof fetch, token: string): Promise<GeoPlace | null> {
  try {
    const response = await fetchImpl(LOOKUP_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    return readPlace(await response.json());
  } catch {
    return null;
  }
}

/**
 * Where this device's connection comes from, via IPinfo. The token is a build env var
 * (`IPINFO_TOKEN`): wallet-config is a public document and cannot hold it. No token, or a lookup
 * that never answers, returns null so a configured block stays closed. The address is not returned.
 */
export async function lookupCallerPlace(
  options: { fetchImpl?: typeof fetch; attempts?: number } = {}
): Promise<GeoPlace | null> {
  const token = process.env.IPINFO_TOKEN ?? '';
  if (token === '') return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const place = await requestPlace(fetchImpl, token);
    if (place) return place;
    if (attempt < attempts - 1) await wait(200 * (attempt + 1));
  }
  return null;
}
