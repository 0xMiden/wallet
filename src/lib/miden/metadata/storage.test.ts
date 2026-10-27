import type * as AssetsModule from 'lib/miden/front/assets';

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

describe('the cache key', () => {
  it('is the constant front/assets exports, so the schema check clears the key its readers read', async () => {
    // A stand-in value for this module's constant. An importer with its own literal keeps the real value.
    const standIn = 'tokens_base_metadata_stand_in';
    let exported: string | undefined;
    let cleared: string | undefined;
    jest.isolateModules(() => {
      jest.doMock('./storage', () => ({
        ...jest.requireActual<typeof StorageModule>('./storage'),
        TOKENS_BASE_METADATA_STORAGE_KEY: standIn
      }));
      exported = jest.requireActual<typeof AssetsModule>('lib/miden/front/assets').ALL_TOKENS_BASE_METADATA_STORAGE_KEY;
    });
    const storage = memoryStorage({ 'faucet-1': oldShapeRecord });
    const { ensureTokensMetadataSchema, TOKENS_BASE_METADATA_STORAGE_KEY } = loadStorageModule();
    await ensureTokensMetadataSchema(storage.read, async (key, value) => {
      if (typeof value === 'object') cleared = key;
      await storage.write(key, value);
    });

    expect(exported).toBe(standIn);
    expect(cleared).toBe(TOKENS_BASE_METADATA_STORAGE_KEY);
  });
});

