import {
  _resetTokenListForTest,
  loadTokenLogos,
  loadTokenPriceAssets,
  loadVerifiedFaucetIds,
  onTokenListUpdated,
  peekTokenPriceAssets
} from './runtime';

const doc = (ids: string[], network = 'testnet') => ({
  name: 'list',
  timestamp: '2026-09-28T00:00:00.000Z',
  version: { major: 1, minor: 0, patch: 0 },
  tokens: ids.map(faucetId => ({ network, faucetId, symbol: 'T', name: 'T', decimals: 8 }))
});

const memoryStorage = (initial: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: jest.fn(async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]))),
    set: jest.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: jest.fn(async (keys: string[]) => keys.forEach(k => delete data[k]))
  };
};

const response = (
  body: unknown,
  { ok = true, status = ok ? 200 : 404, length }: { ok?: boolean; status?: number; length?: number } = {}
) => ({
  ok,
  status,
  headers: {
    get: (name: string) => (name === 'content-length' && length !== undefined ? String(length) : null)
  },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

const NOW = 1_800_000_000_000;
const KEY = 'token_list_cache_v2:testnet';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

let storage: ReturnType<typeof memoryStorage>;
let fetchMock: jest.Mock;
let warn: jest.SpyInstance;
const setup = () => {
  storage = memoryStorage();
  fetchMock = jest.fn();
  _resetTokenListForTest({ storage, fetch: fetchMock, now: () => NOW });
};
beforeEach(() => {
  setup();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

it('returns the cache and checks once per launch with HTTP cache revalidation', async () => {
  storage.data[KEY] = { fetchedAt: NOW, body: doc(['old']) };
  fetchMock.mockResolvedValue(response(doc(['new'])));
  const listener = jest.fn();
  onTokenListUpdated(listener);
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['old']));
  await flush();
  expect(fetchMock).toHaveBeenCalledWith(
    'https://raw.githubusercontent.com/0xMiden/token-list/main/testnet.json',
    expect.objectContaining({ cache: 'no-cache' })
  );
  expect(listener).toHaveBeenCalledWith('testnet');
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['new']));
  await Promise.all([loadTokenPriceAssets('testnet'), loadTokenLogos('testnet')]);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  _resetTokenListForTest({ storage, fetch: fetchMock, now: () => NOW + 1 });
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['new']));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('shares one attempt across concurrent consumers', async () => {
  fetchMock.mockResolvedValue(response(doc(['a'])));
  await Promise.all([loadVerifiedFaucetIds('testnet'), loadTokenPriceAssets('testnet'), loadTokenLogos('testnet')]);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  ['a failed request', response(doc(['new']), { ok: false })],
  ['invalid JSON', response('{')],
  ['an invalid document', response({ name: 'invalid' })],
  ['a declared large body', response(doc(['new']), { length: 300 * 1024 })],
  ['a large body', response(' '.repeat(300 * 1024))]
])('keeps persistent data after %s and makes no further attempt', async (_label, bad) => {
  const entry = { fetchedAt: NOW, body: doc(['old']) };
  storage.data[KEY] = entry;
  fetchMock.mockResolvedValue(bad);
  await loadVerifiedFaucetIds('testnet');
  await flush();
  await expect(loadTokenPriceAssets('testnet')).resolves.toEqual(new Map([['old', 'T']]));
  expect(storage.data[KEY]).toEqual(entry);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
});

it('uses the bundled full symbols offline and isolates networks', async () => {
  fetchMock.mockRejectedValue(new TypeError('offline'));
  expect(peekTokenPriceAssets('testnet')).toBeUndefined();
  const assets = await loadTokenPriceAssets('testnet');
  expect(assets?.get('mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h')).toBe('IETH');
  expect(peekTokenPriceAssets('testnet')).toEqual(assets);
  await expect(loadTokenPriceAssets('devnet')).resolves.toBeNull();
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await loadTokenPriceAssets('devnet');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('does not read or fetch a list for localnet', async () => {
  await expect(loadTokenPriceAssets('localnet')).resolves.toBeNull();
  await expect(loadVerifiedFaucetIds('localnet')).resolves.toBeNull();
  await expect(loadTokenLogos('localnet')).resolves.toBeNull();
  expect(peekTokenPriceAssets('localnet')).toBeNull();
  expect(storage.get).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('stops the request after 10 seconds without a second attempt', async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })
  );
  await loadTokenPriceAssets('testnet');
  await jest.advanceTimersByTimeAsync(10_000);
  await loadTokenPriceAssets('testnet');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('testnet'),
    expect.objectContaining({ name: 'TimeoutError' })
  );
  expect(jest.getTimerCount()).toBe(0);
});

it('uses a valid legacy cache until a new list is stored', async () => {
  const key = 'token_list_cache_v1:testnet';
  storage.data[key] = { fetchedAt: NOW, body: doc(['old']) };
  fetchMock.mockResolvedValue(response(doc(['new'])));
  await expect(loadTokenPriceAssets('testnet')).resolves.toEqual(new Map([['old', 'T']]));
  await flush();
  expect(storage.data[key]).toBeUndefined();
  await expect(loadTokenPriceAssets('testnet')).resolves.toEqual(new Map([['new', 'T']]));
});

it('uses the bundled list when storage cannot be read', async () => {
  storage.get.mockRejectedValue(new Error('storage failed'));
  fetchMock.mockRejectedValue(new Error('offline'));
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toContain('mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h');
  await flush();
});

it('keeps the current list when storage cannot save the fetched document', async () => {
  storage.data[KEY] = { fetchedAt: NOW, body: doc(['old']) };
  storage.set.mockRejectedValue(new Error('storage failed'));
  fetchMock.mockResolvedValue(response(doc(['new'])));
  const listener = jest.fn();
  onTokenListUpdated(listener);
  await loadTokenPriceAssets('testnet');
  await flush();
  await expect(loadTokenPriceAssets('testnet')).resolves.toEqual(new Map([['old', 'T']]));
  expect(listener).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('adopts a fetched price override for a network with no bundled list', async () => {
  const body = doc(['coin'], 'devnet');
  fetchMock.mockResolvedValue(
    response({ ...body, tokens: body.tokens.map(token => ({ ...token, binanceAsset: 'ETH' })) })
  );
  await expect(loadTokenPriceAssets('devnet')).resolves.toBeNull();
  await flush();
  await expect(loadTokenPriceAssets('devnet')).resolves.toEqual(new Map([['coin', 'ETH']]));
});
