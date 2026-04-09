/**
 * Tests for the recent-dapps store.
 *
 * The store uses `@capacitor/preferences` for persistence and keeps a
 * module-scoped in-memory cache. We mock the plugin so tests can drive
 * the underlying persistence layer directly, and we `jest.isolateModules`
 * inside each test that needs to reset the module cache.
 */

const store: Record<string, string> = {};
const mockGet = jest.fn(async ({ key }: { key: string }) => ({ value: store[key] ?? null }));
const mockSet = jest.fn(async ({ key, value }: { key: string; value: string }) => {
  store[key] = value;
});
const mockRemove = jest.fn(async ({ key }: { key: string }) => {
  delete store[key];
});

jest.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (...args: unknown[]) => mockGet(...(args as [{ key: string }])),
    set: (...args: unknown[]) => mockSet(...(args as [{ key: string; value: string }])),
    remove: (...args: unknown[]) => mockRemove(...(args as [{ key: string }]))
  }
}));

const STORAGE_KEY = 'miden:dapp-browser:recents';

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  mockGet.mockClear();
  mockSet.mockClear();
  mockRemove.mockClear();
  jest.resetModules();
});

describe('getRecentDapps', () => {
  it('returns an empty array when nothing is stored', async () => {
    const { getRecentDapps } = await import('./recent-dapps');
    expect(await getRecentDapps()).toEqual([]);
  });

  it('returns an empty array when the stored value is not an array', async () => {
    store[STORAGE_KEY] = JSON.stringify({ not: 'an array' });
    const { getRecentDapps } = await import('./recent-dapps');
    expect(await getRecentDapps()).toEqual([]);
  });

  it('returns an empty array when the stored value is invalid JSON', async () => {
    store[STORAGE_KEY] = '{{{ not json';
    const { getRecentDapps } = await import('./recent-dapps');
    expect(await getRecentDapps()).toEqual([]);
  });

  it('returns entries sorted newest-first', async () => {
    store[STORAGE_KEY] = JSON.stringify([
      { url: 'https://a', name: 'a', origin: 'https://a', lastOpenedAt: 100 },
      { url: 'https://b', name: 'b', origin: 'https://b', lastOpenedAt: 300 },
      { url: 'https://c', name: 'c', origin: 'https://c', lastOpenedAt: 200 }
    ]);
    const { getRecentDapps } = await import('./recent-dapps');
    const recents = await getRecentDapps();
    expect(recents.map(r => r.url)).toEqual(['https://b', 'https://c', 'https://a']);
  });
});

describe('recordRecentDapp', () => {
  it('inserts a new entry at the head', async () => {
    const { recordRecentDapp, getRecentDapps } = await import('./recent-dapps');
    await recordRecentDapp({ url: 'https://miden.xyz', name: 'miden.xyz', origin: 'https://miden.xyz' });
    const recents = await getRecentDapps();
    expect(recents).toHaveLength(1);
    expect(recents[0]!.url).toBe('https://miden.xyz');
    expect(recents[0]!.lastOpenedAt).toBeGreaterThan(0);
  });

  it('refreshes an existing entry instead of duplicating it', async () => {
    const { recordRecentDapp, getRecentDapps } = await import('./recent-dapps');
    await recordRecentDapp({ url: 'https://miden.xyz', name: 'miden.xyz', origin: 'https://miden.xyz' });
    await new Promise(resolve => setTimeout(resolve, 5));
    await recordRecentDapp({ url: 'https://miden.xyz', name: 'Miden (updated)', origin: 'https://miden.xyz' });
    const recents = await getRecentDapps();
    expect(recents).toHaveLength(1);
    expect(recents[0]!.name).toBe('Miden (updated)');
  });

  it('caps the list at MAX_RECENTS = 12 entries, dropping the oldest', async () => {
    const { recordRecentDapp, getRecentDapps } = await import('./recent-dapps');
    for (let i = 0; i < 15; i++) {
      await recordRecentDapp({ url: `https://dapp${i}.test`, name: `dapp${i}`, origin: `https://dapp${i}.test` });
    }
    const recents = await getRecentDapps();
    expect(recents).toHaveLength(12);
    // Newest first: dapp14 is most recent; dapp0..dapp2 should have been evicted.
    expect(recents[0]!.url).toBe('https://dapp14.test');
    expect(recents.find(r => r.url === 'https://dapp0.test')).toBeUndefined();
    expect(recents.find(r => r.url === 'https://dapp2.test')).toBeUndefined();
    expect(recents.find(r => r.url === 'https://dapp3.test')).toBeDefined();
  });

  it('persists to @capacitor/preferences', async () => {
    const { recordRecentDapp } = await import('./recent-dapps');
    await recordRecentDapp({ url: 'https://miden.xyz', name: 'miden', origin: 'https://miden.xyz' });
    expect(mockSet).toHaveBeenCalled();
    expect(store[STORAGE_KEY]!).toBeDefined();
    const stored = JSON.parse(store[STORAGE_KEY]!);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.url).toBe('https://miden.xyz');
  });
});

