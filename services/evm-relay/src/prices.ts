// USD prices of the native coins and the fee tokens, for the fee rule of `deduct` mode (fee.ts). The first source is
// the Binance public market data API, with one request for all symbols. The second source is the Kraken public ticker,
// for the symbols that Binance does not give. Each price is kept in isolate memory and in the Workers Cache API.
//
// - A price that is not older than PRICE_CACHE_SECONDS is used without a request.
// - When both sources fail for a symbol, a kept price that is not older than PRICE_STALE_SECONDS is used.
// - Else the symbol has no price, and the caller answers `503 price_unavailable`. The Worker never guesses a price.
//
// A log line names the source and the symbol only. It never holds a URL, a request body or the error text of a source.
import { formatDecimal, parseDecimal, type Decimal } from './fee';
import { isRecord } from './http';

/** A kept price that is not older than this is used without a request. */
export const PRICE_CACHE_SECONDS = 45;
/** When both sources fail, a kept price that is not older than this is still used. */
export const PRICE_STALE_SECONDS = 300;
/** The time budget of one request to a price source. */
export const PRICE_TIMEOUT_MS = 3_000;

const BINANCE_TICKER_URL = 'https://data-api.binance.vision/api/v3/ticker/price';
const KRAKEN_TICKER_URL = 'https://api.kraken.com/0/public/Ticker';
/** The Binance error code of an unknown symbol. The answer does not say which symbol of the list it is. */
const BINANCE_INVALID_SYMBOL = -1121;
const KRAKEN_UNKNOWN_PAIR = 'EQuery:Unknown asset pair';
/**
 * The Cache API keys requests by URL. This host is not a real host (`.invalid`), so no request ever goes to it. The
 * `v1` segment changes when the stored shape changes.
 */
const CACHE_KEY_BASE = 'https://evm-relay-prices.invalid/v1/';
/** The market symbols that the Kraken fallback reads: a base asset against USDT or USDC, for example `ETHUSDT`. */
const USD_MARKET = /^([A-Z0-9]+?)(USDT|USDC)$/;

/** No source gave a price for a symbol, and no kept price is young enough. */
export class PriceUnavailableError extends Error {}

/** The part of the Workers Cache API that the price source uses. The tests give a fake. */
export interface PriceCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export type PriceFetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The USD prices of the market symbols. The routes use it; the tests give a fake. */
export interface PriceSource {
  /** One price per symbol. Throws PriceUnavailableError when a symbol has no price. */
  usdPrices(symbols: readonly string[]): Promise<Map<string, Decimal>>;
}

/** A price and the time that a source gave it, in milliseconds. */
export interface StoredPrice {
  price: Decimal;
  at: number;
}

export interface PriceOptions {
  fetcher?: PriceFetcher;
  /** The Cache API, or null for none. The default is `caches.default` when the runtime has it. */
  cache?: PriceCache | null;
  now?: () => number;
  /** The memory layer. The default is shared by every request of the isolate. */
  memory?: Map<string, StoredPrice>;
}

type SourceName = 'binance' | 'kraken';

const MEMORY = new Map<string, StoredPrice>();
const defaultFetcher: PriceFetcher = (url, init) => fetch(url, init);

/** The Workers Cache API, or null outside the Workers runtime (the Jest tests run in Node). */
function defaultCache(): PriceCache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

function logUnknown(source: SourceName, symbols: readonly string[]): void {
  // A config error: the symbol is wrong for this source. The line names only the source and the symbols.
  const subject = symbols.length === 1 ? `the symbol ${symbols.join('')}` : `one of the symbols ${symbols.join(', ')}`;
  console.error(`evm-relay: the price source ${source} does not know ${subject}.`);
}

function logFailure(source: SourceName): void {
  console.error(`evm-relay: the price source ${source} failed.`);
}

/** Read a JSON body. Null when the body is not JSON. */
async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Send one GET request to a price source. Null on a network failure or a time-out. */
async function get(fetcher: PriceFetcher, url: string): Promise<Response | null> {
  try {
    return await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(PRICE_TIMEOUT_MS) });
  } catch {
    // The error text is not logged: it is not ours to show.
    return null;
  }
}

