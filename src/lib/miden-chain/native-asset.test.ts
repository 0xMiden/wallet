/* eslint-disable import/first */

const _g = globalThis as any;
_g.__nativeAssetTest = {
  storage: {} as Record<string, any>,
  rpcHeader: null as any,
  rpcCalls: 0,
  fetchTokenMetadata: jest.fn()
};

jest.mock('@miden-sdk/miden-sdk', () => ({
  RpcClient: class {
    async getBlockHeaderByNumber(_: any) {
      (globalThis as any).__nativeAssetTest.rpcCalls++;
      return (globalThis as any).__nativeAssetTest.rpcHeader;
    }
  }
}));

jest.mock('lib/miden-chain/constants', () => ({
  DEFAULT_NETWORK: 'testnet',
  ensureSdkWasmReady: jest.fn(async () => {}),
  getRpcEndpoint: jest.fn(() => ({}))
}));

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => (globalThis as any).__nativeAssetTest.storage[key] ?? null,
  putToStorage: async (key: string, value: any) => {
    (globalThis as any).__nativeAssetTest.storage[key] = value;
  }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((accountId: any) => `bech32-${accountId?._id ?? accountId}`)
}));

jest.mock('lib/miden/metadata', () => ({
  fetchTokenMetadata: (...args: any[]) => (globalThis as any).__nativeAssetTest.fetchTokenMetadata(...args)
}));

import {
  getNativeAssetId,
  getNativeAssetIdSync,
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  onNativeAssetChanged,
  primeNativeAssetId,
  resetNativeAssetCache
} from './native-asset';

beforeEach(async () => {
  // Reset module-level state by resetting the cache and clearing mocks
  for (const k of Object.keys(_g.__nativeAssetTest.storage)) delete _g.__nativeAssetTest.storage[k];
  _g.__nativeAssetTest.rpcCalls = 0;
  _g.__nativeAssetTest.rpcHeader = null;
  _g.__nativeAssetTest.fetchTokenMetadata.mockReset();
  await resetNativeAssetCache();
});

describe('native-asset module', () => {
  it('discovers ID via RPC on cache miss and caches to storage', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'native-acc' }) };

    const id = await getNativeAssetId();

    expect(id).toBe('bech32-native-acc');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
    expect(_g.__nativeAssetTest.storage['native_asset_id:testnet']).toBe('bech32-native-acc');
  });

  it('returns cached ID from storage without RPC', async () => {
    _g.__nativeAssetTest.storage['native_asset_id:testnet'] = 'pre-cached-id';

    const id = await getNativeAssetId();

    expect(id).toBe('pre-cached-id');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(0);
  });

  it('single-flights concurrent callers into one RPC round-trip', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'native-acc' }) };

    const [a, b, c] = await Promise.all([getNativeAssetId(), getNativeAssetId(), getNativeAssetId()]);

    expect(a).toBe('bech32-native-acc');
    expect(b).toBe('bech32-native-acc');
    expect(c).toBe('bech32-native-acc');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
  });

  it('getNativeAssetIdSync returns null before discovery, value after', async () => {
    expect(getNativeAssetIdSync()).toBeNull();
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'x' }) };
    await getNativeAssetId();
    expect(getNativeAssetIdSync()).toBe('bech32-x');
  });

  it('fires onNativeAssetChanged listeners when discovery completes', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'hello' }) };
    const listener = jest.fn();
    const unsub = onNativeAssetChanged(listener);

    await getNativeAssetId();

    expect(listener).toHaveBeenCalledWith('bech32-hello');
    unsub();
  });

  it('does not fire listeners when reading from cache', async () => {
    _g.__nativeAssetTest.storage['native_asset_id:testnet'] = 'cached';
    const listener = jest.fn();
    const unsub = onNativeAssetChanged(listener);

    await getNativeAssetId();

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('discovers metadata after ID, caches symbol/decimals', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'n' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'MIDEN', decimals: 6, name: 'Miden' }
    });

    const meta = await getNativeAssetMetadata();

    expect(meta).toEqual({ symbol: 'MIDEN', decimals: 6 });
    expect(_g.__nativeAssetTest.fetchTokenMetadata).toHaveBeenCalledWith('bech32-n');
    expect(_g.__nativeAssetTest.storage['native_asset_meta:testnet']).toEqual({ symbol: 'MIDEN', decimals: 6 });
  });

  it('getNativeAssetMetadataSync returns null before discovery, value after', async () => {
    expect(getNativeAssetMetadataSync()).toBeNull();
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'a' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'S', decimals: 3, name: 'S' }
    });
    await getNativeAssetMetadata();
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'S', decimals: 3 });
  });

  it('returns null from metadata discovery when RPC fetch fails', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'z' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockRejectedValue(new Error('RPC down'));

    const meta = await getNativeAssetMetadata();

    expect(meta).toBeNull();
    expect(getNativeAssetMetadataSync()).toBeNull();
  });

  it('resetNativeAssetCache clears both caches', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'q' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'Q', decimals: 4, name: 'Q' }
    });
    await getNativeAssetMetadata();
    expect(getNativeAssetIdSync()).toBe('bech32-q');
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'Q', decimals: 4 });

    await resetNativeAssetCache();

    expect(getNativeAssetIdSync()).toBeNull();
    expect(getNativeAssetMetadataSync()).toBeNull();
    expect(_g.__nativeAssetTest.storage['native_asset_id:testnet']).toBeNull();
    expect(_g.__nativeAssetTest.storage['native_asset_meta:testnet']).toBeNull();
  });

  it('primeNativeAssetId kicks off both ID and metadata discovery', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'p' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'P', decimals: 2, name: 'P' }
    });

    primeNativeAssetId();
    // Let both discovery promises resolve
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(getNativeAssetIdSync()).toBe('bech32-p');
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'P', decimals: 2 });
  });
});
