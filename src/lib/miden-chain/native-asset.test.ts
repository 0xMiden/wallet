/* eslint-disable import/first */

const _g = globalThis as any;
_g.__nativeAssetTest = {
  storage: {} as Record<string, any>,
  rpcHeader: null as any,
  // When set, the RPC block-header call returns this (a promise a test can
  // resolve manually) instead of `rpcHeader` — lets a test hold a discovery
  // open across an endpoint switch.
  deferHeader: null as any,
  rpcCalls: 0,
  // Effective RPC URL + network name the cache keys are derived from. Tests
  // flip these to simulate a dev-settings endpoint / network-id switch.
  rpcUrl: 'rpc-testnet' as string,
  networkName: 'testnet' as string,
  fetchTokenMetadata: jest.fn(),
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn()
};

jest.mock('@miden-sdk/miden-sdk', () => ({
  RpcClient: class {
    async getBlockHeaderByNumber(_: any) {
      const g = (globalThis as any).__nativeAssetTest;
      g.rpcCalls++;
      return g.deferHeader ?? g.rpcHeader;
    }
  }
}));

jest.mock('lib/miden-chain/constants', () => ({
  DEFAULT_NETWORK: 'testnet',
  ensureSdkWasmReady: jest.fn(async () => {}),
  getRpcEndpoint: jest.fn(() => ({}))
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => (globalThis as any).__nativeAssetTest.rpcUrl,
  getEffectiveNetworkName: () => (globalThis as any).__nativeAssetTest.networkName
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
  resetNativeAssetCache,
  getVerificationBaseFee,
  getVerificationBaseFeeSync
} from './native-asset';

beforeEach(async () => {
  // Reset module-level state by resetting the cache and clearing mocks
  for (const k of Object.keys(_g.__nativeAssetTest.storage)) delete _g.__nativeAssetTest.storage[k];
  _g.__nativeAssetTest.rpcCalls = 0;
  _g.__nativeAssetTest.rpcHeader = null;
  _g.__nativeAssetTest.deferHeader = null;
  _g.__nativeAssetTest.rpcUrl = 'rpc-testnet';
  _g.__nativeAssetTest.networkName = 'testnet';
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
  it('reads the verification base fee from the same block-header fetch as the faucet id', async () => {
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'native-acc' }),
      verificationBaseFee: () => 10000
    };

    await getNativeAssetId();
    // The fee must come out of the header the faucet-id discovery already fetched.
    // A second RPC round-trip here would be a regression, not an implementation detail.
    await expect(getVerificationBaseFee()).resolves.toBe(10000);
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
  });

  it('reports an undiscovered base fee as null rather than zero', async () => {
    // Zero is a real value on a chain that charges nothing, so it cannot double as
    // "not known yet" — a caller reserving a fee must be able to tell them apart.
    expect(getVerificationBaseFeeSync()).toBeNull();

    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'native-acc' }),
      verificationBaseFee: () => 0
    };
    await getVerificationBaseFee();

    expect(getVerificationBaseFeeSync()).toBe(0);
  });

  it('rehydrates a zero base fee from storage instead of rediscovering it', async () => {
    // The existing hydrate pattern tests truthiness, which silently drops a real 0.
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'bech32-native-acc';
    _g.__nativeAssetTest.storage['native_asset_fee:v1:rpc-testnet|testnet'] = 0;

    await expect(getVerificationBaseFee()).resolves.toBe(0);
    expect(_g.__nativeAssetTest.rpcCalls).toBe(0);
  });

  it('discovers ID via RPC on cache miss and caches to storage', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'native-acc' }) };

    const id = await getNativeAssetId();

    expect(id).toBe('bech32-native-acc');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet']).toBe('bech32-native-acc');
  });

  it('returns cached ID from storage without RPC', async () => {
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'pre-cached-id';

    const id = await getNativeAssetId();

    expect(id).toBe('pre-cached-id');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(0);
  });

  it('returns cached ID from memory on repeat call (no storage hit, no RPC)', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'warm' }) };

    const first = await getNativeAssetId();
    _g.__nativeAssetTest.fetchFromStorage.mockClear();
    const second = await getNativeAssetId();

    expect(first).toBe('bech32-warm');
    expect(second).toBe('bech32-warm');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
    expect(_g.__nativeAssetTest.fetchFromStorage).not.toHaveBeenCalled();
  });

  it('single-flights concurrent callers into one RPC round-trip', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'native-acc' }) };

    const [a, b, c] = await Promise.all([getNativeAssetId(), getNativeAssetId(), getNativeAssetId()]);

    expect(a).toBe('bech32-native-acc');
    expect(b).toBe('bech32-native-acc');
    expect(c).toBe('bech32-native-acc');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
  });

  it('getNativeAssetIdSync returns null before discovery, value after', async () => {
    expect(getNativeAssetIdSync()).toBeNull();
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'x' }) };
    await getNativeAssetId();
    expect(getNativeAssetIdSync()).toBe('bech32-x');
  });

  // Regression: on a custom dev-settings network the effective RPC URL changes
  // but the base network name does not, so a name-keyed cache served the prior
  // node's faucet id and native-note auto-consume never matched. The cache is
  // now RPC-keyed and the in-memory value self-invalidates on endpoint switch.
  it('re-discovers against the new node when the effective RPC changes (network switch)', async () => {
    // Network A: discover + cache faucet-A in memory.
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'faucet-A' }) };
    expect(await getNativeAssetId()).toBe('bech32-faucet-A');
    expect(getNativeAssetIdSync()).toBe('bech32-faucet-A');

    // Switch to network B (different node, different genesis faucet).
    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'faucet-B' }) };

    // The stale in-memory faucet-A must NOT be served for network B.
    expect(getNativeAssetIdSync()).toBeNull();
    expect(await getNativeAssetId()).toBe('bech32-faucet-B');
    expect(getNativeAssetIdSync()).toBe('bech32-faucet-B');
  });

  it('does not let a discovery in flight across an endpoint switch clobber the new node value', async () => {
    const seen: string[] = [];
    const unsub = onNativeAssetChanged(id => seen.push(id));

    // Network A discovery starts, but its block-header fetch is held open.
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    let resolveA: (h: any) => void = () => {};
    _g.__nativeAssetTest.deferHeader = new Promise(res => {
      resolveA = res;
    });
    const pA = getNativeAssetId(); // in flight against node A
    // Let the discovery advance past hydration and park at the (held) block-header
    // fetch — this is where it snapshots the rpc-A cache key.
    await new Promise(resolve => setTimeout(resolve, 0));
    // Pin the park point: A must have reached the block-header call (rpcCalls===1)
    // before the switch, otherwise the setTimeout(0) flush landed somewhere else.
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);

    // Switch to network B before A resolves; B discovers immediately.
    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.deferHeader = null;
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'faucet-B' }) };
    expect(getNativeAssetIdSync()).toBeNull(); // guard drops the in-flight A state
    expect(await getNativeAssetId()).toBe('bech32-faucet-B');

    // Let the stale A discovery finish LAST — it must not overwrite memory,
    // must not clobber B's persisted entry, and must not emit the stale id.
    resolveA({ feeFaucetId: () => ({ _id: 'faucet-A' }) });
    await expect(pA).resolves.toBe('bech32-faucet-A'); // the A caller still gets A
    expect(getNativeAssetIdSync()).toBe('bech32-faucet-B'); // memory still B
    // Persisted layer: B's entry intact, A's landed under A's own (snapshotted) key.
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-B|testnet']).toBe('bech32-faucet-B');
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-A|testnet']).toBe('bech32-faucet-A');
    // Listeners never saw the stale A id after the switch.
    expect(seen).not.toContain('bech32-faucet-A');
    expect(seen).toContain('bech32-faucet-B');
    unsub();
  });

  it('discovers the base fee when the faucet id was already cached', async () => {
    // The upgrade path for every existing install. The fee key is deliberately NOT a
    // `v4` bump, so a stored id stays valid and nothing forces a rediscovery -- but
    // `discover()` is the only place the fee is read, and a cached id short-circuits
    // it. Without a forced probe the fee stays null forever on exactly the wallets
    // that already ran, and every guard that fails open on null is permanently inert.
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'pre-cached-id';
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'native-acc' }),
      verificationBaseFee: () => 10000
    };

    await expect(getVerificationBaseFee()).resolves.toBe(10000);
    expect(_g.__nativeAssetTest.storage['native_asset_fee:v1:rpc-testnet|testnet']).toBe(10000);
  });

  it('asks for the base fee once against a node that reports none', async () => {
    // The bound on the probe above: an SDK build with no `verificationBaseFee`
    // accessor must not turn every caller into a fresh block-header fetch.
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'pre-cached-id';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'native-acc' }) };

    await expect(getVerificationBaseFee()).resolves.toBeNull();
    const afterFirst = _g.__nativeAssetTest.rpcCalls;
    await expect(getVerificationBaseFee()).resolves.toBeNull();
    await expect(getVerificationBaseFee()).resolves.toBeNull();

    expect(_g.__nativeAssetTest.rpcCalls).toBe(afterFirst);
  });

  it('asks for the base fee once against a node quoting an implausible one', async () => {
    // An out-of-range value is DISCARDED (a reserve is a multiple of it, so an absurd
    // one would zero the spendable balance and exclude every note from the claim floor,
    // per endpoint, with no TTL) — but the probe still latches, because a node that
    // answered with a number has a working accessor. Left unlatched it cost a
    // block-header fetch on every call, which on mobile is once per 3s tick forever.
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'pre-cached-id';
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'native-acc' }),
      verificationBaseFee: () => 4294967295
    };

    await expect(getVerificationBaseFee()).resolves.toBeNull();
    const afterFirst = _g.__nativeAssetTest.rpcCalls;
    await expect(getVerificationBaseFee()).resolves.toBeNull();
    await expect(getVerificationBaseFee()).resolves.toBeNull();

    expect(_g.__nativeAssetTest.rpcCalls).toBe(afterFirst);
    // Never persisted, so it cannot outlive the session either. (The harness reports an
    // absent key as null; a write would have put the number here.)
    expect(_g.__nativeAssetTest.storage['native_asset_fee:v1:rpc-testnet|testnet']).toBeNull();
  });

  it('does not re-probe per caller when the fee accessor THROWS', async () => {
    // A throwing accessor is transient, so unlike the two cases above it must not latch
    // — but retrying it on every caller is the same per-call block-header fetch. It
    // takes a cooldown instead. This path does not go through the discovery catch
    // (discovery itself succeeded), which is why the cooldown is armed in `discover`.
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'pre-cached-id';
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'native-acc' }),
      verificationBaseFee: () => {
        throw new Error('accessor blew up');
      }
    };

    await expect(getVerificationBaseFee()).resolves.toBeNull();
    const afterFirst = _g.__nativeAssetTest.rpcCalls;
    await expect(getVerificationBaseFee()).resolves.toBeNull();
    await expect(getVerificationBaseFee()).resolves.toBeNull();

    expect(_g.__nativeAssetTest.rpcCalls).toBe(afterFirst);
  });

  it('drops a discovered base fee when the endpoint changes', async () => {
    // The fee belongs to the node that quoted it. Left behind, the sync getter serves
    // the previous chain's value while the faucet id has already gone null -- so a
    // wallet moved from a zero-fee chain to a charging one reserves nothing, and the
    // reverse disables sending outright.
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'faucet-A' }),
      verificationBaseFee: () => 10000
    };
    await expect(getVerificationBaseFee()).resolves.toBe(10000);

    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'faucet-B' }),
      verificationBaseFee: () => 250
    };

    expect(getVerificationBaseFeeSync()).toBeNull();
    await expect(getVerificationBaseFee()).resolves.toBe(250);
  });

  it('persists a fee discovered across an endpoint switch under its OWN node key', async () => {
    // Same snapshot rule the faucet id already follows. The fee write happens after two
    // awaits, so recomputing the key there files node A's fee under node B's scope --
    // and B then rehydrates A's number as its own.
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    let resolveA: (h: any) => void = () => {};
    _g.__nativeAssetTest.deferHeader = new Promise(res => {
      resolveA = res;
    });
    const pA = getNativeAssetId();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);

    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.deferHeader = null;
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'faucet-B' }),
      verificationBaseFee: () => 250
    };
    await expect(getNativeAssetId()).resolves.toBe('bech32-faucet-B');

    resolveA({ feeFaucetId: () => ({ _id: 'faucet-A' }), verificationBaseFee: () => 10000 });
    await expect(pA).resolves.toBe('bech32-faucet-A');

    expect(_g.__nativeAssetTest.storage['native_asset_fee:v1:rpc-A|testnet']).toBe(10000);
    expect(_g.__nativeAssetTest.storage['native_asset_fee:v1:rpc-B|testnet']).toBe(250);
    expect(getVerificationBaseFeeSync()).toBe(250);
  });

  it('does not let a hydrate read parked across an endpoint switch seed the old node id', async () => {
    // A persisted entry exists for node A.
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-A|testnet'] = 'stored-A';
    // Hold node A's persisted-id read open so hydration parks there.
    let releaseAread: () => void = () => {};
    _g.__nativeAssetTest.fetchFromStorage.mockImplementation(
      (key: string) =>
        new Promise(res => {
          if (key === 'native_asset_id:v4:rpc-A|testnet') {
            releaseAread = () => res(_g.__nativeAssetTest.storage[key] ?? null);
          } else {
            res(_g.__nativeAssetTest.storage[key] ?? null);
          }
        })
    );

    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    const pA = getNativeAssetId(); // parks in hydrate at node A's persisted-id read
    await new Promise(resolve => setTimeout(resolve, 0));

    // Switch to node B and advance the endpoint binding.
    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'faucet-B' }) };
    expect(getNativeAssetIdSync()).toBeNull();

    // Release node A's stale read LAST — its hydrate write must be dropped, and the
    // resolve must fall through to a fresh discovery against node B.
    releaseAread();
    await expect(pA).resolves.toBe('bech32-faucet-B');
    expect(getNativeAssetIdSync()).toBe('bech32-faucet-B'); // NOT the stale 'stored-A'
  });

  it('keys the persisted cache by RPC URL so distinct nodes do not collide', async () => {
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'A' }) };
    await getNativeAssetId();

    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-A|testnet']).toBe('bech32-A');
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-B|testnet']).toBeUndefined();
  });

  // Regression: the cached value is a bech32 string whose prefix comes from the
  // network name (getNetworkId). Changing only the dev-settings Network ID (same
  // RPC) must invalidate — otherwise the placeholder MIDEN row keeps the old
  // prefix while fresh per-sync note faucet ids use the new one, and they mismatch.
  it('re-discovers when only the network name changes on the same RPC', async () => {
    _g.__nativeAssetTest.rpcUrl = 'rpc-same';
    _g.__nativeAssetTest.networkName = 'localnet';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'acc' }) };
    expect(await getNativeAssetId()).toBe('bech32-acc');
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-same|localnet']).toBe('bech32-acc');

    // Change ONLY the network id (RPC unchanged) — the cache must invalidate.
    _g.__nativeAssetTest.networkName = 'devnet';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'acc2' }) };
    expect(getNativeAssetIdSync()).toBeNull(); // stale-prefix value not served
    expect(await getNativeAssetId()).toBe('bech32-acc2');
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-same|devnet']).toBe('bech32-acc2');
    // Old-scope entry left intact (distinct key).
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-same|localnet']).toBe('bech32-acc');
  });

  it('re-discovers metadata against the new node on endpoint switch', async () => {
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'A' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({ base: { symbol: 'AAA', decimals: 6, name: 'A' } });
    expect(await getNativeAssetMetadata()).toEqual({ symbol: 'AAA', decimals: 6 });

    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'B' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({ base: { symbol: 'BBB', decimals: 8, name: 'B' } });

    expect(getNativeAssetMetadataSync()).toBeNull();
    expect(await getNativeAssetMetadata()).toEqual({ symbol: 'BBB', decimals: 8 });
    // Self-standing: the id was re-discovered to B (not the stale A id fed to metadata).
    expect(_g.__nativeAssetTest.fetchTokenMetadata).toHaveBeenCalledWith('bech32-B');
  });

  it('does not let a metadata fetch in flight across an endpoint switch clobber the new node value', async () => {
    // Network A: id resolves immediately, but the metadata fetch is held open.
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'A' }) };
    let resolveMeta: (v: any) => void = () => {};
    _g.__nativeAssetTest.fetchTokenMetadata.mockReturnValue(new Promise(res => (resolveMeta = res)));
    const pA = getNativeAssetMetadata(); // parked in discoverMetadata against node A
    await new Promise(resolve => setTimeout(resolve, 0));

    // Switch to network B before A's metadata resolves; B resolves immediately.
    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'B' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({ base: { symbol: 'BBB', decimals: 8, name: 'B' } });
    expect(getNativeAssetMetadataSync()).toBeNull();
    expect(await getNativeAssetMetadata()).toEqual({ symbol: 'BBB', decimals: 8 });

    // Let the stale A metadata resolve LAST — it must not overwrite memory or B's entry.
    resolveMeta({ base: { symbol: 'AAA', decimals: 6, name: 'A' } });
    await pA;
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'BBB', decimals: 8 });
    expect(_g.__nativeAssetTest.storage['native_asset_meta:v4:rpc-B|testnet']).toEqual({ symbol: 'BBB', decimals: 8 });
  });

  it('fires onNativeAssetChanged listeners when discovery completes', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'hello' }) };
    const listener = jest.fn();
    const unsub = onNativeAssetChanged(listener);

    await getNativeAssetId();

    expect(listener).toHaveBeenCalledWith('bech32-hello');
    unsub();
  });

  it('does not fire listeners when reading from cache', async () => {
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'cached';
    const listener = jest.fn();
    const unsub = onNativeAssetChanged(listener);

    await getNativeAssetId();

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('discovers metadata after ID, caches symbol/decimals', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'n' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'MIDEN', decimals: 6, name: 'Miden' }
    });

    const meta = await getNativeAssetMetadata();

    expect(meta).toEqual({ symbol: 'MIDEN', decimals: 6 });
    expect(_g.__nativeAssetTest.fetchTokenMetadata).toHaveBeenCalledWith('bech32-n');
    expect(_g.__nativeAssetTest.storage['native_asset_meta:v4:rpc-testnet|testnet']).toEqual({
      symbol: 'MIDEN',
      decimals: 6
    });
  });

  it('hydrates metadata from storage without RPC or metadata fetch', async () => {
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'cached-id';
    _g.__nativeAssetTest.storage['native_asset_meta:v4:rpc-testnet|testnet'] = { symbol: 'CACHED', decimals: 8 };

    const meta = await getNativeAssetMetadata();

    expect(meta).toEqual({ symbol: 'CACHED', decimals: 8 });
    expect(_g.__nativeAssetTest.rpcCalls).toBe(0);
    expect(_g.__nativeAssetTest.fetchTokenMetadata).not.toHaveBeenCalled();
  });

  it('returns metadata from memory on repeat call', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'm1' }) };
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
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'mc' }) };
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
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'a' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'S', decimals: 3, name: 'S' }
    });
    await getNativeAssetMetadata();
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'S', decimals: 3 });
  });

  it('returns null from metadata discovery when RPC fetch fails', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'z' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockRejectedValue(new Error('RPC down'));

    const meta = await getNativeAssetMetadata();

    expect(meta).toBeNull();
    expect(getNativeAssetMetadataSync()).toBeNull();
  });

  it('resetNativeAssetCache clears all three caches', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'q' }), verificationBaseFee: () => 10000 };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'Q', decimals: 4, name: 'Q' }
    });
    await getNativeAssetMetadata();
    expect(getNativeAssetIdSync()).toBe('bech32-q');
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'Q', decimals: 4 });
    expect(getVerificationBaseFeeSync()).toBe(10000);

    await resetNativeAssetCache();

    expect(getNativeAssetIdSync()).toBeNull();
    expect(getNativeAssetMetadataSync()).toBeNull();
    // The fee is the third cache, and the one a reset used to be asserted without.
    expect(getVerificationBaseFeeSync()).toBeNull();
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet']).toBeNull();
    expect(_g.__nativeAssetTest.storage['native_asset_meta:v4:rpc-testnet|testnet']).toBeNull();
    expect(_g.__nativeAssetTest.storage['native_asset_fee:v1:rpc-testnet|testnet']).toBeNull();
  });

  it('swallows listener exceptions when emitting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'L' }) };
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
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'R' }) };

    const id = await getNativeAssetId();

    expect(id).toBe('bech32-R');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith('native-asset storage read failed', expect.any(Error));
    warn.mockRestore();
  });

  it('still returns discovered ID when storage write throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _g.__nativeAssetTest.putToStorage.mockRejectedValue(new Error('storage write fail'));
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'W' }) };

    const id = await getNativeAssetId();

    expect(id).toBe('bech32-W');
    expect(warn).toHaveBeenCalledWith('native-asset storage write failed', expect.any(Error));
    warn.mockRestore();
  });

  it('still returns metadata when metadata storage write throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'M' }) };
    _g.__nativeAssetTest.fetchTokenMetadata.mockResolvedValue({
      base: { symbol: 'M', decimals: 1, name: 'M' }
    });
    // Only fail writes to the metadata key — let the ID write succeed
    _g.__nativeAssetTest.putToStorage.mockImplementation(async (key: string, value: any) => {
      if (key === 'native_asset_meta:v4:rpc-testnet|testnet') throw new Error('meta write fail');
      _g.__nativeAssetTest.storage[key] = value;
    });

    const meta = await getNativeAssetMetadata();

    expect(meta).toEqual({ symbol: 'M', decimals: 1 });
    expect(warn).toHaveBeenCalledWith('native-asset meta storage write failed', expect.any(Error));
    warn.mockRestore();
  });

  it('resetNativeAssetCache swallows storage write errors', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'X' }) };
    await getNativeAssetId();
    _g.__nativeAssetTest.putToStorage.mockRejectedValue(new Error('reset write fail'));

    await expect(resetNativeAssetCache()).resolves.toBeUndefined();
    expect(getNativeAssetIdSync()).toBeNull();
  });

  it('primeNativeAssetId kicks off both ID and metadata discovery', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'p' }) };
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
      feeFaucetId: () => {
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