/** The prices that Binance gives for the symbols, in one request. A missing symbol has no entry. */
async function fromBinance(fetcher: PriceFetcher, symbols: readonly string[]): Promise<Map<string, Decimal>> {
  const prices = new Map<string, Decimal>();
  const url = `${BINANCE_TICKER_URL}?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
  const response = await get(fetcher, url);
  if (response === null) {
    logFailure('binance');
    return prices;
  }
  const body = await bodyOf(response);
  if (!response.ok) {
    if (response.status === 400 && isRecord(body) && body.code === BINANCE_INVALID_SYMBOL) {
      logUnknown('binance', symbols);
    } else {
      logFailure('binance');
    }
    return prices;
  }
  if (!Array.isArray(body)) {
    logFailure('binance');
    return prices;
  }
  for (const item of body) {
    if (!isRecord(item) || typeof item.symbol !== 'string' || !symbols.includes(item.symbol)) continue;
    const price = parseDecimal(item.price);
    if (price === null) {
      console.error(`evm-relay: the price source binance gave a price that is not valid for ${item.symbol}.`);
      continue;
    }
    prices.set(item.symbol, price);
  }
  return prices;
}

/** The Kraken base asset of a market symbol: `ETHUSDT` → `ETH`, `BTCUSDC` → `XBT`. Null for another form. */
function krakenBaseOf(symbol: string): string | null {
  const base = USD_MARKET.exec(symbol)?.[1];
  if (base === undefined) return null;
  return base === 'BTC' ? 'XBT' : base;
}

/**
 * The prices that Kraken gives for the symbols, in one request, against USD. Kraken can answer with its canonical pair
 * name in place of the requested one: `XETHZUSD` for `ETHUSD`. The Worker takes both forms and no other.
 */
async function fromKraken(fetcher: PriceFetcher, symbols: readonly string[]): Promise<Map<string, Decimal>> {
  const prices = new Map<string, Decimal>();
  const bases = new Map<string, string>();
  for (const symbol of symbols) {
    const base = krakenBaseOf(symbol);
    if (base !== null) bases.set(symbol, base);
  }
  if (bases.size === 0) return prices;
  const pairs = [...bases.values()].map(base => `${base}USD`);
  const response = await get(fetcher, `${KRAKEN_TICKER_URL}?pair=${pairs.join(',')}`);
  const body = response === null ? null : await bodyOf(response);
  if (response === null || !response.ok || !isRecord(body) || !Array.isArray(body.error)) {
    logFailure('kraken');
    return prices;
  }
  const errors: unknown[] = body.error;
  if (errors.length > 0) {
    if (errors.every(error => error === KRAKEN_UNKNOWN_PAIR)) logUnknown('kraken', [...bases.keys()]);
    else logFailure('kraken');
    return prices;
  }
  const { result } = body;
  if (!isRecord(result)) {
    logFailure('kraken');
    return prices;
  }
  for (const [symbol, base] of bases) {
    const ticker = result[`${base}USD`] ?? result[`X${base}ZUSD`];
    // `c` is the last trade: [price, lot volume].
    const last: unknown = isRecord(ticker) && Array.isArray(ticker.c) ? ticker.c[0] : undefined;
    const price = parseDecimal(last);
    if (price !== null) prices.set(symbol, price);
    else if (ticker !== undefined) {
      console.error(`evm-relay: the price source kraken gave a price that is not valid for ${symbol}.`);
    }
  }
  return prices;
}

function cacheRequest(symbol: string): Request {
  return new Request(`${CACHE_KEY_BASE}${symbol}`);
}

/** Read the stored shape `{ price, at }` strictly. Null for any other value. */
function storedOf(value: unknown): StoredPrice | null {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isSafeInteger(value.at)) return null;
  const price = parseDecimal(value.price);
  return price === null ? null : { price, at: value.at };
}

/** The price source over Binance, Kraken, the isolate memory and the Cache API. */
export function createPriceSource(options: PriceOptions = {}): PriceSource {
  const fetcher = options.fetcher ?? defaultFetcher;
  const cache = options.cache === undefined ? defaultCache() : options.cache;
  const now = options.now ?? Date.now;
  const memory = options.memory ?? MEMORY;

  /** The youngest kept price of the symbol: from memory, else from the Cache API. A cache failure counts as none. */
  async function kept(symbol: string, at: number): Promise<StoredPrice | null> {
    const inMemory = memory.get(symbol) ?? null;
    if (inMemory !== null && at - inMemory.at <= PRICE_CACHE_SECONDS * 1000) return inMemory;
    if (cache === null) return inMemory;
    let stored: StoredPrice | null = null;
    try {
      const response = await cache.match(cacheRequest(symbol));
      stored = response === undefined ? null : storedOf(await bodyOf(response));
    } catch {
      stored = null;
    }
    if (stored === null || at < stored.at) return inMemory;
    if (inMemory === null || stored.at > inMemory.at) {
      memory.set(symbol, stored);
      return stored;
    }
    return inMemory;
  }

  async function keep(symbol: string, price: StoredPrice): Promise<void> {
    memory.set(symbol, price);
    if (cache === null) return;
    const body = JSON.stringify({ price: formatDecimal(price.price), at: price.at });
    const response = new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${PRICE_STALE_SECONDS}` }
    });
    try {
      await cache.put(cacheRequest(symbol), response);
    } catch {
      // The cache is a help, not a need: the memory layer keeps the price.
    }
  }

  async function usdPrices(symbols: readonly string[]): Promise<Map<string, Decimal>> {
    const wanted = [...new Set(symbols)];
    const at = now();
    const found = new Map<string, StoredPrice | null>();
    for (const symbol of wanted) found.set(symbol, await kept(symbol, at));
    const isFresh = (price: StoredPrice | null | undefined): boolean =>
      price !== null && price !== undefined && at - price.at <= PRICE_CACHE_SECONDS * 1000;

    const due = wanted.filter(symbol => !isFresh(found.get(symbol)));
    const fetched = due.length === 0 ? new Map<string, Decimal>() : await fromBinance(fetcher, due);
    const rest = due.filter(symbol => !fetched.has(symbol));
    if (rest.length > 0) {
      for (const [symbol, price] of await fromKraken(fetcher, rest)) fetched.set(symbol, price);
    }
    for (const [symbol, price] of fetched) await keep(symbol, { price, at });

    const prices = new Map<string, Decimal>();
    const missing: string[] = [];
    for (const symbol of wanted) {
      const live = fetched.get(symbol);
      const stored = found.get(symbol);
      if (live !== undefined) prices.set(symbol, live);
      else if (stored !== null && stored !== undefined && at - stored.at <= PRICE_STALE_SECONDS * 1000) {
        prices.set(symbol, stored.price);
      } else missing.push(symbol);
    }
    if (missing.length > 0) {
      console.error(`evm-relay: no price for ${missing.join(', ')}.`);
      throw new PriceUnavailableError('No price source gives a price now.');
    }
    return prices;
  }

  return { usdPrices };
}
