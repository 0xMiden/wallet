import { EXPLORE_CONFIG_FLOOR_KEY } from './floor-key';
import {
  _setExploreConfigSourceDepsForTest,
  exploreConfigBaseUrl,
  exploreConfigCacheKey,
  exploreConfigUrl,
  fetchAndStoreExploreConfig,
  PUBLISHED_EXPLORE_BASE_URL,
  readStoredExploreConfig
} from './source';

// The floor rules themselves are `lib/versioned-document`'s, tested there; these pin what the Explore catalog gives it.
const NOW = 1_800_000_000_000;
const KEY = 'explore_config_v1:testnet';
const FLOOR = 'explore_config_floor_v1';
const PUBLISHED = 'https://raw.githubusercontent.com/0xMiden/wallet-explore/main';
const SERVED_BASE = 'http://127.0.0.1:8551/explore';

const faucet = (url = 'https://faucet.example/') => ({
  id: 'faucet',
  name: { en: 'Faucet' },
  tagline: { en: 'Get testnet tokens' },
  url,
  category: 'tools',
  icon: 'icons/faucet.png',
  isExchange: false
});
const featured = { id: 'featured', kind: 'featured', title: { en: 'Featured' }, itemIds: ['faucet'] };
const doc = (version: number, items = [faucet()]) => ({ network: 'testnet', version, items, sections: [featured] });
const parsed = (version: number, base = PUBLISHED, url = 'https://faucet.example/') => ({
  network: 'testnet',
  version,
  items: [{ ...faucet(url), icon: `${base}/icons/faucet.png` }],
  sections: [featured]
});
// A catalog an E2E harness serves, opening its local fixture dApp.
const localDoc = (version: number) => doc(version, [faucet('http://127.0.0.1:4173/')]);

const memoryStorage = (initial: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: jest.fn(async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]))),
    set: jest.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
    remove: jest.fn(async (keys: string[]) => keys.forEach(k => delete data[k]))
  };
};
const response = (body: unknown, length?: number) => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => (name === 'content-length' && length !== undefined ? String(length) : null) },
  text: async () => JSON.stringify(body)
});

let storage: ReturnType<typeof memoryStorage>;
let fetchMock: jest.Mock;

const setup = (initial: Record<string, unknown> = {}) => {
  storage = memoryStorage(initial);
  fetchMock = jest.fn();
  _setExploreConfigSourceDepsForTest({ storage, fetch: fetchMock, now: () => NOW });
};

const setEnv = (e2e: string | undefined, url: string | undefined) => {
  if (e2e === undefined) delete process.env.MIDEN_E2E_TEST;
  else process.env.MIDEN_E2E_TEST = e2e;
  if (url === undefined) delete process.env.MIDEN_EXPLORE_CONFIG_URL;
  else process.env.MIDEN_EXPLORE_CONFIG_URL = url;
};
const savedEnv = { e2e: process.env.MIDEN_E2E_TEST, url: process.env.MIDEN_EXPLORE_CONFIG_URL };

beforeEach(() => setEnv(undefined, undefined));

afterAll(() => {
  setEnv(savedEnv.e2e, savedEnv.url);
  _setExploreConfigSourceDepsForTest();
});

describe('exploreConfigUrl', () => {
  it('reads the published repo, one file per network', () => {
    expect(PUBLISHED_EXPLORE_BASE_URL).toBe(PUBLISHED);
    expect(exploreConfigBaseUrl()).toBe(PUBLISHED);
    expect(exploreConfigUrl('devnet')).toBe(`${PUBLISHED}/devnet.json`);
  });

  it('reads the served catalog in an E2E build given MIDEN_EXPLORE_CONFIG_URL', () => {
    setEnv('true', `${SERVED_BASE}//`);
    expect(exploreConfigBaseUrl()).toBe(SERVED_BASE);
    expect(exploreConfigUrl('devnet')).toBe(`${SERVED_BASE}/devnet.json`);
  });

  it.each([
    ['a production build, where MIDEN_E2E_TEST is false', 'false', SERVED_BASE],
    ['a build with no MIDEN_E2E_TEST at all', undefined, SERVED_BASE],
    ['an E2E build whose define left the URL empty', 'true', '']
  ])('ignores MIDEN_EXPLORE_CONFIG_URL in %s', (_label, e2e, url) => {
    setEnv(e2e, url);
    expect(exploreConfigUrl('testnet')).toBe(`${PUBLISHED}/testnet.json`);
  });

  it('keys the stored catalog by network, and the floor once for all networks', () => {
    expect(exploreConfigCacheKey('devnet')).toBe('explore_config_v1:devnet');
    expect(EXPLORE_CONFIG_FLOOR_KEY).toBe(FLOOR);
  });
});

