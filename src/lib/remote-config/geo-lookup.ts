import type { GeoPlace } from './geo';

const LOOKUP_URL = 'https://geoip.maxmind.com/geoip/v2.1/city/me';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Country and the first subdivision only. The address and the rest of the payload are not kept. */
function readPlace(body: unknown): GeoPlace | null {
  if (!isRecord(body) || !isRecord(body.country)) return null;
  const countryCode = body.country.iso_code;
  if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) return null;
  const place: GeoPlace = { country: countryCode.toUpperCase() };
  const first = Array.isArray(body.subdivisions) ? body.subdivisions[0] : undefined;
  if (isRecord(first) && typeof first.iso_code === 'string' && /^[A-Za-z0-9]{1,3}$/.test(first.iso_code)) {
    place.region = first.iso_code.toUpperCase();
  }
  return place;
}

function authorization(accountId: string, licenseKey: string): string | null {
  try {
    return `Basic ${btoa(`${accountId}:${licenseKey}`)}`;
  } catch {
    return null;
  }
}

async function requestPlace(fetchImpl: typeof fetch, accountId: string, licenseKey: string): Promise<GeoPlace | null> {
  const header = authorization(accountId, licenseKey);
  if (header === null) return null;
  try {
    const response = await fetchImpl(LOOKUP_URL, {
      headers: { Accept: 'application/json', Authorization: header }
    });
    if (!response.ok) return null;
    return readPlace(await response.json());
  } catch {
    return null;
  }
}

/**
 * Where this device's connection comes from, via MaxMind GeoIP City Plus. The account id and
 * license key are build env vars (`MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY`): wallet-config is a
 * public document and cannot hold them. Each lookup spends service credit. A missing credential, or
 * a lookup that never answers, returns null so a configured block stays closed. The address is not
 * returned.
 */
export async function lookupCallerPlace(
  options: { fetchImpl?: typeof fetch; attempts?: number } = {}
): Promise<GeoPlace | null> {
  const accountId = process.env.MAXMIND_ACCOUNT_ID ?? '';
  const licenseKey = process.env.MAXMIND_LICENSE_KEY ?? '';
  if (accountId === '' || licenseKey === '') return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const place = await requestPlace(fetchImpl, accountId, licenseKey);
    if (place) return place;
    if (attempt < attempts - 1) await wait(200 * (attempt + 1));
  }
  return null;
}
