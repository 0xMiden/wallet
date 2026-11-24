/**
 * @jest-environment node
 */
import { fetchMainnetOneClickUsdPrices } from './mainnet-one-click-prices';

const TEST_NOW = new Date('2026-10-22T12:00:00.000Z');

describe('mainnet 1Click USD price source', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(TEST_NOW);
  });

  afterEach(() => jest.useRealTimers());

  it('fetches one pinned public source and returns exact micro-dollar values with a timestamp', async () => {
    const updatedAt = Math.floor(TEST_NOW.getTime() / 1000);
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(
      new Response(JSON.stringify({ ethereum: { usd: 2500.125, last_updated_at: updatedAt }, 'usd-coin': { usd: 1, last_updated_at: updatedAt } }), { status: 200 })
    );

    const result = await fetchMainnetOneClickUsdPrices(['ethereum', 'usd-coin'], fetcher);

    expect(new URL(String(fetcher.mock.calls[0]?.[0])).origin).toBe('https://api.coingecko.com');
    expect(result.source).toBe('CoinGecko simple price API');
    expect(result.usdMicrosById).toEqual({ ethereum: 2_500_125_000n, 'usd-coin': 1_000_000n });
    expect(Number.isFinite(Date.parse(result.fetchedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(result.pricesUpdatedAt))).toBe(true);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('include_last_updated_at')).toBe('true');
  });

  it('fails closed when the source omits a required asset price or is unavailable', async () => {
    const missing = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(fetchMainnetOneClickUsdPrices(['ethereum'], missing)).rejects.toThrow('did not return a USD price');

    const unavailable = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(fetchMainnetOneClickUsdPrices(['ethereum'], unavailable)).rejects.toThrow('failed (503)');
  });

  it('fails closed on stale, future, and zero prices', async () => {
    const stale = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(
      new Response(JSON.stringify({ ethereum: { usd: 1, last_updated_at: 1 } }), { status: 200 })
    );
    await expect(fetchMainnetOneClickUsdPrices(['ethereum'], stale)).rejects.toThrow('stale or invalid');

    const future = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(
      new Response(JSON.stringify({ ethereum: { usd: 1, last_updated_at: Math.floor(TEST_NOW.getTime() / 1000) + 60 } }), { status: 200 })
    );
    await expect(fetchMainnetOneClickUsdPrices(['ethereum'], future)).rejects.toThrow('stale or invalid');

    const zero = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(
      new Response(JSON.stringify({ ethereum: { usd: 0, last_updated_at: Math.floor(TEST_NOW.getTime() / 1000) } }), { status: 200 })
    );
    await expect(fetchMainnetOneClickUsdPrices(['ethereum'], zero)).rejects.toThrow('stale or invalid');
  });
});