describe('forgetRecentDapp', () => {
  it('removes an entry by URL', async () => {
    const { recordRecentDapp, forgetRecentDapp, getRecentDapps } = await import('./recent-dapps');
    await recordRecentDapp({ url: 'https://a', name: 'a', origin: 'https://a' });
    await recordRecentDapp({ url: 'https://b', name: 'b', origin: 'https://b' });
    await forgetRecentDapp('https://a');
    const recents = await getRecentDapps();
    expect(recents.map(r => r.url)).toEqual(['https://b']);
  });

  it('is a no-op for a URL that isn\u2019t in the list', async () => {
    const { recordRecentDapp, forgetRecentDapp, getRecentDapps } = await import('./recent-dapps');
    await recordRecentDapp({ url: 'https://a', name: 'a', origin: 'https://a' });
    await forgetRecentDapp('https://nonexistent');
    const recents = await getRecentDapps();
    expect(recents).toHaveLength(1);
  });
});

describe('migration', () => {
  it('drops entries whose host is in PURGED_RECENT_HOSTS', async () => {
    // Seed storage with the legacy x.com / twitter.com / uniswap entries.
    store[STORAGE_KEY] = JSON.stringify([
      { url: 'https://x.com/', name: 'X', origin: 'https://x.com', lastOpenedAt: 100 },
      { url: 'https://twitter.com/', name: 'Twitter', origin: 'https://twitter.com', lastOpenedAt: 200 },
      { url: 'https://app.uniswap.org/', name: 'Uniswap', origin: 'https://app.uniswap.org', lastOpenedAt: 300 },
      { url: 'https://miden.xyz/', name: 'Miden', origin: 'https://miden.xyz', lastOpenedAt: 400 }
    ]);
    const { getRecentDapps } = await import('./recent-dapps');
    const recents = await getRecentDapps();
    expect(recents.map(r => r.url)).toEqual(['https://miden.xyz/']);
  });

  it('rewrites legacy raw-URL name entries with the hostname', async () => {
    store[STORAGE_KEY] = JSON.stringify([
      // Legacy: name is the full URL because the launcher used to write it verbatim.
      { url: 'https://miden.xyz/swap', name: 'https://miden.xyz/swap', origin: 'https://miden.xyz', lastOpenedAt: 1 }
    ]);
    const { getRecentDapps } = await import('./recent-dapps');
    const recents = await getRecentDapps();
    expect(recents[0]!.name).toBe('miden.xyz');
  });

  it('migration is idempotent: persisted list is clean on next read', async () => {
    store[STORAGE_KEY] = JSON.stringify([
      { url: 'https://x.com/', name: 'X', origin: 'https://x.com', lastOpenedAt: 100 }
    ]);
    const { getRecentDapps } = await import('./recent-dapps');
    await getRecentDapps(); // triggers migration + persist
    // Allow the fire-and-forget write to settle.
    await Promise.resolve();
    await Promise.resolve();
    const stored = JSON.parse(store[STORAGE_KEY]!);
    expect(stored).toEqual([]);
  });
});
