import {
  _setBridgeConfigSourceDepsForTest,
  BRIDGE_CONFIG_FLOOR_KEY,
  bridgeConfigCacheKey,
  bridgeConfigUrl,
  fetchAndStoreBridgeConfig,
  readStoredBridgeConfig
} from './source';

const NOW = 1_800_000_000_000;
const KEY = 'bridge_config_v1:testnet';
const FLOOR = 'bridge_config_floor_v1';
const PUBLISHED = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/testnet.json';
const SERVED_BASE = 'http://127.0.0.1:8550/config';

const doc = (version: number, overrides: Record<string, unknown> = {}) => ({
  network: 'testnet',
  version,
  epoch: { allocatorUrl: 'https://allocator.example' },
  features: { earn: true },
  ...overrides
});
const parsed = (version: number) => ({
  network: 'testnet',
  version,
  evm: {},
  agglayer: {},
  epoch: { allocatorUrl: 'https://allocator.example' },
  features: { earn: true, fastBridge: false, bridgeIn: false, bridgeOut: false }
});
// A document an E2E harness serves, pointing at its local fakes.
const localDoc = (version: number) => doc(version, { epoch: { allocatorUrl: 'http://127.0.0.1:8548' } });

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

let storage: ReturnType<typeof memoryStorage>;
let fetchMock: jest.Mock;

const setup = (initial: Record<string, unknown> = {}) => {
  storage = memoryStorage(initial);
  fetchMock = jest.fn();
  _setBridgeConfigSourceDepsForTest({ storage, fetch: fetchMock, now: () => NOW });
};

const setEnv = (e2e: string | undefined, url: string | undefined) => {
  if (e2e === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = e2e;
  if (url === undefined) delete process.env.MIDEN_REMOTE_CONFIG_URL;
  else process.env.MIDEN_REMOTE_CONFIG_URL = url;
};
const savedEnv = { e2e: process.env.MIDEN_E2E_TEST, url: process.env.MIDEN_REMOTE_CONFIG_URL };

beforeEach(() => setEnv(undefined, undefined));

afterAll(() => {
  setEnv(savedEnv.e2e, savedEnv.url);
  _setBridgeConfigSourceDepsForTest();
});

describe('bridgeConfigUrl', () => {
  it('reads the published repo, one file per network', () => {
    expect(bridgeConfigUrl('testnet')).toBe(PUBLISHED);
    expect(bridgeConfigUrl('devnet')).toBe('https://raw.githubusercontent.com/0xMiden/wallet-config/main/devnet.json');
  });

  it('reads the served document in an E2E build given MIDEN_REMOTE_CONFIG_URL', () => {
    setEnv('true', `${SERVED_BASE}//`);
    expect(bridgeConfigUrl('devnet')).toBe(`${SERVED_BASE}/devnet.json`);
  });

  it.each([
    ['a production build, where MIDEN_E2E_TEST is false', 'false', SERVED_BASE],
    ['a build with no MIDEN_E2E_TEST at all', undefined, SERVED_BASE],
    ['an E2E build whose define left the URL empty', 'true', '']
  ])('ignores MIDEN_REMOTE_CONFIG_URL in %s', (_label, e2e, url) => {
    setEnv(e2e, url);
    expect(bridgeConfigUrl('testnet')).toBe(PUBLISHED);
  });

  it('keys the stored document by network, and the floor once for all networks', () => {
    expect(bridgeConfigCacheKey('devnet')).toBe('bridge_config_v1:devnet');
    expect(BRIDGE_CONFIG_FLOOR_KEY).toBe(FLOOR);
  });
});

describe('fetchAndStoreBridgeConfig', () => {
  it('fetches past the browser cache, then stores the body as fetched and raises the floor', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(3)));
    await expect(fetchAndStoreBridgeConfig('testnet')).resolves.toEqual({ config: parsed(3), fetchedAt: NOW });
    expect(fetchMock).toHaveBeenCalledWith(PUBLISHED, expect.objectContaining({ cache: 'no-store' }));
    expect(storage.data).toEqual({ [KEY]: { fetchedAt: NOW, body: doc(3) }, [FLOOR]: { testnet: 3 } });
  });

  it('accepts a document at the floor and leaves the floor as it is', async () => {
    setup({ [FLOOR]: { testnet: 3 } });
    fetchMock.mockResolvedValue(response(doc(3)));
    await expect(fetchAndStoreBridgeConfig('testnet')).resolves.toMatchObject({ config: parsed(3) });
    expect(storage.set.mock.calls).toEqual([[{ [KEY]: { fetchedAt: NOW, body: doc(3) } }]]);
  });

  it('refuses a document below the floor and stores nothing', async () => {
    setup({ [FLOOR]: { testnet: 4 } });
    fetchMock.mockResolvedValue(response(doc(3)));
    await expect(fetchAndStoreBridgeConfig('testnet')).rejects.toThrow('below the accepted 4');
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('raises one network floor and keeps the others', async () => {
    setup({ [FLOOR]: { devnet: 7, testnet: 1 } });
    fetchMock.mockResolvedValue(response(doc(2)));
    await fetchAndStoreBridgeConfig('testnet');
    expect(storage.data[FLOOR]).toEqual({ devnet: 7, testnet: 2 });
  });

  it.each([
    ['not an object', 'x'],
    ['a map of versions that are not positive integers', { testnet: 'nine', devnet: -1 }]
  ])('reads a floor that is %s as no floor', async (_label, floor) => {
    setup({ [FLOOR]: floor });
    fetchMock.mockResolvedValue(response(doc(1)));
    await expect(fetchAndStoreBridgeConfig('testnet')).resolves.toMatchObject({ config: parsed(1) });
    expect(storage.data[FLOOR]).toEqual({ testnet: 1 });
  });

  it.each([
    ['a 404', response(doc(1), { ok: false })],
    ['a document that does not validate', response(doc(0))],
    ['a document for another network', response(doc(1, { network: 'devnet' }))],
    ['a declared body over 32 KB', response(doc(1), { length: 32 * 1_024 + 1 })],
    ['a body over 32 KB', response(`${' '.repeat(32 * 1_024)}${JSON.stringify(doc(1))}`)],
    ['a body that is not JSON', response('{')]
  ])('rejects %s and stores nothing', async (_label, bad) => {
    setup();
    fetchMock.mockResolvedValue(bad);
    await expect(fetchAndStoreBridgeConfig('testnet')).rejects.toThrow();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('accepts local http URLs from a document an E2E build serves itself', async () => {
    setEnv('true', `${SERVED_BASE}/`);
    setup();
    fetchMock.mockResolvedValue(response(localDoc(1)));
    await expect(fetchAndStoreBridgeConfig('testnet')).resolves.toMatchObject({
      config: { epoch: { allocatorUrl: 'http://127.0.0.1:8548' } }
    });
    expect(fetchMock).toHaveBeenCalledWith(`${SERVED_BASE}/testnet.json`, expect.anything());
  });

  it.each([
    ['a production build that leaked the variable', 'false', SERVED_BASE],
    ['an E2E build reading the published repo', 'true', '']
  ])('refuses local http URLs in %s', async (_label, e2e, url) => {
    setEnv(e2e, url);
    setup();
    fetchMock.mockResolvedValue(response(localDoc(1)));
    await expect(fetchAndStoreBridgeConfig('testnet')).rejects.toThrow('does not validate');
    expect(fetchMock).toHaveBeenCalledWith(PUBLISHED, expect.anything());
  });

  it('takes acceptances one at a time, so an older document landing second cannot lower the floor', async () => {
    setup();
    fetchMock.mockResolvedValueOnce(response(doc(5))).mockResolvedValueOnce(response(doc(4)));
    const [newer, older] = await Promise.allSettled([
      fetchAndStoreBridgeConfig('testnet'),
      fetchAndStoreBridgeConfig('testnet')
    ]);
    expect(newer.status).toBe('fulfilled');
    expect(older).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('below the accepted 5') })
    });
    expect(storage.data).toEqual({ [KEY]: { fetchedAt: NOW, body: doc(5) }, [FLOOR]: { testnet: 5 } });
  });

  it('abandons a request that never answers after 10 s and stores nothing', async () => {
    jest.useFakeTimers();
    setup();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    let outcome: unknown;
    const pending = fetchAndStoreBridgeConfig('testnet').catch((error: unknown) => {
      outcome = error;
    });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toMatchObject({ name: 'TimeoutError' });
    expect(storage.set).not.toHaveBeenCalled();
  });
});

