import * as Passworder from 'lib/miden/passworder';

import { encryptAndSaveMany, fetchAndDecryptOne, getPlain, isStored, removeMany, savePlain } from './safe-storage';

jest.setTimeout(30_000);

// We mock the storage adapter so we can run without browser.storage / localStorage.
// `getStorageProvider` is called lazily inside safe-storage, so the mock just
// needs to return an in-memory object.
const memoryStore: Record<string, any> = {};
const mockProvider = {
  get: jest.fn(async (keys: string[]) => {
    const out: Record<string, any> = {};
    for (const k of keys) if (k in memoryStore) out[k] = memoryStore[k];
    return out;
  }),
  set: jest.fn(async (items: Record<string, any>) => {
    Object.assign(memoryStore, items);
  }),
  remove: jest.fn(async (keys: string[]) => {
    for (const k of keys) delete memoryStore[k];
  })
};

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: jest.fn(() => mockProvider),
  StorageProvider: class {}
}));

async function makeVaultKey(): Promise<CryptoKey> {
  const raw = Passworder.generateVaultKey();
  return Passworder.importVaultKey(raw);
}

beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  mockProvider.get.mockClear();
  mockProvider.set.mockClear();
  mockProvider.remove.mockClear();
});

describe('safe-storage', () => {
  describe('savePlain / getPlain', () => {
    it('stores and retrieves a raw value by the provided key (no hashing)', async () => {
      await savePlain('rawKey', { hello: 'world' });
      expect(memoryStore['rawKey']).toEqual({ hello: 'world' });
      const read = await getPlain<{ hello: string }>('rawKey');
      expect(read).toEqual({ hello: 'world' });
    });

    it('returns undefined when the key is missing', async () => {
      expect(await getPlain('nope')).toBeUndefined();
    });
  });

  describe('isStored', () => {
    it('returns false when nothing is stored', async () => {
      expect(await isStored('missing')).toBe(false);
    });

    it('returns true after encryptAndSaveMany saves under a hashed key', async () => {
      const key = await makeVaultKey();
      await encryptAndSaveMany([['present', { v: 1 }]], key);
      expect(await isStored('present')).toBe(true);
    });
  });

  describe('encryptAndSaveMany / fetchAndDecryptOne with vault (AES-GCM) key', () => {
    it('round-trips a single item', async () => {
      const key = await makeVaultKey();
      await encryptAndSaveMany([['k', { nested: { answer: 42 } }]], key);
      const decoded = await fetchAndDecryptOne<{ nested: { answer: number } }>('k', key);
      expect(decoded).toEqual({ nested: { answer: 42 } });
    });

    it('round-trips multiple items in one call', async () => {
      const key = await makeVaultKey();
      await encryptAndSaveMany(
        [
          ['a', 'alpha'],
          ['b', 'beta'],
          ['c', { list: [1, 2, 3] }]
        ],
        key
      );
      expect(await fetchAndDecryptOne('a', key)).toBe('alpha');
      expect(await fetchAndDecryptOne('b', key)).toBe('beta');
      expect(await fetchAndDecryptOne('c', key)).toEqual({ list: [1, 2, 3] });
    });

    it('fetchAndDecryptOne throws when the key is missing', async () => {
      const key = await makeVaultKey();
      await expect(fetchAndDecryptOne('ghost', key)).rejects.toThrow(/not found/);
    });

    it('stores keys as hex-digest (hashed), not plaintext', async () => {
      const key = await makeVaultKey();
      await encryptAndSaveMany([['visible', 'x']], key);
      expect(Object.keys(memoryStore)).toHaveLength(1);
      expect(Object.keys(memoryStore)[0]).not.toBe('visible');
      expect(Object.keys(memoryStore)[0]).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('removeMany', () => {
    it('removes previously-saved items by their plaintext keys', async () => {
      const key = await makeVaultKey();
      await encryptAndSaveMany(
        [
          ['x', 1],
          ['y', 2]
        ],
        key
      );
      expect(Object.keys(memoryStore)).toHaveLength(2);
      await removeMany(['x', 'y']);
      expect(Object.keys(memoryStore)).toHaveLength(0);
    });
  });
});
