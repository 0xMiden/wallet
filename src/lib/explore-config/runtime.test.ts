import {
  _resetExploreConfigRuntimeForTest,
  FOREGROUND_STALE_MS,
  getExploreCatalogSnapshot,
  initExploreConfig,
  MAX_BACKOFF_MS,
  POLL_MS,
  subscribeExploreCatalog
} from './runtime';
import type { ExploreCatalog } from './schema';
import type { StoredExploreConfig } from './source';

let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));

const mockChangeHandlers = new Map<string, Set<() => void>>();
const mockRereads: Array<() => Promise<void>> = [];
// What the next subscription reports as its listener being attached; undefined as off the extension.
let mockAttached: Promise<void> | undefined;
jest.mock('lib/miden/front/storage', () => ({
  registerStorageReread: (reread: () => Promise<void>) => mockRereads.push(reread),
  onStorageChanged: (key: string, handler: () => void) => {
    const handlers = mockChangeHandlers.get(key) ?? new Set<() => void>();
    handlers.add(handler);
    mockChangeHandlers.set(key, handlers);
    return Object.assign(() => handlers.delete(handler), { attached: mockAttached });
  }
}));

const catalog = (network: string, version: number): ExploreCatalog => ({ network, version, items: [], sections: [] });
// What storage holds per network, as a fetch here or another realm left it.
const mockStored = new Map<string, StoredExploreConfig>();
const mockReadStored = jest.fn(async (network: string) => mockStored.get(network) ?? null);
const mockFetch = jest.fn<Promise<StoredExploreConfig>, [string]>();
let mockBundledVersion: number | null = 1;
jest.mock('./source', () => ({
  exploreConfigCacheKey: (network: string) => `explore_config_v1:${network}`,
  readStoredExploreConfig: (network: string) => mockReadStored(network),
  fetchAndStoreExploreConfig: (network: string) => mockFetch(network),
  bundledExploreCatalog: (network: string) =>
    mockBundledVersion === null ? null : catalog(network, mockBundledVersion)
}));

const NOW = 1_800_000_000_000;
const KEY = 'explore_config_v1:testnet';

const store = (network: string, version: number, fetchedAt = Date.now()): StoredExploreConfig => {
  const entry = { catalog: catalog(network, version), fetchedAt };
  mockStored.set(network, entry);
  return entry;
};
const serve = (version: number) => mockFetch.mockImplementation(async network => store(network, version));
const failFetch = () => mockFetch.mockRejectedValue(new Error('HTTP 503'));
const hold = () => {
  let land!: (entry: StoredExploreConfig) => void;
  mockFetch.mockImplementationOnce(
    () =>
      new Promise<StoredExploreConfig>(resolve => {
        land = resolve;
      })
  );
  return (network: string, version: number) => land({ catalog: catalog(network, version), fetchedAt: Date.now() });
};
const fireChange = (key: string) => mockChangeHandlers.get(key)?.forEach(handler => handler());
const flush = () => jest.advanceTimersByTimeAsync(0);
const shownVersion = () => getExploreCatalogSnapshot()?.version ?? null;

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterAll(() => {
  Reflect.deleteProperty(document, 'visibilityState');
});

let warn: jest.SpyInstance;

