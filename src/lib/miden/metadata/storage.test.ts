import type * as StorageModule from './storage';
import type { AssetMetadata } from './types';

const METADATA_KEY = 'tokens_base_metadata';
const SCHEMA_KEY = 'tokens_base_metadata_schema';

// Each test loads a fresh module, because the module keeps the result of the check for the realm.
function loadStorageModule(): typeof StorageModule {
  let loaded: typeof StorageModule | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof StorageModule>('./storage');
  });
  if (!loaded) throw new Error('storage module did not load');
  return loaded;
}

type MemoryItems = { metadata: Record<string, AssetMetadata> | null; schema: number | null };

function memoryStorage(metadata: Record<string, AssetMetadata> | null, schema: number | null = null) {
  const items: MemoryItems = { metadata, schema };
  const read = jest.fn(async (key: string): Promise<number | null> => {
    switch (key) {
      case SCHEMA_KEY:
        return items.schema;
      default:
        return null;
    }
  });
  const write = jest.fn(async (key: string, value: Record<string, AssetMetadata> | number) => {
    switch (key) {
      case METADATA_KEY:
        if (typeof value === 'object') items.metadata = value;
        break;
      case SCHEMA_KEY:
        if (typeof value === 'number') items.schema = value;
        break;
    }
  });
  const readMetadata = async () => (items.metadata ? { ...items.metadata } : null);
  const writeMetadata = async (next: Record<string, AssetMetadata>) => {
    items.metadata = next;
  };
  return { items, read, write, readMetadata, writeMetadata };
}

// A record of schema 1: the name is a copy of the symbol, plus fields nothing reads now.
const oldShapeRecord = {
  decimals: 6,
  symbol: 'TOK',
  name: 'TOK',
  shouldPreferSymbol: true,
  thumbnailUri: '/misc/token-logos/default.svg'
};

describe('ensureTokensMetadataSchema', () => {
  it('clears an old-shape cache and writes the current schema version', async () => {
    const { ensureTokensMetadataSchema, TOKENS_METADATA_SCHEMA_VERSION } = loadStorageModule();
    const storage = memoryStorage({ 'faucet-1': oldShapeRecord });

    await ensureTokensMetadataSchema(storage.read, storage.write);

    expect(storage.read).toHaveBeenCalledWith(SCHEMA_KEY);
    expect(storage.items.metadata).toEqual({});
    expect(storage.items.schema).toBe(TOKENS_METADATA_SCHEMA_VERSION);
    expect(TOKENS_METADATA_SCHEMA_VERSION).toBe(2);
  });

  it('clears the cache only one time', async () => {
    const { ensureTokensMetadataSchema, updateTokensBaseMetadata } = loadStorageModule();
    const storage = memoryStorage({ 'faucet-1': oldShapeRecord });

    await ensureTokensMetadataSchema(storage.read, storage.write);
    const fresh = { decimals: 6, symbol: 'TOK', name: 'Token', description: 'A token' };
    await updateTokensBaseMetadata({ 'faucet-1': fresh }, storage.readMetadata, storage.writeMetadata);
    await ensureTokensMetadataSchema(storage.read, storage.write);
    await ensureTokensMetadataSchema(storage.read, storage.write);

    expect(storage.items.metadata).toEqual({ 'faucet-1': fresh });
    // One read of the marker and two writes (the clear and the marker), then nothing.
    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(storage.write).toHaveBeenCalledTimes(2);
  });

  it('shares one check between concurrent callers', async () => {
    const { ensureTokensMetadataSchema } = loadStorageModule();
    const storage = memoryStorage({ 'faucet-1': oldShapeRecord });

    await Promise.all([
      ensureTokensMetadataSchema(storage.read, storage.write),
      ensureTokensMetadataSchema(storage.read, storage.write)
    ]);

    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(storage.write).toHaveBeenCalledWith(METADATA_KEY, {});
    expect(storage.write).toHaveBeenCalledTimes(2);
  });

  it('leaves a current-schema cache alone', async () => {
    const { ensureTokensMetadataSchema, TOKENS_METADATA_SCHEMA_VERSION } = loadStorageModule();
    const current = { 'faucet-1': { decimals: 6, symbol: 'TOK', name: 'Token' } };
    const storage = memoryStorage(current, TOKENS_METADATA_SCHEMA_VERSION);

    await ensureTokensMetadataSchema(storage.read, storage.write);

    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.items.metadata).toBe(current);
  });

  it('leaves a cache from a newer schema alone', async () => {
    const { ensureTokensMetadataSchema, TOKENS_METADATA_SCHEMA_VERSION } = loadStorageModule();
    const storage = memoryStorage({}, TOKENS_METADATA_SCHEMA_VERSION + 1);

    await ensureTokensMetadataSchema(storage.read, storage.write);

    expect(storage.write).not.toHaveBeenCalled();
  });

  it('clears the cache when the marker holds an older version', async () => {
    const { ensureTokensMetadataSchema, TOKENS_METADATA_SCHEMA_VERSION } = loadStorageModule();
    const storage = memoryStorage({ 'faucet-1': oldShapeRecord }, 1);

    await ensureTokensMetadataSchema(storage.read, storage.write);

    expect(storage.items.metadata).toEqual({});
    expect(storage.items.schema).toBe(TOKENS_METADATA_SCHEMA_VERSION);
  });

  it('tries again after a failed check', async () => {
    const { ensureTokensMetadataSchema, TOKENS_METADATA_SCHEMA_VERSION } = loadStorageModule();
    const storage = memoryStorage({ 'faucet-1': oldShapeRecord });
    storage.read.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(ensureTokensMetadataSchema(storage.read, storage.write)).rejects.toThrow('storage unavailable');
    expect(storage.items.metadata).toEqual({ 'faucet-1': oldShapeRecord });

    await ensureTokensMetadataSchema(storage.read, storage.write);

    expect(storage.items.metadata).toEqual({});
    expect(storage.items.schema).toBe(TOKENS_METADATA_SCHEMA_VERSION);
  });

  it('runs before a merge that was queued after it', async () => {
    const { ensureTokensMetadataSchema, updateTokensBaseMetadata } = loadStorageModule();
    const storage = memoryStorage({ 'faucet-1': oldShapeRecord });
    const fresh = { decimals: 8, symbol: 'NEW', name: 'New Token' };

    const check = ensureTokensMetadataSchema(storage.read, storage.write);
    const merge = updateTokensBaseMetadata({ 'faucet-2': fresh }, storage.readMetadata, storage.writeMetadata);
    await Promise.all([check, merge]);

    // The old record is gone. The merge read the cache after the clear.
    expect(storage.items.metadata).toEqual({ 'faucet-2': fresh });
  });
});
