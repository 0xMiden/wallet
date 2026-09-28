import {
  _resetTokenListForTest,
  loadVerifiedFaucetIds,
  onTokenListUpdated,
  TOKEN_LIST_TTL_MS,
  tokenListUrl
} from './runtime';

jest.mock('lib/miden/swap/tokens', () => ({ normalizedFaucetId: (id: string) => id }));

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
    set: jest.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
    remove: jest.fn(async (keys: string[]) => keys.forEach(k => delete data[k]))
  };
};

const response = (body: unknown, init: { ok?: boolean; length?: number } = {}) => ({
  ok: init.ok ?? true,
  headers: {
    get: (name: string) => (name === 'content-length' && init.length !== undefined ? String(init.length) : null)
  },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

const NOW = 1_800_000_000_000;
const KEY = 'token_list_cache_v1:testnet';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

let storage: ReturnType<typeof memoryStorage>;
let fetchMock: jest.Mock;
let clock: number;

const setup = (initial: Record<string, unknown> = {}) => {
  storage = memoryStorage(initial);
  fetchMock = jest.fn();
  clock = NOW;
  _resetTokenListForTest({ storage, fetch: fetchMock, now: () => clock });
};

it('builds the raw GitHub URL per network', () => {
  expect(tokenListUrl('testnet')).toBe('https://raw.githubusercontent.com/0xMiden/token-list/main/testnet.json');
});

it('uses a fresh cache and does not fetch', async () => {
  setup({ [KEY]: { fetchedAt: NOW - 1_000, body: doc(['a']) } });
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['a']));
  await flush();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('returns a stale cache at once, refreshes it, and notifies subscribers', async () => {
  setup({ [KEY]: { fetchedAt: NOW - TOKEN_LIST_TTL_MS - 1, body: doc(['old']) } });
  fetchMock.mockResolvedValue(response(doc(['new'])));
  const listener = jest.fn();
  onTokenListUpdated(listener);

  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['old']));
  await flush();
  expect(fetchMock).toHaveBeenCalledWith(
    'https://raw.githubusercontent.com/0xMiden/token-list/main/testnet.json',
    expect.objectContaining({ cache: 'no-store' })
  );
  expect(storage.data[KEY]).toEqual({ fetchedAt: NOW, body: doc(['new']) });
  expect(listener).toHaveBeenCalledWith('testnet');
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['new']));
});

it('prefers a stale cache over the bundled snapshot while offline', async () => {
  setup({ [KEY]: { fetchedAt: NOW - 10 * TOKEN_LIST_TTL_MS, body: doc(['cached']) } });
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['cached']));
});

it('falls back to the bundled snapshot with no cache, and a failed fetch stores nothing', async () => {
  setup();
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const ids = await loadVerifiedFaucetIds('testnet');
  expect(ids).toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
  await flush();
  expect(storage.set).not.toHaveBeenCalled();
});

it.each([
  ['a 404', response('Not Found', { ok: false })],
  ['a malformed document', response({ name: 'x' })],
  ['a declared oversize body', response(doc(['x']), { length: 300 * 1_024 })],
  ['an oversize body', response(`${' '.repeat(300 * 1_024)}${JSON.stringify(doc(['x']))}`)],
  ['invalid JSON', response('{')]
])('keeps the old cache after %s', async (_label, bad) => {
  const cached = { fetchedAt: NOW - TOKEN_LIST_TTL_MS - 1, body: doc(['old']) };
  setup({ [KEY]: cached });
  fetchMock.mockResolvedValue(bad);
  await loadVerifiedFaucetIds('testnet');
  await flush();
  expect(storage.data[KEY]).toEqual(cached);
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['old']));
});

it('returns null for a network with no cache, no snapshot and a failed fetch', async () => {
  setup();
  fetchMock.mockResolvedValue(response('Not Found', { ok: false }));
  await expect(loadVerifiedFaucetIds('devnet')).resolves.toBeNull();
});

it('adopts a fetched list for a network without a snapshot', async () => {
  setup();
  fetchMock.mockResolvedValue(response(doc(['d1'], 'devnet')));
  const listener = jest.fn();
  onTokenListUpdated(listener);
  await expect(loadVerifiedFaucetIds('devnet')).resolves.toBeNull();
  await flush();
  expect(listener).toHaveBeenCalledWith('devnet');
  await expect(loadVerifiedFaucetIds('devnet')).resolves.toEqual(new Set(['d1']));
});

it('shares one fetch between concurrent loads', async () => {
  setup();
  fetchMock.mockResolvedValue(response(doc(['a'])));
  await Promise.all([loadVerifiedFaucetIds('testnet'), loadVerifiedFaucetIds('testnet')]);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('ignores a cache entry of the wrong shape', async () => {
  setup({ [KEY]: 'garbage' });
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const ids = await loadVerifiedFaucetIds('testnet');
  expect(ids).toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
});

it('ignores a cache entry whose fetchedAt is not a number, and refreshes', async () => {
  setup({ [KEY]: { fetchedAt: '2026-09-28', body: doc(['cached']) } });
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const ids = await loadVerifiedFaucetIds('testnet');
  expect(ids).toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
  expect(ids).not.toContain('cached');
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('refreshes a list stamped later than the clock, since its age is unknown', async () => {
  setup({ [KEY]: { fetchedAt: NOW + 60_000, body: doc(['a']) } });
  fetchMock.mockResolvedValue(response(doc(['a'])));
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['a']));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('falls back to the snapshot when storage cannot be read', async () => {
  setup();
  storage.get.mockRejectedValue(new Error('storage unavailable'));
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(loadVerifiedFaucetIds('testnet')).resolves.toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
});

it('stops notifying an unsubscribed listener', async () => {
  setup();
  fetchMock.mockResolvedValue(response(doc(['a'])));
  const listener = jest.fn();
  onTokenListUpdated(listener)();
  await loadVerifiedFaucetIds('testnet');
  await flush();
  expect(listener).not.toHaveBeenCalled();
});

describe('the per-realm memo', () => {
  it('reads storage once for concurrent and repeated loads', async () => {
    setup({ [KEY]: { fetchedAt: NOW - 1_000, body: doc(['a']) } });
    const loads = await Promise.all([1, 2, 3].map(() => loadVerifiedFaucetIds('testnet')));
    loads.push(await loadVerifiedFaucetIds('testnet'));
    loads.forEach(ids => expect(ids).toEqual(new Set(['a'])));
    expect(storage.get).toHaveBeenCalledTimes(1);
  });

  it('still starts a refresh once a memoized list goes stale', async () => {
    setup({ [KEY]: { fetchedAt: NOW - 1_000, body: doc(['a']) } });
    fetchMock.mockResolvedValue(response(doc(['a', 'b'])));
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    clock = NOW - 1_000 + TOKEN_LIST_TTL_MS;
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['a', 'b']));
  });

  it('forgets the memoized list before announcing a refresh, so a listener that loads reads the new one', async () => {
    setup({ [KEY]: { fetchedAt: NOW - TOKEN_LIST_TTL_MS - 1, body: doc(['old']) } });
    fetchMock.mockResolvedValue(response(doc(['new'])));
    let reloaded: Promise<Set<string> | null> | undefined;
    onTokenListUpdated(network => {
      reloaded = loadVerifiedFaucetIds(network);
    });
    await loadVerifiedFaucetIds('testnet');
    await flush();
    await expect(reloaded).resolves.toEqual(new Set(['new']));
    expect(storage.get).toHaveBeenCalledTimes(2);
  });
});