describe('fetchAndStoreExploreConfig', () => {
  it('fetches past the browser cache, stores under its own keys and resolves icons on the published base', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(3)));
    await expect(fetchAndStoreExploreConfig('testnet')).resolves.toEqual({ catalog: parsed(3), fetchedAt: NOW });
    expect(fetchMock).toHaveBeenCalledWith(`${PUBLISHED}/testnet.json`, expect.objectContaining({ cache: 'no-store' }));
    expect(storage.data).toEqual({ [KEY]: { fetchedAt: NOW, body: doc(3) }, [FLOOR]: { testnet: 3 } });
  });

  it('names the Explore catalog when it refuses one below the floor', async () => {
    setup({ [FLOOR]: { testnet: 4 } });
    fetchMock.mockResolvedValue(response(doc(3)));
    await expect(fetchAndStoreExploreConfig('testnet')).rejects.toThrow(
      'the testnet Explore catalog version 3 is below the accepted 4'
    );
  });

  it('refuses a body declared over 32 KB', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(1), 32 * 1_024 + 1));
    await expect(fetchAndStoreExploreConfig('testnet')).rejects.toThrow('too large');
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('abandons a request that never answers after 10 s', async () => {
    jest.useFakeTimers();
    setup();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    );
    let outcome: unknown;
    const pending = fetchAndStoreExploreConfig('testnet').catch((error: unknown) => {
      outcome = error;
    });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toMatchObject({ name: 'TimeoutError' });
    jest.useRealTimers();
  });

  it('accepts a local http app in a catalog an E2E build serves itself, its icons on that same base', async () => {
    setEnv('true', `${SERVED_BASE}/`);
    setup();
    fetchMock.mockResolvedValue(response(localDoc(1)));
    await expect(fetchAndStoreExploreConfig('testnet')).resolves.toEqual({
      catalog: parsed(1, SERVED_BASE, 'http://127.0.0.1:4173/'),
      fetchedAt: NOW
    });
    expect(fetchMock).toHaveBeenCalledWith(`${SERVED_BASE}/testnet.json`, expect.anything());
  });

  it.each([
    ['a production build that leaked the variable', 'false', SERVED_BASE],
    ['an E2E build reading the published repo', 'true', '']
  ])('refuses a local http app in %s', async (_label, e2e, url) => {
    setEnv(e2e, url);
    setup();
    fetchMock.mockResolvedValue(response(localDoc(1)));
    await expect(fetchAndStoreExploreConfig('testnet')).rejects.toThrow('does not validate');
    expect(fetchMock).toHaveBeenCalledWith(`${PUBLISHED}/testnet.json`, expect.anything());
  });
});

describe('readStoredExploreConfig', () => {
  it('reads back what a fetch stored', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(2)));
    await fetchAndStoreExploreConfig('testnet');
    await expect(readStoredExploreConfig('testnet')).resolves.toEqual({ catalog: parsed(2), fetchedAt: NOW });
  });

  it('re-reads a local http app only in the E2E build that served it', async () => {
    setup({ [KEY]: { fetchedAt: NOW, body: localDoc(1) } });
    await expect(readStoredExploreConfig('testnet')).resolves.toBeNull();
    setEnv('true', SERVED_BASE);
    await expect(readStoredExploreConfig('testnet')).resolves.toEqual({
      catalog: parsed(1, SERVED_BASE, 'http://127.0.0.1:4173/'),
      fetchedAt: NOW
    });
  });

  it('reads storage it cannot read as no catalog, and says why under its own tag', async () => {
    setup();
    storage.get.mockRejectedValueOnce(new Error('storage unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(readStoredExploreConfig('testnet')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[explore-config] could not read the stored config for testnet:',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});
