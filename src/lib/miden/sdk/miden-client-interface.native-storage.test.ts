import type { NoteAcquisitionCandidate } from '@miden-sdk/miden-sdk/lazy';

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
    storeIdentifier: jest.fn(async () =>
      process.env.MIDEN_USE_MOCK_CLIENT === 'true' ? 'mock_client_db' : STORE_NAME
    ),
    notes: { import: jest.fn(async () => undefined) },
    accounts: { get: jest.fn(async () => undefined) },
    sync: jest.fn(async () => undefined),
    terminate: jest.fn()
  };
  const deserialize = jest.fn(() => {
    throw new Error('Unexpected native callback WASM decode');
  });
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
    NoteFile: { deserialize },
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
    deserialize,
    RetentionFailure,
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
    expect(f.createMock).toHaveBeenCalledWith(expect.objectContaining({ useWorker: false }));
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

function nativeCandidate(committed = false): NoteAcquisitionCandidate {
  return {
    operationId: 'native-operation-1',
    noteFileBytes: new Uint8Array([19, 48, committed ? 102 : 101]),
    variant: committed ? 'committed' : 'expectedNote',
    source: 'import',
    batchIndex: 0,
    batchCount: 1,
    detailsCommitment: `0x${'12'.repeat(32)}`,
    ...(committed
      ? { noteId: `0x${'34'.repeat(32)}`, nullifier: `0x${'56'.repeat(32)}` }
      : { tag: 71, afterBlockNum: 0 })
  };
}

async function retainedCallbackFixture() {
  const f = await fixture();
  const client = await f.MidenClientInterface.create({ useWorker: false });
  const { RecoveryJournal } = await import('../recovery/journal');
  const { importVaultKey } = await import('../passworder');
  const { installNoteAcquisitionSink } = await import('../recovery/note-acquisition');
  const { withWasmClientLock } = await import('./miden-client');
  const { getAccountsWriteQueue } = await import('../back/accounts-write-queue');
  const values: Record<string, unknown> = {};
  let failure: unknown;
  let lockTail: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, operation: () => Promise<unknown>) => {
        const result = lockTail.then(operation);
        lockTail = result.catch(() => {});
        return result;
      }
    }
  });
  const storage = {
    get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, values[key]])),
    set: async (items: Record<string, unknown>) => {
      if (failure) throw failure;
      Object.assign(values, items);
    }
  };
  const journal = new RecoveryJournal(
    await importVaultKey(new Uint8Array(32).fill(9)),
    storage,
    async () => {},
    error => f.health.reportStorageFailure(error, { backend: 'independent', operation: 'mutate' })
  );
  const initial = await journal.update(() => ({
    scope: { network: `testnet:${RPC_URL}`, walletGeneration: 'wallet-fixture', sdkGeneration: 'sdk-fixture' },
    accounts: [{ accountId: 'retained', nonce: '4', commitment: 'state-4' }],
    entries: []
  }));
  let release: () => void = () => {};
  const wait = new Promise<void>(resolve => {
    release = resolve;
  });
  let entered: (notes: import('../recovery/types').RecoveryNoteEntry[]) => void = () => {};
  const started = new Promise<import('../recovery/types').RecoveryNoteEntry[]>(resolve => {
    entered = resolve;
  });
  const sink = jest.fn(async (notes: import('../recovery/types').RecoveryNoteEntry[], network: string) => {
    expect(network).toBe('testnet');
    entered(notes);
    await wait;
    await journal.update(() => ({ ...initial, entries: notes }));
  });
  installNoteAcquisitionSink(sink);
  const queueAdd = jest.spyOn(getAccountsWriteQueue(), 'add');
  f.getWasmOrThrow.mockClear();
  const invoke = (candidate: unknown) => {
    const operation = withWasmClientLock(async () => {
      const callback = field(f.create.mock.calls[0]?.[0], 'beforeNoteAcquisition');
      const result: unknown =
        typeof callback === 'function'
          ? Reflect.apply(callback, undefined, [candidate])
          : Promise.resolve('missing callback');
      expect(result).toBeInstanceOf(Promise);
      const outcome: unknown = await result;
      return typeof callback === 'function' ? 'acknowledged' : outcome;
    });
    return operation.catch((error: unknown) => error);
  };
  const invokeSequence = (candidates: unknown[]) => {
    const operation = withWasmClientLock(async () => {
      const callback = field(f.create.mock.calls[0]?.[0], 'beforeNoteAcquisition');
      const outcomes: unknown[] = [];
      for (const candidate of candidates) {
        const result: unknown =
          typeof callback === 'function'
            ? Reflect.apply(callback, undefined, [candidate])
            : Promise.resolve('missing callback');
        expect(result).toBeInstanceOf(Promise);
        const outcome: unknown = await result;
        outcomes.push(typeof callback === 'function' ? 'acknowledged' : outcome);
      }
      return outcomes;
    });
    return operation.catch((error: unknown) => error);
  };
  return {
    ...f,
    client,
    journal,
    initial,
    sink,
    started,
    release,
    invoke,
    invokeSequence,
    queueAdd,
    installNoteAcquisitionSink,
    refuseWrite: (error: unknown) => {
      failure = error;
    }
  };
}

