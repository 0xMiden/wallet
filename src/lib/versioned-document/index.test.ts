import { versionedDocumentSource } from '.';

interface Toy {
  network: string;
  version: number;
}

const NOW = 1_800_000_000_000;
const FLOOR = 'toy_floor_v1';
const KEY = 'toy_v1:testnet';
const URL_FOR = (network: string) => `https://toys.example/${network}.json`;

const doc = (version: number, extra: Record<string, unknown> = {}) => ({ network: 'testnet', version, ...extra });
const parseToy = jest.fn((body: unknown, network: string): Toy | null => {
  if (typeof body !== 'object' || body === null || !('version' in body) || !('network' in body)) return null;
  const { version, network: named } = body;
  return typeof version === 'number' && version > 0 && named === network ? { network, version } : null;
});

const source = versionedDocumentSource<Toy>({
  label: 'toy document',
  logTag: 'toys',
  floorKey: FLOOR,
  cacheKey: network => `toy_v1:${network}`,
  url: URL_FOR,
  maxBytes: 256,
  timeoutMs: 50,
  parse: parseToy
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
const response = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(body)
});

let storage: ReturnType<typeof memoryStorage>;
let fetchMock: jest.Mock;
const setup = (initial: Record<string, unknown> = {}) => {
  storage = memoryStorage(initial);
  fetchMock = jest.fn();
  source.setDepsForTest({ storage, fetch: fetchMock, now: () => NOW });
};

afterAll(() => source.setDepsForTest());

describe('fetchAndStore', () => {
  it('fetches the network URL past the browser cache, stores the body as fetched and raises the floor', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(3, { extra: true })));
    await expect(source.fetchAndStore('testnet')).resolves.toEqual({
      document: { network: 'testnet', version: 3 },
      fetchedAt: NOW
    });
    expect(fetchMock).toHaveBeenCalledWith(URL_FOR('testnet'), expect.objectContaining({ cache: 'no-store' }));
    expect(storage.data).toEqual({ [KEY]: { fetchedAt: NOW, body: doc(3, { extra: true }) }, [FLOOR]: { testnet: 3 } });
  });

  it('accepts the floor version, the same document again, and any at the floor once a wipe removed it', async () => {
    setup({ [KEY]: { fetchedAt: NOW - 1, body: doc(3) }, [FLOOR]: { testnet: 3 } });
    fetchMock.mockResolvedValue(response(doc(3)));
    await expect(source.fetchAndStore('testnet')).resolves.toMatchObject({ fetchedAt: NOW });
    expect(storage.set.mock.calls).toEqual([[{ [KEY]: { fetchedAt: NOW, body: doc(3) } }]]);

    setup({ [FLOOR]: { testnet: 3 } });
    fetchMock.mockResolvedValue(response(doc(3, { changed: true })));
    await expect(source.fetchAndStore('testnet')).resolves.toMatchObject({ document: { version: 3 } });
  });

  it.each([
    [
      'below the floor',
      { [FLOOR]: { testnet: 4 } },
      doc(3),
      'the testnet toy document version 3 is below the accepted 4'
    ],
    [
      'different from the accepted document at its version',
      { [KEY]: { fetchedAt: NOW - 1, body: doc(3) }, [FLOOR]: { testnet: 3 } },
      doc(3, { changed: true }),
      'the testnet toy document version 3 differs from the accepted document'
    ],
    ['one that does not validate', {}, doc(0), 'the testnet toy document does not validate'],
    ['over the byte cap', {}, doc(1, { padding: 'x'.repeat(300) }), 'too large']
  ])('refuses a document %s and stores nothing', async (_label, initial, body, message) => {
    setup(initial);
    fetchMock.mockResolvedValue(response(body));
    await expect(source.fetchAndStore('testnet')).rejects.toThrow(message);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('raises one network floor and keeps the others, reading a malformed floor entry as none', async () => {
    setup({ [FLOOR]: { devnet: 7, testnet: 'nine', mainnet: -1 } });
    fetchMock.mockResolvedValue(response(doc(2)));
    await source.fetchAndStore('testnet');
    expect(storage.data[FLOOR]).toEqual({ devnet: 7, testnet: 2 });
  });

  it('takes acceptances one at a time, so an older document landing second cannot lower the floor', async () => {
    setup();
    fetchMock.mockResolvedValueOnce(response(doc(5))).mockResolvedValueOnce(response(doc(4)));
    const [newer, older] = await Promise.allSettled([source.fetchAndStore('testnet'), source.fetchAndStore('testnet')]);
    expect(newer.status).toBe('fulfilled');
    expect(older).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('below the accepted 5') })
    });
    expect(storage.data).toEqual({ [KEY]: { fetchedAt: NOW, body: doc(5) }, [FLOOR]: { testnet: 5 } });
  });

  it('abandons a request that outlives its timeout', async () => {
    jest.useFakeTimers();
    setup();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    );
    const pending = source.fetchAndStore('testnet').catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ name: 'TimeoutError' });
    jest.useRealTimers();
  });
});

describe('readStored', () => {
  it('reads back what a fetch stored, validated again', async () => {
    setup();
    fetchMock.mockResolvedValue(response(doc(2)));
    await source.fetchAndStore('testnet');
    parseToy.mockClear();
    await expect(source.readStored('testnet')).resolves.toEqual({
      document: { network: 'testnet', version: 2 },
      fetchedAt: NOW
    });
    expect(parseToy).toHaveBeenCalledWith(doc(2), 'testnet');
  });

  it.each([
    ['nothing stored', {}],
    ['an entry with no timestamp', { [KEY]: 'garbage' }],
    ['a body that no longer validates', { [KEY]: { fetchedAt: NOW, body: doc(0) } }],
    ['a document below the floor', { [KEY]: { fetchedAt: NOW, body: doc(2) }, [FLOOR]: { testnet: 3 } }]
  ])('reads %s as no document', async (_label, initial) => {
    setup(initial);
    await expect(source.readStored('testnet')).resolves.toBeNull();
  });

  it('reads storage it cannot read as no document, and says why under its tag', async () => {
    setup();
    storage.get.mockRejectedValueOnce(new Error('storage unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(source.readStored('testnet')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[toys] could not read the stored config for testnet:', expect.any(Error));
    warn.mockRestore();
  });
});
