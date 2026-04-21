/* eslint-disable import/first */

const _g = globalThis as any;
_g.__nativeAssetTest = {
  storage: {} as Record<string, any>,
  rpcHeader: null as any,
  rpcCalls: 0,
  fetchTokenMetadata: jest.fn(),
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn()
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
  fetchFromStorage: (key: string) => (globalThis as any).__nativeAssetTest.fetchFromStorage(key),
  putToStorage: (key: string, value: any) => (globalThis as any).__nativeAssetTest.putToStorage(key, value)
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
  _g.__nativeAssetTest.fetchFromStorage.mockReset();
  _g.__nativeAssetTest.putToStorage.mockReset();
  // Default storage implementations read/write the in-memory map
  _g.__nativeAssetTest.fetchFromStorage.mockImplementation(
    async (key: string) => _g.__nativeAssetTest.storage[key] ?? null
  );
  _g.__nativeAssetTest.putToStorage.mockImplementation(async (key: string, value: any) => {
    _g.__nativeAssetTest.storage[key] = value;
  });
  await resetNativeAssetCache();
  // Clear the reset() mock bookkeeping so per-test assertions see a clean slate
  _g.__nativeAssetTest.putToStorage.mockClear();
  _g.__nativeAssetTest.fetchFromStorage.mockClear();
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

  it('returns cached ID from memory on repeat call (no storage hit, no RPC)', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'warm' }) };

    const first = await getNativeAssetId();
    _g.__nativeAssetTest.fetchFromStorage.mockClear();
    const second = await getNativeAssetId();

    expect(first).toBe('bech32-warm');
    expect(second).toBe('bech32-warm');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
    expect(_g.__nativeAssetTest.fetchFromStorage).not.toHaveBeenCalled();
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

  it('hydrates metadata from storage without RPC or metadata fetch', async () => {
    _g.__nativeAssetTest.storage['native_asset_id:testnet'] = 'cached-id';
    _g.__nativeAssetTest.storage['native_asset_meta:testnet'] = { symbol: 'CACHED', decimals: 8 };

    const meta = await getNativeAssetMetadata();

    expect(meta).toEqual({ symbol: 'CACHED', decimals: 8 });
    expect(_g.__nativeAssetTest.rpcCalls).toBe(0);
    expect(_g.__nativeAssetTest.fetchTokenMetadata).not.toHaveBeenCalled();
  });

  it('returns metadata from memory on repeat call', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'm1' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'A', decimals: 2, name: 'A' }
    });

    await getNativeAssetMetadata();
    _g.__nativeAssetTest.fetchTokenMetadata.mockClear();
    const second = await getNativeAssetMetadata();

    expect(second).toEqual({ symbol: 'A', decimals: 2 });
    expect(_g.__nativeAssetTest.fetchTokenMetadata).not.toHaveBeenCalled();
  });

  it('single-flights concurrent metadata callers', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'mc' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'C', decimals: 1, name: 'C' }
    });

    const [a, b] = await Promise.all([getNativeAssetMetadata(), getNativeAssetMetadata()]);

    expect(a).toEqual({ symbol: 'C', decimals: 1 });
    expect(b).toEqual({ symbol: 'C', decimals: 1 });
    expect(_g.__nativeAssetTest.fetchTokenMetadata).toHaveBeenCalledTimes(1);
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

  it('swallows listener exceptions when emitting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'L' }) };
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const unsubBad = onNativeAssetChanged(bad);
    const unsubGood = onNativeAssetChanged(good);

    await getNativeAssetId();

    expect(bad).toHaveBeenCalledWith('bech32-L');
    expect(good).toHaveBeenCalledWith('bech32-L');
    expect(warn).toHaveBeenCalledWith('native-asset listener error', expect.any(Error));

    unsubBad();
    unsubGood();
    warn.mockRestore();
  });

  it('falls through to RPC when storage read throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _g.__nativeAssetTest.fetchFromStorage.mockRejectedValue(new Error('storage read fail'));
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'R' }) };

    const id = await getNativeAssetId();

    expect(id).toBe('bech32-R');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith('native-asset storage read failed', expect.any(Error));
    warn.mockRestore();
  });

  it('still returns discovered ID when storage write throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _g.__nativeAssetTest.putToStorage.mockRejectedValue(new Error('storage write fail'));
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'W' }) };

    const id = await getNativeAssetId();

    expect(id).toBe('bech32-W');
    expect(warn).toHaveBeenCalledWith('native-asset storage write failed', expect.any(Error));
    warn.mockRestore();
  });

  it('still returns metadata when metadata storage write throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'M' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'M', decimals: 1, name: 'M' }
    });
    // Only fail writes to the metadata key — let the ID write succeed
    _g.__nativeAssetTest.putToStorage.mockImplementation(async (key: string, value: any) => {
      if (key === 'native_asset_meta:testnet') throw new Error('meta write fail');
      _g.__nativeAssetTest.storage[key] = value;
    });

    const meta = await getNativeAssetMetadata();

    expect(meta).toEqual({ symbol: 'M', decimals: 1 });
    expect(warn).toHaveBeenCalledWith('native-asset meta storage write failed', expect.any(Error));
    warn.mockRestore();
  });

  it('resetNativeAssetCache swallows storage write errors', async () => {
    _g.__nativeAssetTest.rpcHeader = { nativeAssetId: () => ({ _id: 'X' }) };
    await getNativeAssetId();
    _g.__nativeAssetTest.putToStorage.mockRejectedValue(new Error('reset write fail'));

    await expect(resetNativeAssetCache()).resolves.toBeUndefined();
    expect(getNativeAssetIdSync()).toBeNull();
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

  it('primeNativeAssetId swallows discovery errors', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Force both ID and metadata discovery to fail: storage read throws AND
    // RPC throws, so getNativeAssetId rejects; getNativeAssetMetadata in turn
    // rejects because it awaits getNativeAssetId.
    _g.__nativeAssetTest.fetchFromStorage.mockRejectedValue(new Error('read fail'));
    _g.__nativeAssetTest.rpcHeader = {
      nativeAssetId: () => {
        throw new Error('rpc fail');
      }
    };

    primeNativeAssetId();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledWith('primeNativeAssetId (id) failed', expect.any(Error));
    expect(warn).toHaveBeenCalledWith('primeNativeAssetId (metadata) failed', expect.any(Error));
    warn.mockRestore();
  });
});