describe('Task4C3K native acquired note callback', () => {
  const mockMode = process.env.MIDEN_USE_MOCK_CLIENT;
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(persisted)) delete persisted[key];
    delete process.env.MIDEN_USE_MOCK_CLIENT;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    const { installNoteAcquisitionSink } = await import('../recovery/note-acquisition');
    installNoteAcquisitionSink(undefined);
    const health = await import('../storage-health');
    await health.flushStorageHealth();
    if (mockMode === undefined) delete process.env.MIDEN_USE_MOCK_CLIENT;
    else process.env.MIDEN_USE_MOCK_CLIENT = mockMode;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it.each([false, true])(
    'copies committed=%s bytes and waits for encrypted retention without reentry',
    async committed => {
      const f = await retainedCallbackFixture();
      const candidate = nativeCandidate(committed);
      const original = candidate.noteFileBytes.slice();
      let settled = false;
      const pending = f.invoke(candidate).then(result => {
        settled = true;
        return result;
      });
      try {
        const entered = await Promise.race([f.started, pending.then(() => undefined)]);
        expect(entered).toEqual([
          {
            kind: 'note',
            id: (committed ? '34' : '12').repeat(32),
            detailsId: '12'.repeat(32),
            noteFile: original,
            provenance: 'input',
            format: committed ? 'full' : 'details'
          }
        ]);
        expect(settled).toBe(false);
        candidate.noteFileBytes.fill(255);
        Object.assign(candidate, { detailsCommitment: `0x${'ab'.repeat(32)}` });
        f.release();
        expect(await pending).toBe('acknowledged');
        expect((await f.journal.read())?.entries).toEqual(entered);
        expect(entered?.[0]?.noteFile).toEqual(original);
        expect(f.deserialize).not.toHaveBeenCalled();
        expect(f.getWasmOrThrow).not.toHaveBeenCalled();
        expect(f.sdkClient.notes.import).not.toHaveBeenCalled();
        expect(f.sdkClient.accounts.get).not.toHaveBeenCalled();
        expect(f.sdkClient.sync).not.toHaveBeenCalled();
        expect(f.queueAdd).not.toHaveBeenCalled();
      } finally {
        f.release();
        await pending;
        f.client.free();
      }
    }
  );

  it.each(['batch count', 'byte budget', 'metadata enum'])(
    'refuses invalid %s before independent mutation or WASM decoding',
    async invalid => {
      const f = await retainedCallbackFixture();
      const candidate = {
        ...nativeCandidate(),
        ...(invalid === 'batch count' ? { batchCount: 257 } : {}),
        ...(invalid === 'byte budget' ? { noteFileBytes: new Uint8Array(2 * 1024 * 1024 + 1) } : {}),
        ...(invalid === 'metadata enum'
          ? { metadata: { sender: '0x1234', noteType: 2, tag: 71, attachmentsCommitment: `0x${'78'.repeat(32)}` } }
          : {})
      };
      f.release();
      const outcome = await f.invoke(candidate);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
      expect(f.sink).not.toHaveBeenCalled();
      expect(await f.journal.read()).toEqual(f.initial);
      expect(f.deserialize).not.toHaveBeenCalled();
      expect(f.getWasmOrThrow).not.toHaveBeenCalled();
      expect(f.health.getStorageHealth().status).toBe('healthy');
      f.client.free();
    }
  );

  it('refuses private intake without an authorized current sink while healthy', async () => {
    const f = await retainedCallbackFixture();
    f.installNoteAcquisitionSink(undefined);
    f.release();
    const outcome = await f.invoke(nativeCandidate());
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
    expect(f.sink).not.toHaveBeenCalled();
    expect(await f.journal.read()).toEqual(f.initial);
    expect(f.health.getStorageHealth().status).toBe('healthy');
    f.client.free();
  });

  it.each(['sink', 'client', 'epoch'])('rejects a pending acquisition after its %s is replaced', async replaced => {
    const f = await retainedCallbackFixture();
    const candidate = nativeCandidate();
    const pending = f.invoke(candidate);
    const successor = jest.fn(async () => {});
    try {
      const entered = await Promise.race([f.started.then(() => true), pending.then(() => false)]);
      expect(entered).toBe(true);
      if (replaced === 'sink') f.installNoteAcquisitionSink(successor);
      else if (replaced === 'client') f.client.markPoisoned();
      else await f.health.resetStorageHealthForLifecycle(f.health.getStorageHealth().epoch);
      f.release();
      const outcome = await pending;
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
      expect(successor).not.toHaveBeenCalled();
      expect((await f.journal.read())?.entries).toEqual([
        expect.objectContaining({ noteFile: candidate.noteFileBytes })
      ]);
      expect(f.health.getStorageHealth().status).toBe('healthy');
    } finally {
      f.release();
      await pending;
      f.client.free();
    }
  });

  it('brands a real independent quota failure and preserves the last verified journal', async () => {
    const f = await retainedCallbackFixture();
    f.refuseWrite(new DOMException('Disposable journal refused', 'QuotaExceededError'));
    f.release();
    const outcome = await f.invoke(nativeCandidate());
    expect(outcome).toBeInstanceOf(f.RetentionFailure);
    expect(f.sink).toHaveBeenCalledTimes(1);
    expect(await f.journal.read()).toEqual(f.initial);
    expect(f.health.getStorageHealth()).toMatchObject({
      status: 'unavailable',
      reason: 'quota',
      backend: 'independent'
    });
    f.client.free();
  });

  it('rejects ordinary sink cancellation without a storage-failure brand or health incident', async () => {
    const f = await retainedCallbackFixture();
    f.sink.mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
    f.release();
    const outcome = await f.invoke(nativeCandidate());
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
    expect(f.sink).toHaveBeenCalledTimes(1);
    expect(await f.journal.read()).toEqual(f.initial);
    expect(f.health.getStorageHealth().status).toBe('healthy');
    f.client.free();
  });
});

