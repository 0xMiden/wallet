import {
  fetchIssuerPrices,
  isIssuerQuote,
  ISSUER_PRICE_MAX_AGE_MS,
  issuerPriceSources,
  readIssuerPrice
} from './issuer';

// Every spelling of the faucet reduces to `mm1aaa`, as the SDK reduces hex and bech32 to one id.
jest.mock('lib/miden/swap/tokens', () => ({
  normalizedFaucetId: (id: string) => (id === '0xaaa' ? 'mm1aaa' : id)
}));

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const URL_A = 'https://issuer.example/api/price/AAA';

const response = (body: unknown, { ok = true }: { ok?: boolean } = {}) => ({
  ok,
  status: ok ? 200 : 500,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body
});

const answer = (overrides: Record<string, unknown> = {}) => ({
  symbol: 'AAA',
  faucetId: 'mm1aaa',
  usd: 1.25,
  asOf: new Date(NOW - 30_000).toISOString(),
  ...overrides
});

describe('issuerPriceSources', () => {
  const assets = new Map([
    ['mm1aaa', 'AAA'],
    ['mm1bbb', 'BTC']
  ]);
  const urls = new Map([
    ['0xaaa', URL_A],
    ['mm1bbb', 'https://issuer.example/api/price/BTC']
  ]);

  it('prices a listed token from its issuer only when no exchange lists its price asset', () => {
    expect(issuerPriceSources(urls, assets, symbol => symbol === 'AAA')).toEqual([
      { faucetId: 'mm1aaa', priceSymbol: 'AAA', url: URL_A }
    ]);
  });

  it('asks no issuer while a market is not ruled out', () => {
    expect(issuerPriceSources(urls, assets, () => false)).toEqual([]);
  });

  it('skips a price asset another priced faucet shares, so its quote cannot reach that token', () => {
    const shared = new Map([...assets, ['mm1ccc', 'AAA']]);
    expect(issuerPriceSources(urls, shared, () => true)).toEqual([
      { faucetId: 'mm1bbb', priceSymbol: 'BTC', url: 'https://issuer.example/api/price/BTC' }
    ]);
  });

  it('skips a URL whose faucet the wallet does not price, and reads no list as no sources', () => {
    expect(issuerPriceSources(new Map([['mm1zzz', URL_A]]), assets, () => true)).toEqual([]);
    expect(issuerPriceSources(null, assets, () => true)).toEqual([]);
    expect(issuerPriceSources(undefined, assets, () => true)).toEqual([]);
  });
});

describe('readIssuerPrice', () => {
  it('reads the USD price of the faucet asked about, in any spelling of its id', () => {
    expect(readIssuerPrice(answer(), 'mm1aaa', NOW)).toBe(1.25);
    expect(readIssuerPrice(answer({ faucetId: '0xaaa' }), 'mm1aaa', NOW)).toBe(1.25);
  });

  it('accepts an answer without asOf', () => {
    expect(readIssuerPrice(answer({ asOf: undefined }), 'mm1aaa', NOW)).toBe(1.25);
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['an array', [answer()]],
    ['no usd', answer({ usd: undefined })],
    ['a string usd', answer({ usd: '1.25' })],
    ['a zero usd', answer({ usd: 0 })],
    ['a negative usd', answer({ usd: -1 })],
    ['an infinite usd', answer({ usd: Infinity })],
    ['a NaN usd', answer({ usd: NaN })],
    ['no faucetId', answer({ faucetId: undefined })],
    ['another faucet', answer({ faucetId: 'mm1bbb' })],
    ['a non-string asOf', answer({ asOf: NOW })],
    ['an unreadable asOf', answer({ asOf: 'yesterday' })],
    ['a stale asOf', answer({ asOf: new Date(NOW - ISSUER_PRICE_MAX_AGE_MS - 1).toISOString() })],
    ['an asOf in the future', answer({ asOf: new Date(NOW + 5 * 60_000).toISOString() })]
  ])('refuses %s', (_case, body) => {
    expect(readIssuerPrice(body, 'mm1aaa', NOW)).toBeUndefined();
  });
});

describe('fetchIssuerPrices', () => {
  const sources = [
    { faucetId: 'mm1aaa', priceSymbol: 'AAA', url: URL_A },
    { faucetId: 'mm1bbb', priceSymbol: 'BBB', url: 'https://issuer.example/api/price/BBB' }
  ];

  it('quotes each valid answer under its price asset, with no move, as an issuer quote', async () => {
    const fetchFn = jest.fn(async (url: string) =>
      response(url === URL_A ? answer() : answer({ faucetId: 'mm1bbb', usd: 2 }))
    );
    const prices = await fetchIssuerPrices(sources, fetchFn, () => NOW);
    expect(prices).toEqual({
      AAA: { price: 1.25, change24h: 0, percentageChange24h: 0, observedAt: NOW, source: 'issuer' },
      BBB: { price: 2, change24h: 0, percentageChange24h: 0, observedAt: NOW, source: 'issuer' }
    });
    expect(isIssuerQuote(prices.AAA)).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(URL_A, expect.objectContaining({ cache: 'no-store' }));
  });

  it('leaves out a source that fails, answers badly or names another faucet', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url === URL_A) throw new Error('offline');
      return response(answer({ faucetId: 'mm1aaa' }));
    });
    await expect(fetchIssuerPrices(sources, fetchFn, () => NOW)).resolves.toEqual({});
    const failing = jest.fn(async () => response('not json'));
    await expect(fetchIssuerPrices(sources, failing, () => NOW)).resolves.toEqual({});
    const refused = jest.fn(async () => response(answer(), { ok: false }));
    await expect(fetchIssuerPrices(sources, refused, () => NOW)).resolves.toEqual({});
  });

  it('refuses an answer over the size bound', async () => {
    const fetchFn = jest.fn(async () => response(answer({ name: 'x'.repeat(20_000) })));
    await expect(fetchIssuerPrices(sources.slice(0, 1), fetchFn, () => NOW)).resolves.toEqual({});
  });

  it('gives up on an issuer that does not answer in time', async () => {
    jest.useFakeTimers();
    try {
      const fetchFn = jest.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          })
      );
      const pending = fetchIssuerPrices(sources.slice(0, 1), fetchFn, () => NOW);
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({});
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks nothing without sources', async () => {
    const fetchFn = jest.fn();
    await expect(fetchIssuerPrices([], fetchFn)).resolves.toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

it('tells an issuer quote from an exchange quote', () => {
  expect(isIssuerQuote({ price: 1, change24h: 0, percentageChange24h: 0 })).toBe(false);
  expect(isIssuerQuote(undefined)).toBe(false);
});
