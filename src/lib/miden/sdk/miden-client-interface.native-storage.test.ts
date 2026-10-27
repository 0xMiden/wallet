const persisted: Record<string, unknown> = {};
const RPC_URL = 'https://native-storage.example';
const STORE_NAME = 'MidenClientDB_native-fixture';

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function notifyFailure(options: unknown, failure: unknown): boolean {
  const callback = field(field(options, 'indexedDb'), 'onFailure');
  if (typeof callback !== 'function') return false;
  Reflect.apply(callback, undefined, [failure]);
  return true;
}

function quotaFailure(storeName = STORE_NAME) {
  return {
    backend: 'indexeddb',
    storeName,
    phase: 'open',
    operation: 'indexeddb.open',
    kind: 'quota',
    errorName: 'QuotaExceededError',
    eventId: 'native-fixture:1'
  };
}

async function fixture({ brand = true, gate = true } = {}) {
  class NativeWebClient {
    installNoteAcquisitionGate() {}
  }
  class RetentionFailure extends Error {}
  if (!gate) Reflect.deleteProperty(NativeWebClient.prototype, 'installNoteAcquisitionGate');
  const sdkClient = {
    storeIdentifier: jest.fn(async () => STORE_NAME),
    terminate: jest.fn()
  };
  const create = jest.fn(async (_options: Record<string, unknown>) => sdkClient);
  const createMock = jest.fn(async (_options: Record<string, unknown>) => sdkClient);
  const createRaw = jest.fn(async (..._args: unknown[]) => ({ terminate: jest.fn() }));
  const exportStore = jest.fn(async (_store: string, _options?: unknown) => '{}');
  const importStore = jest.fn(async (_store: string, _dump: string, _options?: unknown) => {});
  const resolveStoreName = jest.fn((_rpc: string, _store?: string) => STORE_NAME);
  const getWasmOrThrow = jest.fn(async () => ({ WebClient: NativeWebClient, resolveStoreName }));
  jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
    ...jest.requireActual<Record<string, unknown>>('../../../../__mocks__/wasmMock'),
    NoteType: { Private: 0, Public: 1 },
    NoteAcquisitionRetentionError: brand ? RetentionFailure : undefined,
    MidenClient: { create, createMock },
    WasmWebClient: { createClient: createRaw },
    getWasmOrThrow,
    exportStore,
    importStore
  }));
  jest.doMock('lib/miden-chain/effective-endpoints', () => ({
    getEffectiveNetworkName: () => 'testnet',
    getEffectiveRpcUrl: () => RPC_URL,
    getEffectiveFeeFaucetId: () => undefined,
    getEffectiveNoteTransportUrl: () => undefined,
    getEffectiveProverUrl: () => undefined
  }));
  jest.doMock('lib/platform/storage-adapter', () => ({
    getStorageProvider: () => ({
      get: async () => ({ ...persisted }),
      set: async (items: Record<string, unknown>) => Object.assign(persisted, items),
      remove: async (keys: string[]) => keys.forEach(key => delete persisted[key])
    })
  }));
  const health = await import('../storage-health');
  await health.initializeStorageHealth();
  expect(health.getStorageHealth().status).toBe('healthy');
  const { MidenClientInterface, getRealmReaderClient } = await import('./miden-client-interface');
  return {
    MidenClientInterface,
    getRealmReaderClient,
    health,
    create,
    createMock,
    createRaw,
    exportStore,
    importStore,
    resolveStoreName,
    getWasmOrThrow,
    sdkClient
  };
}

function protectedOptions(options: unknown) {
  expect(options).toEqual(
    expect.objectContaining({
      indexedDb: { durability: 'strict', onFailure: expect.any(Function) },
      beforeNoteAcquisition: expect.any(Function),
      noteAcquisitionLimits: {
        maxNotes: 256,
        maxNoteFileBytes: 2 * 1024 * 1024,
        maxTotalNoteFileBytes: 2 * 1024 * 1024
      }
    })
  );
}

