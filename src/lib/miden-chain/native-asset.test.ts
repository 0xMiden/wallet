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
  configured: true,
  storageListeners: new Map<string, (value: unknown) => void>(),
  // Effective RPC URL + network name the cache keys are derived from. Tests
  // flip these to simulate a dev-settings endpoint / network-id switch.
  rpcUrl: 'rpc-testnet' as string,
  networkName: 'testnet' as string,
  fetchChainTokenMetadata: jest.fn(),
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
  getEffectiveNetworkName: () => (globalThis as any).__nativeAssetTest.networkName,
  getEffectiveFeeFaucetId: () => {
    const g = (globalThis as any).__nativeAssetTest;
    if (!g.configured) return undefined;
    const fromHeader = g.rpcHeader?.feeFaucetId?.();
    if (fromHeader) return fromHeader._id ?? fromHeader;
    return g.feeFaucetId ?? 'native-acc';
  }
}));

jest.mock('lib/miden/front/storage', () => ({
  onStorageChanged: (key: string, callback: (value: unknown) => void) => {
    const listeners = (globalThis as any).__nativeAssetTest.storageListeners;
    listeners.set(key, callback);
    return Object.assign(() => listeners.delete(key), { attached: Promise.resolve() });
  },
  fetchFromStorage: (key: string) => (globalThis as any).__nativeAssetTest.fetchFromStorage(key),
  putToStorage: (key: string, value: any) => (globalThis as any).__nativeAssetTest.putToStorage(key, value)
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((accountId: any) => `bech32-${accountId?._id ?? accountId}`),
  accountIdStringToSdk: jest.fn((id: string) => ({ _id: id }))
}));

jest.mock('lib/miden/metadata', () => ({
  fetchChainTokenMetadata: (...args: any[]) => (globalThis as any).__nativeAssetTest.fetchChainTokenMetadata(...args)
}));

import {
  captureNativeAssetSnapshot,
  recordSyncedFeeFaucetId,
  getSdkSyncedNativeAssetIdSync,
  getNativeAssetId,
  getNativeAssetIdSync,
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  onNativeAssetChanged,
  primeNativeAssetId,
  resetNativeAssetCache,
  getVerificationBaseFee,
  getVerificationBaseFeeSync,
  isVerificationBaseFeeKnownAbsent
} from './native-asset';

