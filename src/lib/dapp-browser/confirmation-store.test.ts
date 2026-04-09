/**
 * Tests for the dApp confirmation store.
 *
 * The store is the multi-session coordinator between the backend
 * (dapp.ts) and the React frontend (DappBrowserProvider modal). It's
 * keyed by sessionId so N dApps can have pending confirmations at the
 * same time.
 *
 * Each test uses a fresh store via `jest.isolateModules` so we're not
 * contaminated by the shared singleton across test cases.
 */

import type {
  DAppConfirmationRequest,
  DAppConfirmationResult,
  dappConfirmationStore as StoreInstance
} from './confirmation-store';

type Store = typeof StoreInstance;

async function freshStore(): Promise<Store> {
  jest.resetModules();
  const mod = await import('./confirmation-store');
  return mod.dappConfirmationStore;
}

function makeRequest(overrides: Partial<DAppConfirmationRequest> = {}): DAppConfirmationRequest {
  return {
    id: 'req-' + Math.random().toString(36).slice(2, 8),
    type: 'connect',
    origin: 'https://miden.xyz',
    appMeta: { name: 'Miden', url: 'https://miden.xyz' } as never,
    network: 'testnet',
    networkRpc: 'https://rpc.testnet.miden.io',
    privateDataPermission: 'None' as never,
    allowedPrivateData: {} as never,
    existingPermission: false,
    ...overrides
  };
}

describe('requestConfirmation / resolveConfirmation', () => {
  it('resolves the promise with the result supplied to resolveConfirmation', async () => {
    const store = await freshStore();
    const promise = store.requestConfirmation(makeRequest({ sessionId: 's1' }));
    store.resolveConfirmation('s1', { confirmed: true, accountPublicKey: 'pk' });
    const result = await promise;
    expect(result).toEqual({ confirmed: true, accountPublicKey: 'pk' });
  });

  it('stores the pending request under the sessionId key', async () => {
    const store = await freshStore();
    const req = makeRequest({ sessionId: 's1', type: 'transaction' });
    const promise = store.requestConfirmation(req);
    expect(store.getPendingRequest('s1')?.type).toBe('transaction');
    store.resolveConfirmation('s1', { confirmed: false });
    await promise;
  });

  it('routes callers without a sessionId through the legacy default slot', async () => {
    const store = await freshStore();
    const promise = store.requestConfirmation(makeRequest()); // no sessionId
    expect(store.getPendingRequest()).not.toBeNull();
    store.resolveConfirmation(undefined, { confirmed: true });
    await promise;
  });

  it('returns null from getPendingRequest when no entry exists', async () => {
    const store = await freshStore();
    expect(store.getPendingRequest('nonexistent')).toBeNull();
    expect(store.getPendingRequest()).toBeNull();
  });
});

describe('multi-session isolation', () => {
  it('maintains separate pending entries for distinct sessionIds', async () => {
    const store = await freshStore();
    const p1 = store.requestConfirmation(makeRequest({ sessionId: 's1', type: 'connect' }));
    const p2 = store.requestConfirmation(makeRequest({ sessionId: 's2', type: 'transaction' }));

    expect(store.getAllPendingRequests()).toHaveLength(2);
    expect(store.getPendingRequest('s1')?.type).toBe('connect');
    expect(store.getPendingRequest('s2')?.type).toBe('transaction');

    // Resolving one does not touch the other.
    store.resolveConfirmation('s1', { confirmed: true });
    const r1: DAppConfirmationResult = await p1;
    expect(r1.confirmed).toBe(true);
    expect(store.getPendingRequest('s2')?.type).toBe('transaction');

    store.resolveConfirmation('s2', { confirmed: false });
    const r2: DAppConfirmationResult = await p2;
    expect(r2.confirmed).toBe(false);
  });

  it('getAllPendingRequests returns every entry across every session', async () => {
    const store = await freshStore();
    const p1 = store.requestConfirmation(makeRequest({ sessionId: 's1' }));
    const p2 = store.requestConfirmation(makeRequest({ sessionId: 's2' }));
    const p3 = store.requestConfirmation(makeRequest({ sessionId: 's3' }));
    expect(store.getAllPendingRequests()).toHaveLength(3);
    store.resolveConfirmation('s1', { confirmed: false });
    store.resolveConfirmation('s2', { confirmed: false });
    store.resolveConfirmation('s3', { confirmed: false });
    await Promise.all([p1, p2, p3]);
  });
});