function publicCandidate(): NoteAcquisitionCandidate {
  return {
    ...nativeCandidate(true),
    metadata: {
      sender: `0x${'78'.repeat(15)}`,
      noteType: 1,
      tag: 71,
      attachmentsCommitment: `0x${'9a'.repeat(32)}`
    },
    tag: 71
  };
}

describe('Task4C3L native lifecycle and batch boundaries', () => {
  const mockMode = process.env.MIDEN_USE_MOCK_CLIENT;
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(persisted)) delete persisted[key];
    delete process.env.MIDEN_USE_MOCK_CLIENT;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    const { installNoteAcquisitionSink } = await import('../recovery/note-acquisition');
    installNoteAcquisitionSink(undefined);
    const health = await import('../storage-health');
    await health.flushStorageHealth();
    if (mockMode === undefined) delete process.env.MIDEN_USE_MOCK_CLIENT;
    else process.env.MIDEN_USE_MOCK_CLIENT = mockMode;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('keeps an active holder capable of reporting a second genuine failure after bounded validation', async () => {
    const f = await retainedCallbackFixture();
    const options = f.create.mock.calls[0]?.[0];
    expect(notifyFailure(options, quotaFailure())).toBe(true);
    const first = f.health.getStorageHealth();
    expect(first).toMatchObject({ status: 'unavailable', reason: 'quota' });
    const recovered = await f.health.validateStorageHealth(async capability => {
      f.health.assertStorageRecoveryAllowed(capability);
      expect(await f.journal.read()).toEqual(f.initial);
      f.health.assertStorageRecoveryAllowed(capability);
    });
    expect(recovered).toBe(true);
    const resumed = f.health.getStorageHealth();
    expect(resumed).toMatchObject({ status: 'healthy', epoch: first.epoch + 1 });
    expect(
      notifyFailure(options, {
        ...quotaFailure(),
        phase: 'commit',
        operation: 'indexeddb.commit',
        kind: 'io',
        errorName: 'UnknownError',
        eventId: 'native-fixture:2'
      })
    ).toBe(true);
    expect(f.health.getStorageHealth()).toMatchObject({
      status: 'unavailable',
      epoch: resumed.epoch + 1,
      reason: 'backing-store',
      operation: 'transaction',
      backend: 'sdk'
    });
    f.client.free();
  });

  it('ignores a retired holder while its successor still reports its own genuine failure', async () => {
    const f = await fixture();
    const old = await f.MidenClientInterface.create({ useWorker: false });
    const oldOptions = f.create.mock.calls[0]?.[0];
    old.free();
    const current = await f.MidenClientInterface.create({ useWorker: false });
    expect(notifyFailure(oldOptions, quotaFailure())).toBe(true);
    expect(f.health.getStorageHealth().status).toBe('healthy');
    expect(notifyFailure(f.create.mock.calls[1]?.[0], quotaFailure())).toBe(true);
    expect(f.health.getStorageHealth()).toMatchObject({ status: 'unavailable', reason: 'quota' });
    current.free();
  });

  it('retires a failed constructor subscription before a successor opens the same namespace', async () => {
    const f = await fixture();
    const refusal = new Error('Constructor declined');
    f.create.mockRejectedValueOnce(refusal);
    await expect(f.MidenClientInterface.create({ useWorker: false })).rejects.toBe(refusal);
    const oldOptions = f.create.mock.calls[0]?.[0];
    const current = await f.MidenClientInterface.create({ useWorker: false });
    expect(notifyFailure(oldOptions, quotaFailure())).toBe(true);
    expect(f.health.getStorageHealth().status).toBe('healthy');
    expect(notifyFailure(f.create.mock.calls[1]?.[0], quotaFailure())).toBe(true);
    expect(f.health.getStorageHealth()).toMatchObject({ status: 'unavailable', reason: 'quota' });
    current.free();
  });

  it('maps a trusted worker commit abort before the operation result without reclassifying plain cancellation', async () => {
    const f = await fixture();
    let observed: unknown;
    const failure = new Error('Worker commit declined');
    f.create.mockImplementationOnce(async options => {
      notifyFailure(options, {
        ...quotaFailure(),
        phase: 'commit',
        operation: 'indexeddb.commit',
        kind: 'unexpected-abort',
        errorName: 'AbortError'
      });
      observed = f.health.getStorageHealth();
      throw failure;
    });
    await expect(f.MidenClientInterface.create({ useWorker: true })).rejects.toBe(failure);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ useWorker: true }));
    expect(observed).toMatchObject({ status: 'unavailable', reason: 'backing-store', operation: 'transaction' });
    expect(f.health.getStorageHealth()).toEqual(observed);
  });

  it.each(['export', 'import'])('retires the standalone %s observer when its call completes', async method => {
    const f = await fixture();
    const client = await f.MidenClientInterface.create({ useWorker: false });
    if (method === 'export') await client.exportDb();
    else await client.importDb('{}');
    const options = method === 'export' ? f.exportStore.mock.calls[0]?.[1] : f.importStore.mock.calls[0]?.[2];
    expect(notifyFailure({ indexedDb: options }, quotaFailure())).toBe(true);
    expect(f.health.getStorageHealth().status).toBe('healthy');
    expect(notifyFailure(f.create.mock.calls[0]?.[0], quotaFailure())).toBe(true);
    expect(f.health.getStorageHealth()).toMatchObject({ status: 'unavailable', reason: 'quota' });
    client.free();
  });

  it.each(['public', 'id-only'])('does not invent private recovery material for a %s candidate', async kind => {
    const f = await retainedCallbackFixture();
    const candidate =
      kind === 'public'
        ? publicCandidate()
        : {
            operationId: 'native-operation-1',
            noteFileBytes: new Uint8Array([19, 48, 103]),
            variant: 'noteId',
            source: 'import',
            batchIndex: 0,
            batchCount: 1,
            noteId: `0x${'34'.repeat(32)}`
          };
    f.release();
    expect(await f.invoke(candidate)).toBe('acknowledged');
    expect(f.sink).toHaveBeenCalledTimes(1);
    expect(f.sink).toHaveBeenCalledWith([], 'testnet', expect.any(Function));
    expect(await f.journal.read()).toEqual(f.initial);
    expect(f.deserialize).not.toHaveBeenCalled();
    expect(f.health.getStorageHealth().status).toBe('healthy');
    f.client.free();
  });

  it('Task4C3L2 acknowledges both sequential in-budget public candidates in one owned batch', async () => {
    const f = await retainedCallbackFixture();
    const first = { ...publicCandidate(), batchCount: 2 };
    const second = { ...first, batchIndex: 1, noteId: `0x${'ab'.repeat(32)}` };
    f.release();
    expect(await f.invokeSequence([first, second])).toEqual(['acknowledged', 'acknowledged']);
    expect(f.sink).toHaveBeenCalledTimes(2);
    expect(f.sink).toHaveBeenNthCalledWith(1, [], 'testnet', expect.any(Function));
    expect(f.sink).toHaveBeenNthCalledWith(2, [], 'testnet', expect.any(Function));
    expect(await f.journal.read()).toEqual(f.initial);
    expect(f.deserialize).not.toHaveBeenCalled();
    expect(f.health.getStorageHealth().status).toBe('healthy');
    f.client.free();
  });

  it('refuses an already acknowledged native operation replay before a second sink call', async () => {
    const f = await retainedCallbackFixture();
    const candidate = nativeCandidate();
    f.release();
    const outcome = await f.invokeSequence([candidate, candidate]);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
    expect(f.sink).toHaveBeenCalledTimes(1);
    expect((await f.journal.read())?.entries).toHaveLength(1);
    expect(f.health.getStorageHealth().status).toBe('healthy');
    f.client.free();
  });

  it('refuses aggregate native batch bytes before the second public candidate reaches retention', async () => {
    const f = await retainedCallbackFixture();
    const first = { ...publicCandidate(), batchCount: 2, noteFileBytes: new Uint8Array(1_100_000) };
    const second = { ...first, batchIndex: 1, noteId: `0x${'ab'.repeat(32)}` };
    expect(first.noteFileBytes.byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(first.noteFileBytes.byteLength + second.noteFileBytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    f.release();
    const outcome = await f.invokeSequence([first, second]);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
    expect(f.sink).toHaveBeenCalledTimes(1);
    expect(await f.journal.read()).toEqual(f.initial);
    expect(f.health.getStorageHealth().status).toBe('healthy');
    f.client.free();
  });

  it('refuses a native batch that starts after ordinal zero without mutation', async () => {
    const f = await retainedCallbackFixture();
    f.release();
    const outcome = await f.invokeSequence([{ ...nativeCandidate(), batchIndex: 1, batchCount: 2 }]);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(f.RetentionFailure);
    expect(f.sink).not.toHaveBeenCalled();
    expect(await f.journal.read()).toEqual(f.initial);
    expect(f.health.getStorageHealth().status).toBe('healthy');
    f.client.free();
  });
});