beforeEach(async () => {
  // Reset module-level state by resetting the cache and clearing mocks
  for (const k of Object.keys(_g.__nativeAssetTest.storage)) delete _g.__nativeAssetTest.storage[k];
  _g.__nativeAssetTest.rpcCalls = 0;
  _g.__nativeAssetTest.configured = true;
  _g.__nativeAssetTest.rpcHeader = null;
  _g.__nativeAssetTest.deferHeader = null;
  _g.__nativeAssetTest.feeFaucetId = undefined;
  _g.__nativeAssetTest.rpcUrl = 'rpc-testnet';
  _g.__nativeAssetTest.networkName = 'testnet';
  _g.__nativeAssetTest.fetchChainTokenMetadata.mockReset();
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

  it('does not call the base fee absent before any header was read', async () => {
    expect(isVerificationBaseFeeKnownAbsent()).toBe(false);
  });

  it.each([0, 3])('does not call a known base fee of %s absent', async fee => {
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'native-acc' }),
      verificationBaseFee: () => fee
    };
    await expect(getVerificationBaseFee()).resolves.toBe(fee);
    expect(isVerificationBaseFeeKnownAbsent()).toBe(false);
  });

  it('rehydrates a zero base fee from storage instead of rediscovering it', async () => {
    // The existing hydrate pattern tests truthiness, which silently drops a real 0.
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'bech32-native-acc';
    _g.__nativeAssetTest.storage['native_asset_fee:v2:rpc-testnet|testnet'] = {
      faucetId: 'bech32-native-acc',
      baseFee: 0
    };

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
    _g.__nativeAssetTest.configured = false;
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
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'faucet-A' }) };
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
    expect(_g.__nativeAssetTest.storage['native_asset_id:v4:rpc-A|testnet']).toBeUndefined();
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
    expect(_g.__nativeAssetTest.storage['native_asset_fee:v2:rpc-testnet|testnet']).toEqual({
      faucetId: 'bech32-native-acc',
      baseFee: 10000
    });
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
    expect(isVerificationBaseFeeKnownAbsent()).toBe(true);
    // The answer belongs to the node that gave it.
    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    expect(isVerificationBaseFeeKnownAbsent()).toBe(false);
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
    expect(_g.__nativeAssetTest.storage['native_asset_fee:v2:rpc-testnet|testnet']).toBeNull();
    expect(isVerificationBaseFeeKnownAbsent()).toBe(true);
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
    expect(isVerificationBaseFeeKnownAbsent()).toBe(false);
    const afterFirst = _g.__nativeAssetTest.rpcCalls;
    await expect(getVerificationBaseFee()).resolves.toBeNull();
    await expect(getVerificationBaseFee()).resolves.toBeNull();

    expect(_g.__nativeAssetTest.rpcCalls).toBe(afterFirst);
    expect(isVerificationBaseFeeKnownAbsent()).toBe(false);
  });

  // A trap here is in the RpcClient discover() builds for its one read, never in the client in the slot, so it is
  // a failed read like any other. The fee cooldown survives resetNativeAssetCache; a node of the test's own drops
  // one an earlier test stamped.
  const onFreshNode = (rpcUrl: string) => {
    isVerificationBaseFeeKnownAbsent();
    _g.__nativeAssetTest.rpcUrl = rpcUrl;
  };

  it('a trap from the fee accessor still lets the faucet id be discovered, and the fee retries behind the cooldown', async () => {
    onFreshNode('rpc-accessor-trap');
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'native-acc' }),
      verificationBaseFee: () => {
        throw new WebAssembly.RuntimeError('unreachable');
      }
    };

    await expect(getNativeAssetId()).resolves.toBe('bech32-native-acc');
    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
    await expect(getVerificationBaseFee()).resolves.toBeNull();
    await expect(getVerificationBaseFee()).resolves.toBeNull();

    expect(_g.__nativeAssetTest.rpcCalls).toBe(1);
    expect(isVerificationBaseFeeKnownAbsent()).toBe(false);
  });

  it('a trap in the fee discovery resolves null behind the cooldown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    onFreshNode('rpc-discovery-trap');
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-discovery-trap|testnet'] = 'pre-cached-id';
    // The fee faucet is configured in 0.17, so the header read is the discovery's one RPC and the trap lands there.
    // A thenable rejects only once awaited, so no rejection waits unhandled between reads.
    _g.__nativeAssetTest.deferHeader = {
      then: (_resolve: unknown, reject: (reason: unknown) => void) =>
        reject(new WebAssembly.RuntimeError('unreachable'))
    };

    await expect(getVerificationBaseFee()).resolves.toBeNull();
    // withRpcTimeout retries a failed read once, so one discovery is two header reads.
    expect(_g.__nativeAssetTest.rpcCalls).toBe(2);
    expect(warn).toHaveBeenCalledWith('native-asset fee discovery failed', expect.any(WebAssembly.RuntimeError));
    await expect(getVerificationBaseFee()).resolves.toBeNull();

    expect(_g.__nativeAssetTest.rpcCalls).toBe(2);
    expect(isVerificationBaseFeeKnownAbsent()).toBe(false);
    // It is the cooldown, not a latch, that holds the second read back: once it lapses the fee is read again.
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    await expect(getVerificationBaseFee()).resolves.toBeNull();
    now.mockRestore();
    expect(_g.__nativeAssetTest.rpcCalls).toBe(4);
    warn.mockRestore();
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

  it('discards a fee discovered after its endpoint was replaced', async () => {
    // Same snapshot rule the faucet id already follows. The fee write happens after two
    // awaits, so recomputing the key there files node A's fee under node B's scope --
    // and B then rehydrates A's number as its own.
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    _g.__nativeAssetTest.rpcHeader = {
      feeFaucetId: () => ({ _id: 'faucet-A' }),
      verificationBaseFee: () => 10000
    };
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

    expect(_g.__nativeAssetTest.storage['native_asset_fee:v2:rpc-A|testnet']).toBeUndefined();
    expect(_g.__nativeAssetTest.storage['native_asset_fee:v2:rpc-B|testnet']).toEqual({
      faucetId: 'bech32-faucet-B',
      baseFee: 250
    });
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
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'AAA', decimals: 6, name: 'A' });
    expect(await getNativeAssetMetadata()).toEqual({ symbol: 'AAA', decimals: 6 });

    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'B' }) };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'BBB', decimals: 8, name: 'B' });

    expect(getNativeAssetMetadataSync()).toBeNull();
    expect(await getNativeAssetMetadata()).toEqual({ symbol: 'BBB', decimals: 8 });
    // Self-standing: the id was re-discovered to B (not the stale A id fed to metadata).
    expect(_g.__nativeAssetTest.fetchChainTokenMetadata).toHaveBeenCalledWith('bech32-B');
  });

  it('does not let a metadata fetch in flight across an endpoint switch clobber the new node value', async () => {
    // Network A: id resolves immediately, but the metadata fetch is held open.
    _g.__nativeAssetTest.rpcUrl = 'rpc-A';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'A' }) };
    let resolveMeta: (v: any) => void = () => {};
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockReturnValue(new Promise(res => (resolveMeta = res)));
    const pA = getNativeAssetMetadata(); // parked in discoverMetadata against node A
    await new Promise(resolve => setTimeout(resolve, 0));

    // Switch to network B before A's metadata resolves; B resolves immediately.
    _g.__nativeAssetTest.rpcUrl = 'rpc-B';
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'B' }) };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'BBB', decimals: 8, name: 'B' });
    expect(getNativeAssetMetadataSync()).toBeNull();
    expect(await getNativeAssetMetadata()).toEqual({ symbol: 'BBB', decimals: 8 });

    // Let the stale A metadata resolve LAST — it must not overwrite memory or B's entry.
    resolveMeta({ symbol: 'AAA', decimals: 6, name: 'A' });
    await pA;
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'BBB', decimals: 8 });
    expect(_g.__nativeAssetTest.storage['native_asset_meta:v5:rpc-B|testnet']).toEqual({
      faucetId: 'bech32-B',
      symbol: 'BBB',
      decimals: 8
    });
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
    _g.__nativeAssetTest.configured = false;
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'cached';
    const listener = jest.fn();
    const unsub = onNativeAssetChanged(listener);

    await getNativeAssetId();

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('discovers metadata after ID, caches symbol/decimals', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'n' }) };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'MIDEN', decimals: 6, name: 'Miden' });

    const meta = await getNativeAssetMetadata();

    expect(meta).toEqual({ symbol: 'MIDEN', decimals: 6 });
    expect(_g.__nativeAssetTest.fetchChainTokenMetadata).toHaveBeenCalledWith('bech32-n');
    expect(_g.__nativeAssetTest.storage['native_asset_meta:v5:rpc-testnet|testnet']).toEqual({
      faucetId: 'bech32-n',
      symbol: 'MIDEN',
      decimals: 6
    });
  });

  it('hydrates metadata from storage without RPC or metadata fetch', async () => {
    _g.__nativeAssetTest.configured = false;
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'cached-id';
    _g.__nativeAssetTest.storage['native_asset_meta:v5:rpc-testnet|testnet'] = {
      faucetId: 'cached-id',
      symbol: 'CACHED',
      decimals: 8
    };

    const meta = await getNativeAssetMetadata();

    expect(meta).toEqual({ symbol: 'CACHED', decimals: 8 });
    expect(_g.__nativeAssetTest.rpcCalls).toBe(0);
    expect(_g.__nativeAssetTest.fetchChainTokenMetadata).not.toHaveBeenCalled();
  });

  it('returns metadata from memory on repeat call', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'm1' }) };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'A', decimals: 2, name: 'A' });

    await getNativeAssetMetadata();
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockClear();
    const second = await getNativeAssetMetadata();

    expect(second).toEqual({ symbol: 'A', decimals: 2 });
    expect(_g.__nativeAssetTest.fetchChainTokenMetadata).not.toHaveBeenCalled();
  });

  it('single-flights concurrent metadata callers', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'mc' }) };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'C', decimals: 1, name: 'C' });

    const [a, b] = await Promise.all([getNativeAssetMetadata(), getNativeAssetMetadata()]);

    expect(a).toEqual({ symbol: 'C', decimals: 1 });
    expect(b).toEqual({ symbol: 'C', decimals: 1 });
    expect(_g.__nativeAssetTest.fetchChainTokenMetadata).toHaveBeenCalledTimes(1);
  });

  it('getNativeAssetMetadataSync returns null before discovery, value after', async () => {
    expect(getNativeAssetMetadataSync()).toBeNull();
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'a' }) };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'S', decimals: 3, name: 'S' });
    await getNativeAssetMetadata();
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'S', decimals: 3 });
  });

  it('returns null from metadata discovery when RPC fetch fails', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'z' }) };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockRejectedValue(new Error('RPC down'));

    const meta = await getNativeAssetMetadata();

    expect(meta).toBeNull();
    expect(getNativeAssetMetadataSync()).toBeNull();
  });

  it('resetNativeAssetCache clears all three caches', async () => {
    _g.__nativeAssetTest.rpcHeader = { feeFaucetId: () => ({ _id: 'q' }), verificationBaseFee: () => 10000 };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'Q', decimals: 4, name: 'Q' });
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
    expect(_g.__nativeAssetTest.storage['native_asset_meta:v5:rpc-testnet|testnet']).toBeNull();
    expect(_g.__nativeAssetTest.storage['native_asset_fee:v2:rpc-testnet|testnet']).toBeNull();
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
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'M', decimals: 1, name: 'M' });
    // Only fail writes to the metadata key — let the ID write succeed
    _g.__nativeAssetTest.putToStorage.mockImplementation(async (key: string, value: any) => {
      if (key === 'native_asset_meta:v5:rpc-testnet|testnet') throw new Error('meta write fail');
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
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'P', decimals: 2, name: 'P' });

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