describe('implicit-reject on replace (nit fix from round-1 review)', () => {
  it('resolves the previous promise with { confirmed: false } when a new request for the same sessionId arrives', async () => {
    const store = await freshStore();
    const firstPromise = store.requestConfirmation(makeRequest({ sessionId: 's1', id: 'first' }));

    // Second request for the same session: the first should be
    // implicit-rejected and its promise should resolve without any
    // external intervention.
    const secondPromise = store.requestConfirmation(makeRequest({ sessionId: 's1', id: 'second' }));

    const firstResult = await firstPromise;
    expect(firstResult).toEqual({ confirmed: false });

    // The second request is now the active one.
    expect(store.getPendingRequest('s1')?.id).toBe('second');

    store.resolveConfirmation('s1', { confirmed: true });
    const secondResult = await secondPromise;
    expect(secondResult).toEqual({ confirmed: true });
  });
});

describe('resolveConfirmation edge cases', () => {
  it('is a no-op when called for an unknown sessionId', async () => {
    const store = await freshStore();
    expect(() => store.resolveConfirmation('ghost', { confirmed: true })).not.toThrow();
  });

  it('deletes the pending entry after resolution', async () => {
    const store = await freshStore();
    const promise = store.requestConfirmation(makeRequest({ sessionId: 's1' }));
    store.resolveConfirmation('s1', { confirmed: true });
    await promise;
    expect(store.getPendingRequest('s1')).toBeNull();
    expect(store.getAllPendingRequests()).toHaveLength(0);
  });
});

describe('hasPendingRequest', () => {
  it('returns false for an empty store', async () => {
    const store = await freshStore();
    expect(store.hasPendingRequest()).toBe(false);
    expect(store.hasPendingRequest('s1')).toBe(false);
  });

  it('returns true when any session has a pending request (no arg)', async () => {
    const store = await freshStore();
    store.requestConfirmation(makeRequest({ sessionId: 's1' }));
    expect(store.hasPendingRequest()).toBe(true);
    store.resolveConfirmation('s1', { confirmed: false });
    expect(store.hasPendingRequest()).toBe(false);
  });

  it('returns true only for the specific session when arg is provided', async () => {
    const store = await freshStore();
    store.requestConfirmation(makeRequest({ sessionId: 's1' }));
    expect(store.hasPendingRequest('s1')).toBe(true);
    expect(store.hasPendingRequest('s2')).toBe(false);
    store.resolveConfirmation('s1', { confirmed: false });
  });
});

describe('subscribe / notify', () => {
  it('notifies listeners on every request + resolve', async () => {
    const store = await freshStore();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);

    store.requestConfirmation(makeRequest({ sessionId: 's1' }));
    expect(listener).toHaveBeenCalledTimes(1);

    store.requestConfirmation(makeRequest({ sessionId: 's2' }));
    expect(listener).toHaveBeenCalledTimes(2);

    store.resolveConfirmation('s1', { confirmed: false });
    expect(listener).toHaveBeenCalledTimes(3);

    store.resolveConfirmation('s2', { confirmed: false });
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    store.requestConfirmation(makeRequest({ sessionId: 's3' }));
    expect(listener).toHaveBeenCalledTimes(4); // unchanged after unsubscribe
    store.resolveConfirmation('s3', { confirmed: false });
  });

  it('supports multiple listeners independently', async () => {
    const store = await freshStore();
    const a = jest.fn();
    const b = jest.fn();
    store.subscribe(a);
    store.subscribe(b);

    store.requestConfirmation(makeRequest({ sessionId: 's1' }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    store.resolveConfirmation('s1', { confirmed: false });
  });
});

describe('instanceId', () => {
  it('exposes a stable per-instance id via getInstanceId', async () => {
    const store = await freshStore();
    const id1 = store.getInstanceId();
    const id2 = store.getInstanceId();
    expect(id1).toBe(id2);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(0);
  });
});
