import type { StorageHealth } from './storage-health';

const persisted: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: jest.fn(async () => ({ ...persisted })),
    set: jest.fn(async (items: Record<string, unknown>) => Object.assign(persisted, items)),
    remove: jest.fn(async (keys: string[]) => keys.forEach(key => delete persisted[key]))
  })
}));

describe('storage health', () => {
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(persisted)) delete persisted[key];
  });

  it('keeps a staged recovery read current only until another incident or lifecycle replaces it', async () => {
    const health = await import('./storage-health');
    health.markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
    const check = health.captureStorageRecoveryGuard();
    expect(check).not.toThrow();
    health.reportStorageFailure(new DOMException('cancelled', 'AbortError'), { backend: 'sdk', operation: 'get' });
    expect(check).not.toThrow();
    health.markStorageUnavailable('quota', { backend: 'wallet', operation: 'mutate' });
    expect(check).toThrow('StorageUnavailableError');
    const replacement = health.captureStorageRecoveryGuard();
    await health.resetStorageHealthForLifecycle(health.getStorageHealth().epoch);
    expect(replacement).toThrow('StorageUnavailableError');
  });

  it('latches contextual backing-store failure and preserves first diagnostic through restart', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    health.reportStorageFailure(new DOMException('disk I/O error', 'UnknownError'), {
      backend: 'wallet',
      operation: 'mutate'
    });
    const first = health.getStorageHealth();
    health.reportStorageFailure(new DOMException('quota', 'QuotaExceededError'), { backend: 'sdk', operation: 'sync' });
    expect(health.getStorageHealth()).toEqual(first);
    await health.flushStorageHealth();
    jest.resetModules();
    const restarted = await import('./storage-health');
    await restarted.initializeStorageHealth();
    expect(restarted.getStorageHealth()).toEqual(first);
    expect(() => restarted.assertStorageHealthy()).toThrow('StorageUnavailableError');
    expect(JSON.stringify(persisted)).not.toMatch(/disk|quota|message|stack/);
  });

  it.each([
    'AbortError',
    'OperationAbortedError',
    'WasmClientPoisonedError',
    'NetworkError',
    'TimeoutError',
    'OneClickDeadlineError'
  ])('does not poison health for ordinary %s', async name => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    health.reportStorageFailure(new DOMException('cancelled while reporting disk I/O error QuotaExceededError', name), {
      backend: 'sdk',
      operation: 'sync'
    });
    expect(health.getStorageHealth().status).toBe('healthy');
    expect(() => health.assertStorageHealthy()).not.toThrow();
  });

  it('requires storage context for generic I/O and follows guarded error links', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    expect(health.reportStorageFailure(new Error('I/O error'))).toBe(false);
    expect(health.reportStorageFailure(new Error('I/O error'), { backend: 'sdk', operation: 'sync' })).toBe(false);
    const linked = { cause: new DOMException('backing store failed', 'UnknownError') };
    expect(health.reportStorageFailure(linked, { backend: 'sdk', operation: 'import' })).toBe(true);
    expect(health.getStorageHealth()).toMatchObject({ status: 'unavailable', reason: 'backing-store' });
  });

  it('ignores stale healthy snapshots and refuses a validation raced by a new incident', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    health.reportStorageFailure(new DOMException('quota', 'QuotaExceededError'), {
      backend: 'wallet',
      operation: 'mutate'
    });
    health.adoptStorageHealth({ status: 'healthy', epoch: 0 });
    expect(health.getStorageHealth().status).toBe('unavailable');
    let finish: (() => void) | undefined;
    const validation = health.validateStorageHealth(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    health.adoptStorageHealth({
      status: 'unavailable',
      epoch: 99,
      reason: 'backing-store',
      backend: 'sdk',
      operation: 'sync',
      time: 1
    });
    finish?.();
    await expect(validation).resolves.toBe(false);
    expect(health.getStorageHealth().status).toBe('unavailable');
  });

  it('propagates only sanitized unavailable snapshots to subscribers', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    const observed: StorageHealth[] = [];
    const unsubscribe = health.subscribeStorageHealth(snapshot => observed.push(snapshot));
    health.adoptStorageHealth({
      status: 'unavailable',
      epoch: 1,
      reason: 'quota',
      backend: 'wallet',
      operation: 'mutate',
      time: 10,
      secret: 'never copied'
    });
    expect(observed).toEqual([
      { status: 'unavailable', epoch: 1, reason: 'quota', backend: 'wallet', operation: 'mutate', time: 10 }
    ]);
    unsubscribe();
  });
});

