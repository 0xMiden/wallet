/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { price } from './harness';
import {
  PRICE_CACHE_SECONDS,
  PRICE_STALE_SECONDS,
  PriceUnavailableError,
  createPriceSource,
  type PriceCache,
  type PriceFetcher,
  type StoredPrice
} from '../src/prices';

const NOW = 1_800_000_000_000;
/** The default Binance price of ETHUSDT, as its text gives it: 8 fraction digits. */
const ETH = price('2000.50000000');

/** A fake of the Workers Cache API: it keeps each body by URL. */
class FakeCache implements PriceCache {
  readonly bodies = new Map<string, string>();
  readonly maxAges: string[] = [];
  failing = false;

  async match(request: Request): Promise<Response | undefined> {
    if (this.failing) throw new Error('cache down');
    const body = this.bodies.get(request.url);
    return body === undefined ? undefined : new Response(body);
  }

  async put(request: Request, response: Response): Promise<void> {
    if (this.failing) throw new Error('cache down');
    this.maxAges.push(response.headers.get('Cache-Control') ?? '');
    this.bodies.set(request.url, await response.text());
  }
}

type Answer = Response | 'reject';

/** A fake network: Binance and Kraken answer what the test sets, and every URL is recorded. */
class FakeSources {
  readonly urls: string[] = [];
  binance: () => Answer = () => Response.json([{ symbol: 'ETHUSDT', price: '2000.50000000' }]);
  kraken: () => Answer = () => Response.json({ error: [], result: { XETHZUSD: { c: ['1999.9', '0.1'] } } });

  readonly fetcher: PriceFetcher = async url => {
    this.urls.push(url);
    const answer = url.startsWith('https://data-api.binance.vision/') ? this.binance() : this.kraken();
    if (answer === 'reject') throw new Error(`connect failed: ${url}`);
    return answer;
  };
}

interface Setup {
  sources: FakeSources;
  cache: FakeCache;
  memory: Map<string, StoredPrice>;
  clock: { now: number };
  source: ReturnType<typeof createPriceSource>;
}

function setup(): Setup {
  const sources = new FakeSources();
  const cache = new FakeCache();
  const memory = new Map<string, StoredPrice>();
  const clock = { now: NOW };
  const source = createPriceSource({ fetcher: sources.fetcher, cache, memory, now: () => clock.now });
  return { sources, cache, memory, clock, source };
}

/** Every line that the source logged in this test. */
const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  jest.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Every logged line, which must name no URL. */
function lines(): string[] {
  for (const line of logged) expect(line).not.toMatch(/https?:|binance\.vision|kraken\.com|connect failed/);
  return [...logged];
}

