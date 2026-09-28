import {
  _resetTokenListForTest,
  loadVerifiedFaucetIds,
  onTokenListUpdated,
  TOKEN_LIST_RETRY_BACKOFF_MS,
  TOKEN_LIST_TTL_MS
} from './runtime';

// Identity unless a test sets the network an encoding would be taken under, which it then prefixes.
let mockNormalizeNetwork: string | null = null;
jest.mock('lib/miden/swap/tokens', () => ({
  normalizedFaucetId: (id: string) => (mockNormalizeNetwork ? `${mockNormalizeNetwork}:${id}` : id)
}));

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
const KEY = 'token_list_cache_v1:testnet';
const ATTEMPT = 'token_list_attempt_v1:testnet';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Runs `body` as on iOS 15 WebKit and Safari before 16, which have no AbortSignal.timeout. */
const withoutAbortSignalTimeout = async (body: () => Promise<void>) => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  Reflect.deleteProperty(AbortSignal, 'timeout');
  try {
    expect('timeout' in AbortSignal).toBe(false);
    await body();
  } finally {
    if (descriptor) Object.defineProperty(AbortSignal, 'timeout', descriptor);
  }
};

let storage: ReturnType<typeof memoryStorage>;
let fetchMock: jest.Mock;
let clock: number;
let warn: jest.SpyInstance;

// A failed refresh warns; the tests that care assert on the spy, and the rest stay quiet.
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const setup = (initial: Record<string, unknown> = {}) => {
  storage = memoryStorage(initial);
  fetchMock = jest.fn();
  clock = NOW;
  mockNormalizeNetwork = null;
  _resetTokenListForTest({ storage, fetch: fetchMock, now: () => clock });
};

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

it('falls back to the bundled snapshot with no cache, and a failed fetch stores no list', async () => {
  setup();
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const ids = await loadVerifiedFaucetIds('testnet');
  expect(ids).toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
  await flush();
  expect(storage.data).toEqual({ [ATTEMPT]: NOW });
});

