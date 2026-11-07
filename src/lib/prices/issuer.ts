import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { fetchBoundedJson, type JsonFetch } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

import type { TokenPriceInfo, TokenPrices } from './binance';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BYTES = 16 * 1_024;
/** How old an issuer's `asOf` may be. */
export const ISSUER_PRICE_MAX_AGE_MS = 15 * 60_000;
/** How far ahead of this clock an issuer's `asOf` may be. */
const MAX_CLOCK_SKEW_MS = 60_000;

export interface IssuerPriceSource {
  /** Normalized, as `getPriceAssets` keys it. */
  faucetId: string;
  priceSymbol: string;
  url: string;
}

/**
 * The verified tokens to price from their issuer's endpoint (the token list's `priceUrl`): only a price asset that
 * no exchange lists (`unmarketed`, a verdict from both providers, so a failed lookup never counts) and that no other
 * priced faucet shares, since a quote is keyed by price asset and must not reach another token.
 */
export function issuerPriceSources(
  priceUrls: ReadonlyMap<string, string> | null | undefined,
  assets: ReadonlyMap<string, string>,
  unmarketed: (symbol: string) => boolean
): IssuerPriceSource[] {
  const sources: IssuerPriceSource[] = [];
  for (const [listedId, url] of priceUrls ?? []) {
    const faucetId = normalizedFaucetId(listedId);
    const priceSymbol = assets.get(faucetId);
    if (priceSymbol === undefined || !unmarketed(priceSymbol)) continue;
    const shared = Array.from(assets.values()).filter(symbol => symbol === priceSymbol).length > 1;
    if (!shared) sources.push({ faucetId, priceSymbol, url });
  }
  return sources;
}

/**
 * The USD price in an issuer's answer: `usd` a finite number above zero, `faucetId` naming the faucet asked about (in
 * any encoding), and `asOf`, when given, an ISO time no older than `ISSUER_PRICE_MAX_AGE_MS`. Else none.
 */
export function readIssuerPrice(body: unknown, faucetId: string, now: number): number | undefined {
  if (!isRecord(body)) return undefined;
  const { usd, faucetId: echoed, asOf } = body;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || !(usd > 0)) return undefined;
  if (typeof echoed !== 'string' || normalizedFaucetId(echoed) !== faucetId) return undefined;
  if (asOf !== undefined) {
    const at = typeof asOf === 'string' ? Date.parse(asOf) : NaN;
    if (!Number.isFinite(at) || at > now + MAX_CLOCK_SKEW_MS || now - at > ISSUER_PRICE_MAX_AGE_MS) return undefined;
  }
  return usd;
}

const issuerFetch: JsonFetch = (url, init) =>
  fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });

/**
 * One quote per source whose issuer answered in time with a valid price, keyed by price asset. A quote carries no 24h
 * move. A source that fails is left out, so its token stays unpriced as before.
 */
export async function fetchIssuerPrices(
  sources: readonly IssuerPriceSource[],
  fetchFn: JsonFetch = issuerFetch,
  now: () => number = Date.now
): Promise<TokenPrices> {
  const prices: TokenPrices = {};
  await Promise.all(
    sources.map(async ({ faucetId, priceSymbol, url }) => {
      try {
        const body = await fetchBoundedJson(fetchFn, url, { maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS });
        const observedAt = now();
        const price = readIssuerPrice(body, faucetId, observedAt);
        if (price !== undefined) {
          prices[priceSymbol] = { price, change24h: 0, percentageChange24h: 0, observedAt, source: 'issuer' };
        }
      } catch {
        // Unpriced until the next refresh.
      }
    })
  );
  return prices;
}

export function isIssuerQuote(quote: TokenPriceInfo | undefined): boolean {
  return quote?.source === 'issuer';
}