describe('SDK publication storage adoption', () => {
  it('heals a popup that already missed storage before another realm syncs', async () => {
    _g.__nativeAssetTest.configured = false;
    await expect(getNativeAssetId()).rejects.toThrow();
    const key = 'native_asset_id:v4:rpc-testnet|testnet';
    _g.__nativeAssetTest.storage[key] = 'bech32-synced';
    _g.__nativeAssetTest.storageListeners.get(key)?.('bech32-synced');
    await expect(getNativeAssetId()).resolves.toBe('bech32-synced');
    expect(getNativeAssetIdSync()).toBe('bech32-synced');
  });

  it('prefers a configured identity over historical scoped storage', async () => {
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'bech32-historical';
    _g.__nativeAssetTest.rpcHeader = { verificationBaseFee: () => 7 };
    await expect(getNativeAssetId()).resolves.toBe('bech32-native-acc');
  });
});

describe('durable synchronized identity ownership', () => {
  it('orders a parked A publication before reset and B publication', async () => {
    _g.__nativeAssetTest.configured = false;
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'USDCX', decimals: 6, name: 'USDCX' });
    _g.__nativeAssetTest.rpcHeader = { verificationBaseFee: () => 7 };
    const proof = 'native_asset_synced_id:v1:rpc-testnet|testnet';
    let release: () => void = () => undefined;
    let parked: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      parked = resolve;
    });
    _g.__nativeAssetTest.putToStorage.mockImplementation(async (key: string, value: unknown) => {
      if (key === proof && value === 'bech32-A') {
        parked();
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
      _g.__nativeAssetTest.storage[key] = value;
      _g.__nativeAssetTest.storageListeners.get(key)?.(value);
    });
    const old = recordSyncedFeeFaucetId('A', captureNativeAssetSnapshot());
    await started;
    const reset = resetNativeAssetCache();
    const next = recordSyncedFeeFaucetId('B', captureNativeAssetSnapshot());
    release();
    await Promise.all([old, reset, next]);
    expect(_g.__nativeAssetTest.storage[proof]).toBe('bech32-B');
    expect(getSdkSyncedNativeAssetIdSync()).toBe('bech32-B');
    expect(getNativeAssetIdSync()).toBe('bech32-B');
  });
});

