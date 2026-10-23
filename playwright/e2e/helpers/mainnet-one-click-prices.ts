import { usdToMicroDollarsCeil } from './mainnet-one-click-plan';

const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';

export interface MainnetOneClickUsdPrices {
  source: 'CoinGecko simple price API';
  fetchedAt: string;
  pricesUpdatedAt: string;
  usdMicrosById: Readonly<Record<string, bigint>>;
}

const MAX_PRICE_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function fetchMainnetOneClickUsdPrices(
  ids: readonly string[],
  fetcher: typeof fetch = fetch
): Promise<MainnetOneClickUsdPrices> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length < 1 || uniqueIds.length > 12 || uniqueIds.some(id => !/^[a-z0-9-]{1,64}$/.test(id))) {
    throw new Error('Invalid CoinGecko price id set');
  }
  const url = new URL(PRICE_URL);
  url.searchParams.set('ids', uniqueIds.join(','));
  url.searchParams.set('vs_currencies', 'usd');
  url.searchParams.set('include_last_updated_at', 'true');
  const response = await fetcher(url.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`CoinGecko price request failed (${response.status})`);
  const data: unknown = await response.json();
  if (!isRecord(data)) throw new Error('CoinGecko returned an invalid price response');
  const usdMicrosById: Record<string, bigint> = {};
  let newestUpdate = 0;
  const now = Date.now();
  for (const id of uniqueIds) {
    const entry = data[id];
    if (!isRecord(entry) || (typeof entry.usd !== 'string' && typeof entry.usd !== 'number') ||
        (typeof entry.last_updated_at !== 'string' && typeof entry.last_updated_at !== 'number')) {
      throw new Error(`CoinGecko did not return a USD price for ${id}`);
    }
    const updatedAtSeconds = Number(entry.last_updated_at);
    const updatedAt = updatedAtSeconds * 1000;
    const price = usdToMicroDollarsCeil(String(entry.usd));
    if (!Number.isSafeInteger(updatedAtSeconds) || updatedAtSeconds <= 0 || !Number.isSafeInteger(updatedAt) ||
        now - updatedAt > MAX_PRICE_AGE_MS || updatedAt - now > MAX_FUTURE_SKEW_MS || price <= 0n) {
      throw new Error(`CoinGecko price for ${id} is stale or invalid`);
    }
    newestUpdate = Math.max(newestUpdate, updatedAt);
    usdMicrosById[id] = price;
  }
  return {
    source: 'CoinGecko simple price API',
    fetchedAt: new Date(now).toISOString(),
    pricesUpdatedAt: new Date(newestUpdate).toISOString(),
    usdMicrosById
  };
}