it.each([
  // A valid list, so only the status can refuse it.
  ['a 404', response(doc(['x']), { ok: false })],
  ['a malformed document', response({ name: 'x' })],
  ['a declared oversize body', response(doc(['x']), { length: 300 * 1_024 })],
  ['an oversize body', response(`${' '.repeat(300 * 1_024)}${JSON.stringify(doc(['x']))}`)],
  ['invalid JSON', response('{')]
])('keeps the old cache and records the attempt after %s', async (_label, bad) => {
  const cached = { fetchedAt: NOW - TOKEN_LIST_TTL_MS - 1, body: doc(['old']) };
  setup({ [KEY]: cached });
  fetchMock.mockResolvedValue(bad);
  await loadVerifiedFaucetIds('testnet');
  await flush();
  expect(storage.data[KEY]).toEqual(cached);
  expect(storage.data[ATTEMPT]).toBe(NOW);
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

it('refreshes at once when a freshly stamped cache entry does not parse', async () => {
  setup({ [KEY]: { fetchedAt: NOW - 1_000, body: { name: 'x' } } });
  fetchMock.mockResolvedValue(response(doc(['a'])));
  await loadVerifiedFaucetIds('testnet');
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('memoizes the ids as the list names them, whatever network is active when the read lands', async () => {
    setup({ [KEY]: { fetchedAt: NOW - 1_000, body: doc(['a']) } });
    const read = storage.get.getMockImplementation()!;
    let releaseRead!: () => void;
    const readHeld = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    storage.get.mockImplementationOnce(async (keys: string[]) => {
      await readHeld;
      return read(keys);
    });
    mockNormalizeNetwork = 'testnet';
    const load = loadVerifiedFaucetIds('testnet');
    // Developer Settings swaps the network in process while the read is pending.
    mockNormalizeNetwork = 'devnet';
    releaseRead();
    await load;
    await expect(loadVerifiedFaucetIds('testnet')).resolves.toEqual(new Set(['a']));
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

describe('the retry backoff', () => {
  it('waits an hour after a failed refresh before the next one', async () => {
    setup();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(storage.data[ATTEMPT]).toBe(NOW);

    clock = NOW + TOKEN_LIST_RETRY_BACKOFF_MS - 1;
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock = NOW + TOKEN_LIST_RETRY_BACKOFF_MS;
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.data[ATTEMPT]).toBe(NOW + TOKEN_LIST_RETRY_BACKOFF_MS);
  });

  it('waits out a failure an earlier realm recorded', async () => {
    setup({ [ATTEMPT]: NOW - TOKEN_LIST_RETRY_BACKOFF_MS + 1 });
    await expect(loadVerifiedFaucetIds('testnet')).resolves.toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits out a failure even when the cached list is stamped ahead of the clock', async () => {
    // A stamp later than the clock makes the list due whatever its age, so only the backoff holds it back.
    setup({ [KEY]: { fetchedAt: NOW + TOKEN_LIST_TTL_MS, body: doc(['a']) } });
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await loadVerifiedFaucetIds('testnet');
    await flush();
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stamped later than the clock', NOW + 60_000],
    ['that is not a number', 'an hour ago']
  ])('ignores a recorded failure %s', async (_label, failedAt) => {
    setup({ [ATTEMPT]: failedAt });
    fetchMock.mockResolvedValue(response(doc(['a'])));
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a failed refresh', () => {
  it('holds off the next refresh for the hour when storage refuses the attempt stamp', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(['x']), { ok: false }));
    storage.set.mockRejectedValue(new Error('quota exceeded'));
    await expect(loadVerifiedFaucetIds('testnet')).resolves.toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
    await flush();
    expect(storage.set).toHaveBeenCalledWith({ [ATTEMPT]: NOW });

    clock = NOW + TOKEN_LIST_RETRY_BACKOFF_MS - 1;
    await expect(loadVerifiedFaucetIds('testnet')).resolves.toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a valid list storage refuses to cache as a failure: no notice, snapshot stands, no refetch', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(['a'])));
    storage.set.mockRejectedValue(new Error('quota exceeded'));
    const listener = jest.fn();
    onTokenListUpdated(listener);
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(listener).not.toHaveBeenCalled();

    clock = NOW + TOKEN_LIST_RETRY_BACKOFF_MS - 1;
    const ids = await loadVerifiedFaucetIds('testnet');
    expect(ids).toContain('mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec');
    expect(ids).not.toContain('a');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 404', response(doc(['x']), { ok: false, status: 404 }), '404'],
    ['a document the parser rejects', response({ name: 'x' }), 'does not parse']
  ])('warns once after %s, naming the network and the reason', async (_label, bad, reason) => {
    setup();
    fetchMock.mockResolvedValue(bad);
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('testnet'),
      expect.objectContaining({ message: expect.stringContaining(reason) })
    );
  });

  it('does not warn after a refresh that lands', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(['a'])));
    await loadVerifiedFaucetIds('testnet');
    await flush();
    expect(storage.data[KEY]).toEqual({ fetchedAt: NOW, body: doc(['a']) });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the request timeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches and stores the list where AbortSignal.timeout does not exist', () =>
    withoutAbortSignalTimeout(async () => {
      setup();
      fetchMock.mockResolvedValue(response(doc(['a'])));
      await loadVerifiedFaucetIds('testnet');
      await flush();
      expect(storage.data[KEY]).toEqual({ fetchedAt: NOW, body: doc(['a']) });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }));

  it('abandons a request that never answers after 10 s, so a later due load fetches again', async () => {
    jest.useFakeTimers();
    setup();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await loadVerifiedFaucetIds('testnet');
    await jest.advanceTimersByTimeAsync(9_999);
    expect(storage.data[ATTEMPT]).toBeUndefined();

    await jest.advanceTimersByTimeAsync(1);
    expect(storage.data[ATTEMPT]).toBe(NOW);

    // Only a released refresh guard lets the load after the backoff start another request.
    clock = NOW + TOKEN_LIST_RETRY_BACKOFF_MS;
    await loadVerifiedFaucetIds('testnet');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves no timer behind once the request settles', async () => {
    jest.useFakeTimers();
    setup();
    fetchMock.mockResolvedValue(response(doc(['a'])));
    await loadVerifiedFaucetIds('testnet');
    await jest.advanceTimersByTimeAsync(0);
    expect(storage.data[KEY]).toEqual({ fetchedAt: NOW, body: doc(['a']) });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('the foreground check', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    jest.restoreAllMocks();
  });

  // Every earlier test loaded a list, so a listener or installed flag the reset left behind fails this.
  it('installs one listener for every load, and a return to the foreground refreshes a stale list once', async () => {
    setup({ [KEY]: { fetchedAt: NOW - 1_000, body: doc(['a']) } });
    const addListener = jest.spyOn(document, 'addEventListener');
    fetchMock.mockResolvedValue(response(doc(['a', 'b'])));
    await Promise.all([1, 2, 3].map(() => loadVerifiedFaucetIds('testnet')));
    expect(addListener.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1);

    clock = NOW - 1_000 + TOKEN_LIST_TTL_MS;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.data[KEY]).toEqual({ fetchedAt: clock, body: doc(['a', 'b']) });
  });
});

it('has no list for localnet, whose faucet ids are per machine, and never fetches or reads one', async () => {
  setup({ 'token_list_cache_v1:localnet': { fetchedAt: NOW, body: doc(['local'], 'localnet') } });
  await expect(loadVerifiedFaucetIds('localnet')).resolves.toBeNull();
  await flush();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(storage.get).not.toHaveBeenCalled();
});