describe('Task4C3J native storage factory policy', () => {
  const mockMode = process.env.MIDEN_USE_MOCK_CLIENT;
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(persisted)) delete persisted[key];
    delete process.env.MIDEN_USE_MOCK_CLIENT;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    const health = await import('../storage-health');
    await health.flushStorageHealth();
    if (mockMode === undefined) delete process.env.MIDEN_USE_MOCK_CLIENT;
    else process.env.MIDEN_USE_MOCK_CLIENT = mockMode;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it.each([false, true])('configures strict awaited intake on the ordinary useWorker=%s factory', async useWorker => {
    const f = await fixture();
    const client = await f.MidenClientInterface.create({ useWorker });
    protectedOptions(f.create.mock.calls[0]?.[0]);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ useWorker, rpcUrl: RPC_URL }));
    expect(f.resolveStoreName).toHaveBeenCalledWith(RPC_URL, undefined);
    expect(f.getWasmOrThrow).toHaveBeenCalled();
    client.free();
  });

  it('configures the mock factory and binds failure to the pinned SDK mock namespace', async () => {
    const f = await fixture();
    process.env.MIDEN_USE_MOCK_CLIENT = 'true';
    const client = await f.MidenClientInterface.create();
    const options = f.createMock.mock.calls[0]?.[0];
    protectedOptions(options);
    expect(f.create).not.toHaveBeenCalled();
    expect(notifyFailure(options, quotaFailure('mock_client_db'))).toBe(true);
    expect(f.health.getStorageHealth()).toMatchObject({ status: 'unavailable', reason: 'quota', backend: 'sdk' });
    client.free();
  });

  it('preserves authorized recovery construction while configuring the same strict intake policy', async () => {
    const f = await fixture();
    f.health.markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
    const epoch = f.health.getStorageHealth().epoch;
    await f.health.withStorageRecoveryAccess(epoch, Date.now() + 4000, async capability => {
      const client = await f.MidenClientInterface.createForRecovery(capability, { useWorker: false });
      protectedOptions(f.create.mock.calls[0]?.[0]);
      expect(f.health.getStorageHealth()).toMatchObject({ status: 'unavailable', epoch });
      client.free();
    });
  });

  it('opens the separate raw reader with strict failure policy and its existing worker choice', async () => {
    const f = await fixture();
    const { withWasmClientLock } = await import('./miden-client');
    await withWasmClientLock(() => f.getRealmReaderClient());
    expect(f.createRaw.mock.calls[0]).toEqual([
      RPC_URL,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      { durability: 'strict', onFailure: expect.any(Function) }
    ]);
    expect(f.resolveStoreName).toHaveBeenCalledWith(RPC_URL, undefined);
  });

  it('exports the actual client store with explicit strict standalone policy', async () => {
    const f = await fixture();
    const client = await f.MidenClientInterface.create({ useWorker: false });
    await expect(client.exportDb()).resolves.toBe('{}');
    expect(f.exportStore).toHaveBeenCalledWith(STORE_NAME, { durability: 'strict', onFailure: expect.any(Function) });
    expect(f.sdkClient.storeIdentifier).toHaveBeenCalled();
    client.free();
  });

  it('imports the actual client store with explicit strict standalone policy', async () => {
    const f = await fixture();
    const client = await f.MidenClientInterface.create({ useWorker: false });
    await client.importDb('{}');
    expect(f.importStore).toHaveBeenCalledWith(STORE_NAME, '{}', {
      durability: 'strict',
      onFailure: expect.any(Function)
    });
    expect(f.sdkClient.storeIdentifier).toHaveBeenCalled();
    client.free();
  });

  it.each(['brand', 'gate'])(
    'refuses a missing native artifact %s before exposing a writable client',
    async missing => {
      const f = await fixture({ brand: missing !== 'brand', gate: missing !== 'gate' });
      const outcome = await f.MidenClientInterface.create({ useWorker: false }).then(
        client => {
          client.free();
          return 'accepted';
        },
        () => 'refused'
      );
      expect(outcome).toBe('refused');
      expect(f.create).not.toHaveBeenCalled();
      expect(f.health.getStorageHealth().status).toBe('healthy');
    }
  );

  it('latches a trusted pre-open quota event synchronously before the constructor rejects', async () => {
    const f = await fixture();
    let observed: unknown;
    f.create.mockImplementationOnce(async options => {
      notifyFailure(options, quotaFailure());
      observed = f.health.getStorageHealth();
      throw new Error('Constructor declined');
    });
    const outcome = await f.MidenClientInterface.create({ useWorker: false }).then(
      () => 'accepted',
      () => 'refused'
    );
    expect(outcome).toBe('refused');
    expect(observed).toMatchObject({ status: 'unavailable', reason: 'quota', backend: 'sdk', operation: 'open' });
    expect(f.health.getStorageHealth()).toEqual(observed);
  });

  it.each(['malformed', 'foreign store', 'ordinary AbortError'])(
    'keeps %s constructor reports healthy',
    async invalid => {
      const f = await fixture();
      const failure =
        invalid === 'malformed'
          ? { ...quotaFailure(), operation: 'indexeddb.commit' }
          : invalid === 'foreign store'
            ? quotaFailure('unrelated-store')
            : new DOMException('cancelled', 'AbortError');
      f.create.mockImplementationOnce(async options => {
        if (invalid === 'ordinary AbortError') throw failure;
        notifyFailure(options, failure);
        throw new Error('Constructor declined');
      });
      const outcome = await f.MidenClientInterface.create({ useWorker: false }).then(
        () => 'accepted',
        () => 'refused'
      );
      expect(outcome).toBe('refused');
      expect(f.health.getStorageHealth().status).toBe('healthy');
    }
  );
});