beforeEach(() => {
  _resetExploreConfigRuntimeForTest();
  jest.useFakeTimers({ now: NOW });
  mockNetwork = 'testnet';
  mockAttached = undefined;
  mockStored.clear();
  mockBundledVersion = 1;
  visibility = 'visible';
  mockReadStored.mockClear();
  mockFetch.mockReset().mockRejectedValue(new Error('unexpected fetch'));
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

describe('the snapshot', () => {
  it('is the bundled catalog before anything is read, one object until it changes', () => {
    const first = getExploreCatalogSnapshot();
    expect(first).toEqual(catalog('testnet', 1));
    expect(getExploreCatalogSnapshot()).toBe(first);
    expect(mockReadStored).not.toHaveBeenCalled();
  });

  it('is null on a network with no bundled catalog until a copy lands', async () => {
    mockBundledVersion = null;
    mockNetwork = 'localnet';
    failFetch();
    await initExploreConfig('localnet');
    await flush();
    expect(getExploreCatalogSnapshot()).toBeNull();
    serve(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getExploreCatalogSnapshot()).toEqual(catalog('localnet', 1));
  });

  it('takes the stored copy at any age over the bundled one', async () => {
    store('testnet', 2, NOW - 30 * 86_400_000);
    failFetch();
    await initExploreConfig('testnet');
    expect(shownVersion()).toBe(2);
  });

  it('keeps the bundled catalog over a stored copy older than it', async () => {
    mockBundledVersion = 3;
    store('testnet', 2, NOW - 60_000);
    await initExploreConfig('testnet');
    expect(shownVersion()).toBe(3);
  });

  it('keeps each network to its own catalog across a switch', async () => {
    store('testnet', 2, NOW - 60_000);
    await initExploreConfig('testnet');
    mockNetwork = 'devnet';
    expect(getExploreCatalogSnapshot()).toEqual(catalog('devnet', 1));
    failFetch();
    await initExploreConfig('devnet');
    await flush();
    // One timer, for the network the launcher shows now.
    expect(jest.getTimerCount()).toBe(1);
    mockNetwork = 'testnet';
    expect(shownVersion()).toBe(2);
  });

  it('tells a subscriber what lands until it unsubscribes', async () => {
    serve(2);
    const listener = jest.fn();
    const unsubscribe = subscribeExploreCatalog(listener);
    await initExploreConfig('testnet');
    await flush();
    expect(shownVersion()).toBe(2);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    store('testnet', 3);
    fireChange(KEY);
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('initExploreConfig', () => {
  it('never waits for the network, and starts one read and one fetch however often it is called', async () => {
    mockFetch.mockImplementation(() => new Promise<StoredExploreConfig>(() => undefined));
    await Promise.all([initExploreConfig('testnet'), initExploreConfig('testnet')]);
    await initExploreConfig('testnet');
    expect(mockReadStored).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // No timer runs while the fetch is out, however long it takes.
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reads storage only once the change listener is attached', async () => {
    let attach!: () => void;
    mockAttached = new Promise<void>(resolve => {
      attach = resolve;
    });
    store('testnet', 2, NOW - 60_000);
    void initExploreConfig('testnet');
    await flush();
    expect(mockReadStored).not.toHaveBeenCalled();
    expect(shownVersion()).toBe(1);
    attach();
    await flush();
    expect(mockReadStored).toHaveBeenCalledTimes(1);
    expect(shownVersion()).toBe(2);
  });

  it('leaves a copy under 15 minutes old alone, and refreshes an older one', async () => {
    store('testnet', 2, NOW - FOREGROUND_STALE_MS + 1);
    await initExploreConfig('testnet');
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();

    _resetExploreConfigRuntimeForTest();
    store('testnet', 2, NOW - FOREGROUND_STALE_MS);
    serve(2);
    await initExploreConfig('testnet');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('treats a copy stamped later than the clock as stale', async () => {
    store('testnet', 2, NOW + 60_000);
    serve(2);
    await initExploreConfig('testnet');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads storage but waits for the foreground to fetch while the document is hidden', async () => {
    visibility = 'hidden';
    serve(2);
    await initExploreConfig('testnet');
    await flush();
    expect(mockReadStored).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    setVisibility('visible');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(shownVersion()).toBe(2);
  });
});

describe('the cadence', () => {
  it('refreshes hourly while healthy', async () => {
    serve(2);
    await initExploreConfig('testnet');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the catalog on screen when a fetch fails, retrying after 60 s doubling to 15 minutes', async () => {
    store('testnet', 2, NOW - POLL_MS);
    failFetch();
    await initExploreConfig('testnet');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const delays = [60_000, 120_000, 240_000, 480_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS];
    for (const [index, delay] of delays.entries()) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(mockFetch).toHaveBeenCalledTimes(index + 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(index + 2);
    }
    expect(shownVersion()).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('testnet'),
      expect.objectContaining({ message: 'HTTP 503' })
    );
  });

  it('goes back to the hourly cadence once a retry lands', async () => {
    failFetch();
    await initExploreConfig('testnet');
    await flush();
    serve(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('runs no timer while hidden, and refreshes on a return once the copy is over 15 minutes old', async () => {
    store('testnet', 2, NOW);
    serve(2);
    await initExploreConfig('testnet');
    setVisibility('hidden');
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(POLL_MS);
    expect(mockFetch).not.toHaveBeenCalled();
    setVisibility('visible');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('starts no timer when a refresh lands while hidden', async () => {
    const land = hold();
    await initExploreConfig('testnet');
    setVisibility('hidden');
    land('testnet', 2);
    await flush();
    expect(shownVersion()).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the hourly refresh on time across a return within 15 minutes', async () => {
    store('testnet', 2, NOW);
    serve(2);
    await initExploreConfig('testnet');
    setVisibility('hidden');
    await jest.advanceTimersByTimeAsync(FOREGROUND_STALE_MS - 1);
    setVisibility('visible');
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(POLL_MS - FOREGROUND_STALE_MS);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('other realms and wipes', () => {
  it('adopts a newer copy another realm stores, and ignores an older one or a removal', async () => {
    store('testnet', 2, NOW - 60_000);
    await initExploreConfig('testnet');
    store('testnet', 3);
    fireChange(KEY);
    await flush();
    expect(shownVersion()).toBe(3);
    store('testnet', 2);
    fireChange(KEY);
    await flush();
    expect(shownVersion()).toBe(3);
    mockStored.clear();
    fireChange(KEY);
    await flush();
    expect(shownVersion()).toBe(3);
  });

  it("takes another realm's copy while hidden without starting a timer", async () => {
    store('testnet', 2, NOW);
    await initExploreConfig('testnet');
    setVisibility('hidden');
    store('testnet', 3);
    fireChange(KEY);
    await flush();
    expect(shownVersion()).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("counts another realm's refresh of the same copy as its own check", async () => {
    store('testnet', 2, NOW);
    serve(2);
    await initExploreConfig('testnet');
    await jest.advanceTimersByTimeAsync(POLL_MS / 2);
    store('testnet', 2);
    fireChange(KEY);
    await flush();
    await jest.advanceTimersByTimeAsync(POLL_MS / 2);
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(POLL_MS / 2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer copy adopted while its own fetch was out', async () => {
    const land = hold();
    await initExploreConfig('testnet');
    store('testnet', 5);
    fireChange(KEY);
    await flush();
    land('testnet', 4);
    await flush();
    expect(shownVersion()).toBe(5);
  });

  it('lands a fetch for a network left mid-flight on that network only', async () => {
    const land = hold();
    await initExploreConfig('testnet');
    mockNetwork = 'devnet';
    failFetch();
    await initExploreConfig('devnet');
    land('testnet', 4);
    await flush();
    expect(getExploreCatalogSnapshot()).toEqual(catalog('devnet', 1));
    mockNetwork = 'testnet';
    expect(shownVersion()).toBe(4);
  });

  it('forgets the copies a wipe removed and reads the shown network again at once', async () => {
    store('testnet', 2, NOW - 60_000);
    await initExploreConfig('testnet');
    expect(shownVersion()).toBe(2);
    mockStored.clear();
    serve(3);
    await Promise.all(mockRereads.map(reread => reread()));
    expect(shownVersion()).toBe(1);
    // The forgotten entry no longer listens; only the new one does, and the re-read is registered once.
    expect(mockChangeHandlers.get(KEY)?.size).toBe(1);
    expect(mockRereads).toHaveLength(1);
    await flush();
    expect(shownVersion()).toBe(3);
  });
});