describe('SDK evidence and metadata binding', () => {
  const proofKey = 'native_asset_synced_id:v1:rpc-testnet|testnet';
  const metadataKey = 'native_asset_meta:v5:rpc-testnet|testnet';
  const feeKey = 'native_asset_fee:v2:rpc-testnet|testnet';
  it('publishes canonical SDK evidence and discovers authoritative six-decimal USDCX', async () => {
    _g.__nativeAssetTest.configured = false;
    _g.__nativeAssetTest.rpcHeader = { verificationBaseFee: () => 7 };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'USDCX', decimals: 6, name: 'USDCX' });
    await expect(recordSyncedFeeFaucetId('sdk-native', captureNativeAssetSnapshot())).resolves.toBe(true);
    await expect(getNativeAssetMetadata()).resolves.toEqual({ symbol: 'USDCX', decimals: 6 });
    await expect(getVerificationBaseFee()).resolves.toBe(7);
    expect(_g.__nativeAssetTest.storage[proofKey]).toBe('bech32-sdk-native');
    expect(_g.__nativeAssetTest.storage[metadataKey]).toEqual({
      faucetId: 'bech32-sdk-native',
      symbol: 'USDCX',
      decimals: 6
    });
    expect(_g.__nativeAssetTest.storage[feeKey]).toEqual({ faucetId: 'bech32-sdk-native', baseFee: 7 });
    expect(_g.__nativeAssetTest.storage.fee_faucet_id).toBeUndefined();
  });
  it('retains an explicit fee identity while separately recording protocol evidence', async () => {
    _g.__nativeAssetTest.rpcHeader = { verificationBaseFee: () => 7 };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'USDCX', decimals: 8, name: 'USDCX' });
    await recordSyncedFeeFaucetId('sdk-native', captureNativeAssetSnapshot());
    await expect(getNativeAssetId()).resolves.toBe('bech32-native-acc');
    expect(getSdkSyncedNativeAssetIdSync()).toBe('bech32-sdk-native');
  });
  it('does not publish a client constructed for an obsolete endpoint', async () => {
    const snapshot = captureNativeAssetSnapshot();
    _g.__nativeAssetTest.rpcUrl = 'rpc-replacement';
    await expect(recordSyncedFeeFaucetId('old-native', snapshot)).resolves.toBe(false);
    expect(getSdkSyncedNativeAssetIdSync()).toBeNull();
    expect(_g.__nativeAssetTest.putToStorage).not.toHaveBeenCalled();
  });
  it('rejects metadata and fee envelopes bound to a different faucet', async () => {
    _g.__nativeAssetTest.configured = false;
    _g.__nativeAssetTest.storage['native_asset_id:v4:rpc-testnet|testnet'] = 'bech32-B';
    _g.__nativeAssetTest.storage[metadataKey] = { faucetId: 'bech32-A', symbol: 'USDCX', decimals: 18 };
    _g.__nativeAssetTest.storage[feeKey] = { faucetId: 'bech32-A', baseFee: 999 };
    await getNativeAssetId();
    expect(getNativeAssetMetadataSync()).toBeNull();
    expect(getVerificationBaseFeeSync()).toBeNull();
  });
  it('does not promote unresolved metadata to authoritative native scale', async () => {
    _g.__nativeAssetTest.rpcHeader = { verificationBaseFee: () => 7 };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({
      symbol: 'USDCX',
      decimals: 6,
      name: 'USDCX',
      scaleIsUnknown: true
    });
    await expect(getNativeAssetMetadata()).resolves.toBeNull();
    expect(getNativeAssetMetadataSync()).toBeNull();
    expect(_g.__nativeAssetTest.storage[metadataKey]).toBeNull();
  });
  it('signals authoritative metadata completion even when the native ID did not change', async () => {
    _g.__nativeAssetTest.rpcHeader = { verificationBaseFee: () => 7 };
    await getNativeAssetId();
    const listener = jest.fn();
    const stop = onNativeAssetChanged(listener);
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'USDCX', decimals: 6, name: 'USDCX' });
    await getNativeAssetMetadata();
    expect(listener).toHaveBeenCalledWith('bech32-native-acc');
    stop();
  });
  it('discards parked metadata when the SDK learns another faucet in the same scope', async () => {
    _g.__nativeAssetTest.configured = false;
    _g.__nativeAssetTest.rpcHeader = { verificationBaseFee: () => 7 };
    let release: (value: unknown) => void = () => undefined;
    let began: () => void = () => undefined;
    const started = new Promise<void>(resolve => {
      began = resolve;
    });
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockImplementationOnce(() => {
      began();
      return new Promise(resolve => {
        release = resolve;
      });
    });
    await recordSyncedFeeFaucetId('A', captureNativeAssetSnapshot());
    await started;
    const oldMetadata = getNativeAssetMetadata();
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'USDCX', decimals: 8, name: 'USDCX' });
    await recordSyncedFeeFaucetId('B', captureNativeAssetSnapshot());
    await expect(getNativeAssetMetadata()).resolves.toEqual({ symbol: 'USDCX', decimals: 8 });
    release({ symbol: 'OLD', decimals: 18, name: 'OLD' });
    await expect(oldMetadata).resolves.toBeNull();
    expect(getNativeAssetMetadataSync()).toEqual({ symbol: 'USDCX', decimals: 8 });
    expect(_g.__nativeAssetTest.storage[metadataKey]).toEqual({ faucetId: 'bech32-B', symbol: 'USDCX', decimals: 8 });
  });
});