describe('storage recovery capability', () => {
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(persisted)) delete persisted[key];
  });

  it('revokes a bounded recovery capability when validation ends and rejects forged capabilities', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'get' });
    let retained: import('./storage-health').StorageRecoveryCapability | undefined;
    await expect(
      health.validateStorageHealth(async capability => {
        retained = capability;
        expect(() => health.assertStorageHealthy()).toThrow();
        expect(() => health.assertStorageRecoveryAllowed(capability)).not.toThrow();
        expect(() =>
          health.assertStorageRecoveryAllowed({ epoch: capability.epoch, expiresAt: capability.expiresAt })
        ).toThrow();
      })
    ).resolves.toBe(true);
    const expired = retained;
    if (!expired) throw new Error('Missing capability');
    expect(() => health.assertStorageRecoveryAllowed(expired)).toThrow();
    expect(health.getStorageHealth().status).toBe('healthy');
  });

  it('does not resume after a repeated failure caught during validation', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    health.reportStorageFailure(new DOMException('quota', 'QuotaExceededError'));
    await expect(
      health.validateStorageHealth(async () => {
        health.reportStorageFailure(new DOMException('quota', 'QuotaExceededError'));
      })
    ).resolves.toBe(false);
    expect(health.getStorageHealth().status).toBe('unavailable');
  });

  it('accepts explicit recovery only for the matching epoch and ignores an older incident afterwards', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'get' });
    const failure = health.getStorageHealth();
    expect(health.adoptStorageHealthRecovery({ recoveryFrom: 0, health: { status: 'healthy', epoch: 1 } })).toBe(false);
    expect(health.adoptStorageHealthRecovery({ recoveryFrom: 1, health: { status: 'healthy', epoch: 2 } })).toBe(true);
    expect(health.adoptStorageHealth(failure)).toBe(false);
    expect(health.getStorageHealth()).toEqual({ status: 'healthy', epoch: 2 });
  });
});

describe('live storage health transport', () => {
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(persisted)) delete persisted[key];
  });

  it('receives live failure and publishes only sanitized diagnostics through BroadcastChannel', async () => {
    const previous = globalThis.BroadcastChannel;
    const messages: unknown[] = [];
    let receiver: ((event: { data: unknown }) => void) | null = null;
    class Channel {
      set onmessage(listener: (event: { data: unknown }) => void) {
        receiver = listener;
      }
      postMessage(value: unknown) {
        messages.push(value);
      }
    }
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: Channel });
    try {
      const health = await import('./storage-health');
      await health.initializeStorageHealth();
      const incoming = {
        status: 'unavailable',
        epoch: 3,
        reason: 'quota',
        backend: 'wallet',
        operation: 'mutate',
        time: 5,
        secret: 'redacted'
      };
      if (!receiver) throw new Error('Missing live receiver');
      Reflect.apply(receiver, undefined, [{ data: incoming }]);
      expect(() => health.assertStorageHealthy()).toThrow();
      expect(messages).toEqual([
        { status: 'unavailable', epoch: 3, reason: 'quota', backend: 'wallet', operation: 'mutate', time: 5 }
      ]);
    } finally {
      Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: previous });
    }
  });
});

describe('storage health realm startup', () => {
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(persisted)) delete persisted[key];
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__MIDEN_IN_OFFSCREEN_DOC__');
  });

  it('hydrates an unavailable incident before allowing realm mutation starts', async () => {
    persisted.miden_storage_health_v1 = {
      status: 'unavailable',
      epoch: 7,
      reason: 'quota',
      backend: 'sdk',
      operation: 'sync',
      time: 1
    };
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    expect(() => health.assertStorageHealthy()).toThrow();
    expect(health.getStorageHealth()).toMatchObject({ epoch: 7, reason: 'quota' });
  });

  it('hydrates offscreen through its service-worker snapshot and refuses an invalid snapshot', async () => {
    Reflect.set(globalThis, '__MIDEN_IN_OFFSCREEN_DOC__', true);
    const health = await import('./storage-health');
    health.configureStorageHealthTransport(async () => ({ invalid: 'no snapshot' }));
    await health.initializeStorageHealth();
    expect(health.getStorageHealth()).toMatchObject({
      status: 'unavailable',
      backend: 'independent',
      operation: 'open'
    });
    expect(persisted).toEqual({});
    expect(() => health.assertStorageHealthy()).toThrow();
  });

  it('expires validation and revokes its capability without reopening ordinary concurrent mutations', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'get' });
    let capability: import('./storage-health').StorageRecoveryCapability | undefined;
    await expect(
      health.validateStorageHealth(async permit => {
        capability = permit;
        await new Promise<void>(() => {});
      }, 5)
    ).resolves.toBe(false);
    const expired = capability;
    if (!expired) throw new Error('Missing capability');
    expect(() => health.assertStorageRecoveryAllowed(expired)).toThrow();
    expect(() => health.assertStorageHealthy()).toThrow();
  });
});

describe('independent diagnostic failures', () => {
  beforeEach(() => {
    jest.resetModules();
    for (const key of Object.keys(persisted)) delete persisted[key];
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails closed on a malformed retained diagnostic', async () => {
    persisted.miden_storage_health_v1 = { reason: 'not a valid diagnostic' };
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    expect(() => health.assertStorageHealthy()).toThrow();
  });

  it('retains the first failure when best-effort diagnostic persistence also fails', async () => {
    const health = await import('./storage-health');
    await health.initializeStorageHealth();
    const adapter = await import('lib/platform/storage-adapter');
    jest.spyOn(adapter, 'getStorageProvider').mockReturnValue({
      get: async () => ({}),
      set: async () => {
        throw new DOMException('second failure', 'QuotaExceededError');
      },
      remove: async () => {}
    });
    health.markStorageUnavailable('continuity', { backend: 'sdk', operation: 'get' });
    const first = health.getStorageHealth();
    await health.flushStorageHealth();
    expect(health.getStorageHealth()).toEqual(first);
    expect(health.getStorageHealth()).toMatchObject({ reason: 'continuity' });
    expect(() => health.assertStorageHealthy()).toThrow();
  });
});