describe('the price source', () => {
  it('asks Binance once for all symbols and keeps each price in memory and in the cache', async () => {
    const { sources, cache, memory, source } = setup();
    sources.binance = () =>
      Response.json([
        { symbol: 'BTCUSDT', price: '100000.01000000' },
        { symbol: 'ETHUSDT', price: '2000.50000000' }
      ]);
    const prices = await source.usdPrices(['ETHUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(prices).toEqual(
      new Map([
        ['ETHUSDT', price('2000.50000000')],
        ['BTCUSDT', price('100000.01000000')]
      ])
    );
    expect(sources.urls).toEqual([
      `https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent('["ETHUSDT","BTCUSDT"]')}`
    ]);
    expect(memory.get('ETHUSDT')).toEqual({ price: ETH, at: NOW });
    expect(JSON.parse(cache.bodies.get('https://evm-relay-prices.invalid/v1/ETHUSDT') ?? '')).toEqual({
      price: '2000.50000000',
      at: NOW
    });
    expect(cache.maxAges).toEqual([`max-age=${PRICE_STALE_SECONDS}`, `max-age=${PRICE_STALE_SECONDS}`]);
    expect(lines()).toEqual([]);
  });

  it('makes no request while a kept price is not older than the cache time', async () => {
    const { sources, clock, source } = setup();
    await source.usdPrices(['ETHUSDT']);
    clock.now = NOW + PRICE_CACHE_SECONDS * 1000;
    await expect(source.usdPrices(['ETHUSDT'])).resolves.toEqual(new Map([['ETHUSDT', ETH]]));
    expect(sources.urls).toHaveLength(1);
    clock.now += 1;
    await source.usdPrices(['ETHUSDT']);
    expect(sources.urls).toHaveLength(2);
  });

  it('takes a young price from the Cache API when the isolate memory has none', async () => {
    const first = setup();
    await first.source.usdPrices(['ETHUSDT']);
    // Another isolate: its own memory, the same cache.
    const memory = new Map<string, StoredPrice>();
    const sources = new FakeSources();
    const source = createPriceSource({ fetcher: sources.fetcher, cache: first.cache, memory, now: () => NOW + 1000 });
    await expect(source.usdPrices(['ETHUSDT'])).resolves.toEqual(new Map([['ETHUSDT', ETH]]));
    expect(sources.urls).toEqual([]);
    expect(memory.get('ETHUSDT')?.at).toBe(NOW);
  });

  it('asks only for the symbols without a young price', async () => {
    const { sources, memory, source } = setup();
    memory.set('ETHUSDT', { price: price('2000'), at: NOW - 1000 });
    sources.binance = () => Response.json([{ symbol: 'BTCUSDT', price: '100000' }]);
    await source.usdPrices(['ETHUSDT', 'BTCUSDT']);
    expect(sources.urls).toEqual([
      `https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent('["BTCUSDT"]')}`
    ]);
  });

  it.each<[string, () => Answer]>([
    ['refuses the connection', () => 'reject'],
    ['answers 500', () => new Response('down', { status: 500 })],
    ['answers 429', () => Response.json({ code: -1003, msg: 'Too many requests' }, { status: 429 })],
    ['answers a body that is not JSON', () => new Response('<html>')],
    ['answers an object, not a list', () => Response.json({ symbol: 'ETHUSDT', price: '1' })]
  ])('asks Kraken when Binance %s, and logs only the source', async (_name, binance) => {
    const { sources, source } = setup();
    sources.binance = binance;
    await expect(source.usdPrices(['ETHUSDT'])).resolves.toEqual(new Map([['ETHUSDT', price('1999.9')]]));
    expect(sources.urls[1]).toBe('https://api.kraken.com/0/public/Ticker?pair=ETHUSD');
    expect(lines()).toEqual(['evm-relay: the price source binance failed.']);
  });

  it('names an unknown symbol in a log line and asks Kraken for it', async () => {
    const { sources, source } = setup();
    sources.binance = () => Response.json({ code: -1121, msg: 'Invalid symbol.' }, { status: 400 });
    sources.kraken = () => Response.json({ error: [], result: { XXBTZUSD: { c: ['100000.1', '1'] } } });
    await expect(source.usdPrices(['BTCUSDC'])).resolves.toEqual(new Map([['BTCUSDC', price('100000.1')]]));
    expect(sources.urls[1]).toBe('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
    expect(lines()).toEqual(['evm-relay: the price source binance does not know the symbol BTCUSDC.']);
  });

  it('reads the Kraken pair under its requested name and its canonical name', async () => {
    const { sources, source } = setup();
    sources.binance = () => 'reject';
    sources.kraken = () =>
      Response.json({ error: [], result: { POLUSD: { c: ['0.25', '1'] }, XETHZUSD: { c: ['2001', '1'] } } });
    const prices = await source.usdPrices(['ETHUSDT', 'POLUSDT']);
    expect(prices).toEqual(
      new Map([
        ['ETHUSDT', price('2001')],
        ['POLUSDT', price('0.25')]
      ])
    );
    expect(sources.urls[1]).toBe('https://api.kraken.com/0/public/Ticker?pair=ETHUSD,POLUSD');
  });

  it('asks Kraken only for the symbols that Binance did not give', async () => {
    const { sources, source } = setup();
    sources.binance = () => Response.json([{ symbol: 'ETHUSDT', price: '2000' }]);
    sources.kraken = () => Response.json({ error: [], result: { POLUSD: { c: ['0.25', '1'] } } });
    await source.usdPrices(['ETHUSDT', 'POLUSDT']);
    expect(sources.urls[1]).toBe('https://api.kraken.com/0/public/Ticker?pair=POLUSD');
  });

  it('uses a kept price up to the stale limit when both sources fail, and none after it', async () => {
    const { sources, memory, clock, source } = setup();
    memory.set('ETHUSDT', { price: price('1800'), at: NOW });
    sources.binance = () => 'reject';
    sources.kraken = () => 'reject';
    clock.now = NOW + PRICE_STALE_SECONDS * 1000;
    await expect(source.usdPrices(['ETHUSDT'])).resolves.toEqual(new Map([['ETHUSDT', price('1800')]]));
    clock.now += 1;
    await expect(source.usdPrices(['ETHUSDT'])).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(lines()).toContain('evm-relay: no price for ETHUSDT.');
  });

  it('uses a stale price from the Cache API when both sources fail', async () => {
    const first = setup();
    await first.source.usdPrices(['ETHUSDT']);
    const sources = new FakeSources();
    sources.binance = () => 'reject';
    sources.kraken = () => 'reject';
    const source = createPriceSource({
      fetcher: sources.fetcher,
      cache: first.cache,
      memory: new Map(),
      now: () => NOW + 200_000
    });
    await expect(source.usdPrices(['ETHUSDT'])).resolves.toEqual(new Map([['ETHUSDT', ETH]]));
  });

  it('answers PriceUnavailableError with no kept price when both sources fail', async () => {
    const { sources, source } = setup();
    sources.binance = () => 'reject';
    sources.kraken = () => new Response('down', { status: 502 });
    await expect(source.usdPrices(['ETHUSDT'])).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(lines()).toEqual([
      'evm-relay: the price source binance failed.',
      'evm-relay: the price source kraken failed.',
      'evm-relay: no price for ETHUSDT.'
    ]);
  });

  it('names a symbol that neither source knows, and gives no price', async () => {
    const { sources, source } = setup();
    sources.binance = () => Response.json({ code: -1121, msg: 'Invalid symbol.' }, { status: 400 });
    sources.kraken = () => Response.json({ error: ['EQuery:Unknown asset pair'], result: {} });
    await expect(source.usdPrices(['FOOUSDT'])).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(lines()).toEqual([
      'evm-relay: the price source binance does not know the symbol FOOUSDT.',
      'evm-relay: the price source kraken does not know the symbol FOOUSDT.',
      'evm-relay: no price for FOOUSDT.'
    ]);
  });

  it('asks Kraken for no symbol that has no USD market form', async () => {
    const { sources, source } = setup();
    sources.binance = () => Response.json({ code: -1121, msg: 'Invalid symbol.' }, { status: 400 });
    await expect(source.usdPrices(['ETHBTC'])).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(sources.urls).toHaveLength(1);
  });

  it.each(['0', '0.00000000', '-1', '1e5', 'NaN', 'Infinity', '', 2000, null])(
    'refuses the price %p from a source',
    async value => {
      const { sources, source } = setup();
      sources.binance = () => Response.json([{ symbol: 'ETHUSDT', price: value }]);
      sources.kraken = () => Response.json({ error: [], result: { XETHZUSD: { c: [value, '1'] } } });
      await expect(source.usdPrices(['ETHUSDT'])).rejects.toBeInstanceOf(PriceUnavailableError);
      expect(lines()).toContain('evm-relay: the price source binance gave a price that is not valid for ETHUSDT.');
    }
  );

  it('ignores a cached body of another shape and a cache that fails', async () => {
    const { sources, cache, source } = setup();
    cache.bodies.set('https://evm-relay-prices.invalid/v1/ETHUSDT', JSON.stringify({ price: 'x', at: NOW }));
    await source.usdPrices(['ETHUSDT']);
    expect(sources.urls).toHaveLength(1);

    const failing = setup();
    failing.cache.failing = true;
    await expect(failing.source.usdPrices(['ETHUSDT'])).resolves.toEqual(new Map([['ETHUSDT', ETH]]));
    // The memory layer keeps the price when the cache fails.
    expect(failing.memory.get('ETHUSDT')?.at).toBe(NOW);
  });

  it('works without a Cache API', async () => {
    const sources = new FakeSources();
    const source = createPriceSource({ fetcher: sources.fetcher, cache: null, memory: new Map(), now: () => NOW });
    await expect(source.usdPrices(['ETHUSDT'])).resolves.toEqual(new Map([['ETHUSDT', ETH]]));
  });

  it('sends each request with a time-out', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const source = createPriceSource({
      fetcher: async (_url, init) => {
        signals.push(init.signal);
        return Response.json([{ symbol: 'ETHUSDT', price: '1' }]);
      },
      cache: null,
      memory: new Map(),
      now: () => NOW
    });
    await source.usdPrices(['ETHUSDT']);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});