describe('endpoint change notifications', () => {
  const readState = () => ({
    id: getNativeAssetIdSync(),
    metadata: getNativeAssetMetadataSync(),
    fee: getVerificationBaseFeeSync(),
    proof: getSdkSyncedNativeAssetIdSync()
  });
  const warmState = { id: 'bech32-A', metadata: { symbol: 'USDCX', decimals: 6 }, fee: 7, proof: 'bech32-A' };
  beforeEach(async () => {
    _g.__nativeAssetTest.configured = false;
    Object.assign(_g.__nativeAssetTest.storage, {
      'native_asset_id:v4:rpc-testnet|testnet': 'bech32-A',
      'native_asset_synced_id:v1:rpc-testnet|testnet': 'bech32-A',
      'native_asset_meta:v5:rpc-testnet|testnet': { faucetId: 'bech32-A', symbol: 'USDCX', decimals: 6 },
      'native_asset_fee:v2:rpc-testnet|testnet': { faucetId: 'bech32-A', baseFee: 7 }
    });
    await getNativeAssetId();
  });

  it.each(['scope', 'override'])('invalidates %s state before notifying outside the getter', async change => {
    expect(readState()).toEqual(warmState);
    let reading = false;
    const observations: Array<{
      id: string;
      reading: boolean;
      nativeId: string | null;
      metadata: ReturnType<typeof getNativeAssetMetadataSync>;
      fee: number | null;
      proof: string | null;
      scope: string;
    }> = [];
    const stop = onNativeAssetChanged(id => {
      observations.push({
        id,
        reading,
        nativeId: getNativeAssetIdSync(),
        metadata: getNativeAssetMetadataSync(),
        fee: getVerificationBaseFeeSync(),
        proof: getSdkSyncedNativeAssetIdSync(),
        scope: captureNativeAssetSnapshot().scope
      });
    });
    try {
      if (change === 'scope') _g.__nativeAssetTest.rpcUrl = 'rpc-B';
      else {
        _g.__nativeAssetTest.configured = true;
        _g.__nativeAssetTest.feeFaucetId = 'replacement';
      }
      reading = true;
      expect(getNativeAssetIdSync()).toBeNull();
      expect(getNativeAssetMetadataSync()).toBeNull();
      expect(getVerificationBaseFeeSync()).toBeNull();
      expect(getSdkSyncedNativeAssetIdSync()).toBe(change === 'scope' ? null : 'bech32-A');
      reading = false;
      expect(observations).toEqual([]);
      await Promise.resolve();
      expect(observations).toEqual([
        {
          id: '',
          reading: false,
          nativeId: null,
          metadata: null,
          fee: null,
          proof: change === 'scope' ? null : 'bech32-A',
          scope: change === 'scope' ? 'rpc-B|testnet' : 'rpc-testnet|testnet'
        }
      ]);
    } finally {
      reading = false;
      stop();
    }
  });

  it('coalesces rapid overrides and notifies the restored current identity', async () => {
    expect(readState()).toEqual(warmState);
    const notices: string[] = [];
    const stop = onNativeAssetChanged(id => notices.push(id));
    try {
      _g.__nativeAssetTest.configured = true;
      _g.__nativeAssetTest.feeFaucetId = 'replacement-X';
      expect(getNativeAssetIdSync()).toBeNull();
      _g.__nativeAssetTest.feeFaucetId = 'replacement-Y';
      expect(getNativeAssetIdSync()).toBeNull();
      _g.__nativeAssetTest.configured = false;
      expect(getNativeAssetIdSync()).toBe('bech32-A');
      expect(getNativeAssetMetadataSync()).toBeNull();
      expect(getVerificationBaseFeeSync()).toBeNull();
      expect(getSdkSyncedNativeAssetIdSync()).toBe('bech32-A');
      expect(notices).toEqual([]);
      await Promise.resolve();
      expect(notices).toEqual(['bech32-A']);
    } finally {
      stop();
    }
  });

  it('keeps reset synchronous and consumes a pending endpoint notice', async () => {
    expect(readState()).toEqual(warmState);
    const notices: Array<{ id: string; scope: string }> = [];
    const order: string[] = [];
    const stop = onNativeAssetChanged(id => {
      order.push('notice');
      notices.push({ id, scope: captureNativeAssetSnapshot().scope });
    });
    try {
      _g.__nativeAssetTest.rpcUrl = 'rpc-B';
      expect(getNativeAssetIdSync()).toBeNull();
      expect(notices).toEqual([]);
      const reset = resetNativeAssetCache();
      expect(notices).toEqual([{ id: '', scope: 'rpc-B|testnet' }]);
      queueMicrotask(() => order.push('between notices'));
      _g.__nativeAssetTest.rpcUrl = 'rpc-C';
      expect(getNativeAssetIdSync()).toBeNull();
      expect(notices).toHaveLength(1);
      await Promise.resolve();
      expect(notices).toEqual([
        { id: '', scope: 'rpc-B|testnet' },
        { id: '', scope: 'rpc-C|testnet' }
      ]);
      expect(order).toEqual(['notice', 'between notices', 'notice']);
      await reset;
      expect(notices).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it('keeps storage adoption synchronous and consumes a pending override notice', async () => {
    expect(readState()).toEqual(warmState);
    const notices: string[] = [];
    const stop = onNativeAssetChanged(id => notices.push(id));
    try {
      _g.__nativeAssetTest.configured = true;
      _g.__nativeAssetTest.feeFaucetId = 'replacement';
      expect(getNativeAssetIdSync()).toBeNull();
      expect(notices).toEqual([]);
      const adopt = _g.__nativeAssetTest.storageListeners.get('native_asset_synced_id:v1:rpc-testnet|testnet');
      expect(adopt).toBeDefined();
      adopt('bech32-B');
      expect(getSdkSyncedNativeAssetIdSync()).toBe('bech32-B');
      expect(notices).toEqual(['']);
      await Promise.resolve();
      expect(notices).toEqual(['']);
    } finally {
      stop();
    }
  });
});

describe('publication acknowledgment recovery', () => {
  const idKey = 'native_asset_id:v4:rpc-testnet|testnet';
  const proofKey = 'native_asset_synced_id:v1:rpc-testnet|testnet';
  beforeEach(() => {
    _g.__nativeAssetTest.configured = false;
    _g.__nativeAssetTest.rpcHeader = { verificationBaseFee: () => 7 };
    _g.__nativeAssetTest.fetchChainTokenMetadata.mockResolvedValue({ symbol: 'USDCX', name: 'USDCX', decimals: 6 });
  });
  const freshRealm = () => {
    let native!: typeof import('./native-asset');
    jest.isolateModules(() => {
      native = jest.requireActual('./native-asset');
    });
    return native;
  };
  it.each(['remove-proof', 'replace-proof', 'remove-id', 'remove-both'])(
    'repairs both durable identity keys after an external %s event',
    async change => {
      await recordSyncedFeeFaucetId('A', captureNativeAssetSnapshot());
      await getNativeAssetMetadata();
      const mutate = (key: string, value: string | null) => {
        if (value === null) delete _g.__nativeAssetTest.storage[key];
        else _g.__nativeAssetTest.storage[key] = value;
        const callback = _g.__nativeAssetTest.storageListeners.get(key);
        expect(callback).toEqual(expect.any(Function));
        callback?.(value);
      };
      if (change === 'remove-proof' || change === 'remove-both') mutate(proofKey, null);
      if (change === 'replace-proof') mutate(proofKey, 'bech32-B');
      if (change === 'remove-id' || change === 'remove-both') mutate(idKey, null);
      await expect(recordSyncedFeeFaucetId('A', captureNativeAssetSnapshot())).resolves.toBe(true);
      expect(_g.__nativeAssetTest.storage[idKey]).toBe('bech32-A');
      expect(_g.__nativeAssetTest.storage[proofKey]).toBe('bech32-A');
      const observer = freshRealm();
      await expect(observer.getNativeAssetId()).resolves.toBe('bech32-A');
      expect(observer.getSdkSyncedNativeAssetIdSync()).toBe('bech32-A');
    }
  );
  it('relays each successful sync so a separate storage receiver can recover after reset', async () => {
    const sender = freshRealm();
    const receiver = freshRealm();
    const relay = jest.fn(async (id: string, scope: string) => {
      expect(scope).toBe('rpc-testnet|testnet');
      expect(await receiver.recordSyncedFeeFaucetId(id, receiver.captureNativeAssetSnapshot(scope))).toBe(true);
    });
    sender.setNativeAssetPublisher(relay);
    await sender.recordSyncedFeeFaucetId('A', sender.captureNativeAssetSnapshot());
    await receiver.getNativeAssetMetadata();
    await sender.getNativeAssetMetadata();
    await receiver.resetNativeAssetCache();
    expect(_g.__nativeAssetTest.storage[proofKey]).toBeNull();
    await expect(sender.recordSyncedFeeFaucetId('A', sender.captureNativeAssetSnapshot())).resolves.toBe(true);
    expect(relay).toHaveBeenCalledTimes(2);
    expect(_g.__nativeAssetTest.storage[idKey]).toBe('bech32-A');
    expect(_g.__nativeAssetTest.storage[proofKey]).toBe('bech32-A');
    expect(receiver.getSdkSyncedNativeAssetIdSync()).toBe('bech32-A');
  });
  it('reports a failed current relay instead of reusing an earlier success acknowledgment', async () => {
    const sender = freshRealm();
    const relay = jest.fn(async () => {}).mockRejectedValueOnce(new Error('receiver unavailable'));
    sender.setNativeAssetPublisher(async () => {
      _g.__nativeAssetTest.storage[idKey] = 'bech32-A';
      _g.__nativeAssetTest.storage[proofKey] = 'bech32-A';
    });
    await expect(sender.recordSyncedFeeFaucetId('A', sender.captureNativeAssetSnapshot())).resolves.toBe(true);
    await sender.getNativeAssetMetadata();
    sender.setNativeAssetPublisher(relay);
    await expect(sender.recordSyncedFeeFaucetId('A', sender.captureNativeAssetSnapshot())).resolves.toBe(false);
    expect(relay).toHaveBeenCalledTimes(1);
    expect(sender.getSdkSyncedNativeAssetIdSync()).toBe('bech32-A');
  });

  it('releases the real recording queue after a bounded parked relay so the next sync can publish', async () => {
    const sender = freshRealm();
    const { withRpcTimeout } = jest.requireActual('./rpc-timeout');
    _g.__nativeAssetTest.fetchFromStorage.mockRejectedValue(new Error('offscreen storage unavailable'));
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    let calls = 0;
    sender.setNativeAssetPublisher(() =>
      withRpcTimeout(
        () => {
          calls++;
          started();
          return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
        },
        'native-publication-test',
        { retries: 0 }
      )
    );
    jest.useFakeTimers();
    try {
      const first = sender.recordSyncedFeeFaucetId('A', sender.captureNativeAssetSnapshot());
      await firstStarted;
      const second = sender.recordSyncedFeeFaucetId('A', sender.captureNativeAssetSnapshot());
      await jest.advanceTimersByTimeAsync(15_000);
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(true);
      expect(calls).toBe(2);
      expect(sender.getSdkSyncedNativeAssetIdSync()).toBe('bech32-A');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