describe('Task5 cache metadata', () => {
  const known: AssetMetadata = { symbol: 'TOK', name: 'Known token', decimals: 18, scaleIsUnknown: false };
  const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  it.each(['same field order', 'reordered fields'])(
    'equal metadata with %s queues no persistent write',
    async order => {
      const { updateTokensBaseMetadata } = loadStorageModule();
      const storage = memoryStorage({ active: known }, 2);
      const write = jest.fn(storage.writeMetadata);
      const incoming =
        order === 'same field order'
          ? { ...known }
          : { scaleIsUnknown: false, decimals: 18, name: 'Known token', symbol: 'TOK' };

      await updateTokensBaseMetadata({ active: incoming }, storage.readMetadata, write);

      expect(write).not.toHaveBeenCalled();
      expect(storage.items.metadata?.active).toEqual(known);
    }
  );

  it.each([
    { label: 'entry count', count: 512, description: '' },
    { label: 'total UTF-8 bytes', count: 128, description: '界'.repeat(3000) },
    { label: 'one UTF-8 entry', count: 1, description: '界'.repeat(6000) }
  ])('bounds $label while preserving known scale and overrides', async ({ count, description }) => {
    const { updateTokensBaseMetadata } = loadStorageModule();
    const initial: Record<string, AssetMetadata> = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `old-${index}`,
        { symbol: 'OLD', name: 'Old token', decimals: 8, description }
      ])
    );
    const storage = memoryStorage(initial, 2);
    const userOverrides = { active: { name: 'My token', symbol: 'MINE', decimals: 12 } };
    const independent = new Map<string, unknown>([['tokens_metadata_overrides', userOverrides]]);

    await updateTokensBaseMetadata({ active: known }, storage.readMetadata, async metadata => {
      await storage.writeMetadata(metadata);
      independent.set(METADATA_KEY, metadata);
    });

    const retained = storage.items.metadata ?? {};
    expect(Object.keys(retained).length).toBeLessThanOrEqual(512);
    expect(encodedBytes(retained)).toBeLessThanOrEqual(1_048_576);
    for (const [id, metadata] of Object.entries(retained)) {
      expect(encodedBytes({ [id]: metadata })).toBeLessThanOrEqual(16_384);
    }
    expect(retained.active).toEqual(known);
    expect(independent.get('tokens_metadata_overrides')).toEqual({
      active: { name: 'My token', symbol: 'MINE', decimals: 12 }
    });
  });

  it.each([
    {
      readable: true,
      expectedMetadata: { decimals: 8, scaleIsUnknown: false },
      expectedValuation: { status: 'valued', value: 2_000_000n }
    },
    {
      readable: false,
      expectedMetadata: { scaleIsUnknown: true },
      expectedValuation: { status: 'refused', isUnavailable: true }
    }
  ])(
    'an oversized active entry refetches with readable faucet $readable and never invents scale',
    async ({ readable, expectedMetadata, expectedValuation }) => {
      const mockedModules = [
        './storage',
        'lib/miden/front/storage',
        'lib/miden/assets',
        'lib/miden/sdk/helpers',
        '@miden-sdk/miden-sdk/lazy',
        'lib/miden-chain/constants',
        'lib/miden-chain/native-asset',
        'lib/miden-chain/effective-endpoints',
        'lib/miden/swap/tokens',
        'lib/miden/metadata',
        'lib/prices/usd',
        'lib/prices/feed',
        'lib/remote-config/runtime',
        'lib/token-list/runtime'
      ];
      try {
        await jest.isolateModulesAsync(async () => {
          jest.dontMock('./storage');
          const values = new Map<string, unknown>([
            [METADATA_KEY, {}],
            [SCHEMA_KEY, 2],
            ['tokens_metadata_overrides', { active: { name: 'My token', symbol: 'MINE', decimals: 18 } }]
          ]);
          jest.doMock('lib/miden/front/storage', () => ({
            fetchFromStorage: async (key: string) => values.get(key) ?? null,
            putToStorage: async (key: string, value: unknown) => {
              values.set(key, value);
            }
          }));
          jest.doMock('lib/miden/assets', () => ({ isMidenAsset: () => false }));
          jest.doMock('lib/miden/sdk/helpers', () => ({
            accountRefToSdk: (id: string) => ({ toString: () => id, isPublic: () => true })
          }));
          const { FAUCET_PROOF_WORDS } =
            jest.requireActual<typeof import('./faucet-proof.fixtures')>('./faucet-proof.fixtures');
          const requestProof = jest.fn(async () => ({
            accountHeader: () => (readable ? {} : undefined),
            getStorageSlotValue: (slot: string) => {
              const limbs = FAUCET_PROOF_WORDS[slot];
              return limbs && { toU64s: () => BigUint64Array.from(limbs) };
            }
          }));
          jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
            RpcClient: function () {
              return { getAccountProof: requestProof };
            }
          }));
          jest.doMock('lib/miden-chain/constants', () => ({
            ensureSdkWasmReady: async () => undefined,
            getRpcEndpoint: () => 'https://rpc.invalid'
          }));
          jest.doMock('lib/miden-chain/native-asset', () => ({
            getNativeAssetId: async () => 'native-fee',
            getNativeAssetIdSync: () => 'native-fee',
            getNativeAssetMetadata: async () => ({ symbol: 'MIDEN', decimals: 6 }),
            getNativeAssetMetadataSync: () => ({ symbol: 'MIDEN', decimals: 6 }),
            getSdkSyncedNativeAssetIdSync: () => 'native-fee'
          }));
          jest.doMock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));
          jest.doMock('lib/miden/swap/tokens', () => ({
            canonicalFaucetId: (id: string) => id,
            strictPriceSymbolFor: () => 'ETH'
          }));
          jest.doMock('lib/miden/metadata', () => jest.requireActual('./fetch'));
          jest.doMock('lib/prices/usd', () => ({
            getPriceMicro: async () => 1_000_000n,
            prefetchUsdPrices: async () => undefined
          }));
          jest.doMock('lib/prices/feed', () => ({ hasNoUsdMarket: () => false }));
          jest.doMock('lib/remote-config/runtime', () => ({ initBridgeConfig: async () => undefined }));
          jest.doMock('lib/token-list/runtime', () => ({ loadTokenPriceAssets: async () => null }));
          const { updateTokensBaseMetadata } = jest.requireActual<typeof StorageModule>('./storage');
          let baseMetadata: Record<string, AssetMetadata> = {};
          await updateTokensBaseMetadata(
            { active: { ...known, description: '界'.repeat(6000) } },
            async () => baseMetadata,
            async metadata => {
              baseMetadata = metadata;
              values.set(METADATA_KEY, metadata);
            }
          );
          const { fetchTokenMetadata } = jest.requireActual<typeof import('./fetch')>('./fetch');
          const { resolveSpendsUsd } =
            jest.requireActual<typeof import('../spending-limits/valuation')>('../spending-limits/valuation');
          const { SpendingLimitPriceUnavailableError } =
            jest.requireActual<typeof import('../spending-limits/types')>('../spending-limits/types');
          const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
          try {
            const metadata = await fetchTokenMetadata('active');
            expect(requestProof).toHaveBeenCalledTimes(1);
            expect(metadata).toMatchObject(expectedMetadata);
            const valuation = await resolveSpendsUsd([{ faucetId: 'active', amount: 200_000_000n }], 1000).then(
              value => ({ status: 'valued', value }),
              (error: unknown) => ({
                status: 'refused',
                isUnavailable: error instanceof SpendingLimitPriceUnavailableError
              })
            );
            expect(valuation).toEqual(expectedValuation);
            expect(values.get('tokens_metadata_overrides')).toEqual({
              active: { name: 'My token', symbol: 'MINE', decimals: 18 }
            });
          } finally {
            warn.mockRestore();
          }
        });
      } finally {
        for (const moduleName of mockedModules) jest.dontMock(moduleName);
      }
    }
  );
});

describe('Task5 cache canonical equality', () => {
  it('treats absent and undefined optional metadata as the same persisted record', async () => {
    const { updateTokensBaseMetadata } = loadStorageModule();
    const known: AssetMetadata = { symbol: 'TOK', name: 'Known', decimals: 18 };
    const storage = memoryStorage({ active: known }, 2);
    const write = jest.fn(storage.writeMetadata);
    await updateTokensBaseMetadata({ active: { ...known, description: undefined } }, storage.readMetadata, write);
    expect(write).not.toHaveBeenCalled();
    expect(storage.items.metadata).toEqual({ active: known });
  });
});
