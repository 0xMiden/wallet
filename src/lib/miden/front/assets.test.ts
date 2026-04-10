/* eslint-disable import/first */

const _g = globalThis as any;
_g.__assetsTest = {
  storage: {} as Record<string, any>
};

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) if (k in (globalThis as any).__assetsTest.storage) {
        out[k] = (globalThis as any).__assetsTest.storage[k];
      }
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign((globalThis as any).__assetsTest.storage, items);
    }
  })
}));

jest.mock('lib/store', () => ({
  useWalletStore: jest.fn()
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: jest.fn(() => ({ data: null, mutate: jest.fn() }))
}));

jest.mock('lib/miden/front', () => ({
  fetchFromStorage: async (key: string) => (globalThis as any).__assetsTest.storage[key],
  putToStorage: async (key: string, value: any) => {
    (globalThis as any).__assetsTest.storage[key] = value;
  },
  fetchTokenMetadata: jest.fn(),
  onStorageChanged: jest.fn(() => () => {}),
  usePassiveStorage: jest.fn(() => [{}, jest.fn()]),
  isMidenAsset: (slug: string | object) => slug === 'miden',
  MIDEN_METADATA: { decimals: 6, symbol: 'MIDEN', name: 'Miden', thumbnailUri: '' }
}));

jest.mock('app/hooks/useGasToken', () => ({
  useGasToken: () => ({ metadata: { decimals: 6, symbol: 'MIDEN', name: 'Miden' } })
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: jest.fn(() => 'miden-faucet-id')
}));

import {
  ALL_TOKENS_BASE_METADATA_STORAGE_KEY,
  getTokensBaseMetadata,
  searchAssets,
  setTokensBaseMetadata,
  useAllAssetMetadata
} from './assets';

beforeEach(() => {
  for (const k of Object.keys(_g.__assetsTest.storage)) delete _g.__assetsTest.storage[k];
  jest.clearAllMocks();
});

describe('setTokensBaseMetadata', () => {
  it('persists new metadata merged with the existing entry', async () => {
    _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY] = {
      a: { decimals: 6, symbol: 'A', name: 'A' }
    };
    await setTokensBaseMetadata({ b: { decimals: 8, symbol: 'B', name: 'B' } as any });
    // Wait for the queue to drain
    await new Promise(r => setTimeout(r, 0));
    const stored = _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY];
    expect(stored.a).toBeDefined();
    expect(stored.b).toBeDefined();
  });

  it('initializes the storage when nothing is set', async () => {
    await setTokensBaseMetadata({ first: { decimals: 6, symbol: 'F', name: 'First' } as any });
    await new Promise(r => setTimeout(r, 0));
    const stored = _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY];
    expect(stored?.first).toBeDefined();
  });
});

describe('getTokensBaseMetadata', () => {
  it('returns the stored metadata for the given asset id', async () => {
    _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY] = {
      'asset-1': { decimals: 6, symbol: 'A1', name: 'Asset 1' }
    };
    const result = await getTokensBaseMetadata('asset-1');
    expect(result?.symbol).toBe('A1');
  });

  it('returns undefined when the asset is missing', async () => {
    expect(await getTokensBaseMetadata('missing')).toBeUndefined();
  });

  it('uses the empty default when nothing is stored', async () => {
    expect(await getTokensBaseMetadata('any')).toBeUndefined();
  });
});

describe('useAllAssetMetadata (async helper)', () => {
  it('returns the stored map when present', async () => {
    _g.__assetsTest.storage[ALL_TOKENS_BASE_METADATA_STORAGE_KEY] = { x: { symbol: 'X' } };
    const result = await useAllAssetMetadata();
    expect(result).toEqual({ x: { symbol: 'X' } });
  });

  it('returns the empty default when nothing is stored', async () => {
    const result = await useAllAssetMetadata();
    expect(result).toEqual({});
  });
});

describe('searchAssets', () => {
  const meta: Record<string, any> = {
    'id-eth': { name: 'Ether', symbol: 'ETH' },
    'id-btc': { name: 'Bitcoin', symbol: 'BTC' }
  };
  const assets = [
    { slug: 'token-eth', id: 'id-eth' },
    { slug: 'token-btc', id: 'id-btc' }
  ];

  it('returns all assets when search value is empty', () => {
    expect(searchAssets('', assets, meta)).toEqual(assets);
  });

  it('returns an array when searching for a name', () => {
    const result = searchAssets('Bitcoin', assets, meta);
    // Fuse uses fuzzy matching with threshold:1 so the result might include
    // multiple assets — we just verify the more-relevant one is first.
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.id).toBe('id-btc');
  });

  it('returns an array when searching for a symbol', () => {
    const result = searchAssets('ETH', assets, meta);
    expect(result.some(r => r.id === 'id-eth')).toBe(true);
  });

  it('handles miden asset via MIDEN_METADATA', () => {
    const midenAssets = [{ slug: 'miden', id: 'miden-id' }];
    const result = searchAssets('Miden', midenAssets, {});
    expect(result).toEqual([{ slug: 'miden', id: 'miden-id' }]);
  });
});