describe('readStoredBridgeConfig', () => {
  it('reads back what a fetch stored', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(2)));
    await fetchAndStoreBridgeConfig('testnet');
    await expect(readStoredBridgeConfig('testnet')).resolves.toEqual({ config: parsed(2), fetchedAt: NOW });
  });

  it('serves a stored document whatever floor another network holds', async () => {
    setup({ [KEY]: { fetchedAt: NOW, body: doc(2) }, [FLOOR]: { devnet: 9 } });
    await expect(readStoredBridgeConfig('testnet')).resolves.toEqual({ config: parsed(2), fetchedAt: NOW });
  });

  it.each([
    ['nothing stored', {}],
    ['an entry with no timestamp', { [KEY]: 'garbage' }],
    ['a body that does not validate', { [KEY]: { fetchedAt: NOW, body: doc(0) } }],
    ['a document for another network', { [KEY]: { fetchedAt: NOW, body: doc(2, { network: 'devnet' }) } }],
    ['a document below the floor', { [KEY]: { fetchedAt: NOW, body: doc(2) }, [FLOOR]: { testnet: 3 } }]
  ])('reads %s as no document', async (_label, initial) => {
    setup(initial);
    await expect(readStoredBridgeConfig('testnet')).resolves.toBeNull();
  });

  it('reads storage it cannot read as no document, and says why', async () => {
    setup();
    storage.get.mockRejectedValueOnce(new Error('storage unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(readStoredBridgeConfig('testnet')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('testnet'),
      expect.objectContaining({ message: 'storage unavailable' })
    );
    warn.mockRestore();
  });

  it('re-reads local http URLs only in the E2E build that served them', async () => {
    setup({ [KEY]: { fetchedAt: NOW, body: localDoc(1) } });
    await expect(readStoredBridgeConfig('testnet')).resolves.toBeNull();
    setEnv('true', SERVED_BASE);
    await expect(readStoredBridgeConfig('testnet')).resolves.toMatchObject({
      config: { epoch: { allocatorUrl: 'http://127.0.0.1:8548' } }
    });
  });
});
