/**
 * Tests for `useDappConfirmation` — the React hook the confirmation
 * modal uses to subscribe to the store for its session's pending
 * request.
 */

import { act, renderHook } from '@testing-library/react';

import { dappConfirmationStore, type DAppConfirmationRequest } from './confirmation-store';
import { useDappConfirmation } from './use-dapp-confirmation';

function makeRequest(overrides: Partial<DAppConfirmationRequest> = {}): DAppConfirmationRequest {
  return {
    id: 'req-1',
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

// Clean up any residual pending entries between tests — the store is
// a singleton so cross-test contamination is real.
afterEach(() => {
  const all = dappConfirmationStore.getAllPendingRequests();
  for (const req of all) {
    dappConfirmationStore.resolveConfirmation(req.sessionId, { confirmed: false });
  }
});

describe('useDappConfirmation — initial state', () => {
  it('returns null when no pending request exists', () => {
    const { result } = renderHook(() => useDappConfirmation('s1'));
    expect(result.current.request).toBeNull();
  });

  it('picks up an existing pending request on first render', () => {
    // Pre-seed the store BEFORE rendering.
    void dappConfirmationStore.requestConfirmation(makeRequest({ sessionId: 's1', type: 'transaction' }));
    const { result } = renderHook(() => useDappConfirmation('s1'));
    expect(result.current.request?.type).toBe('transaction');
  });
});

describe('useDappConfirmation — subscribes to store changes', () => {
  it('updates when a new request is added to the same session', () => {
    const { result } = renderHook(() => useDappConfirmation('s1'));
    expect(result.current.request).toBeNull();

    act(() => {
      void dappConfirmationStore.requestConfirmation(makeRequest({ sessionId: 's1', type: 'sign' }));
    });

    expect(result.current.request?.type).toBe('sign');
  });

  it('clears when the request is resolved', () => {
    void dappConfirmationStore.requestConfirmation(makeRequest({ sessionId: 's1' }));
    const { result } = renderHook(() => useDappConfirmation('s1'));
    expect(result.current.request).not.toBeNull();

    act(() => {
      dappConfirmationStore.resolveConfirmation('s1', { confirmed: true });
    });

    expect(result.current.request).toBeNull();
  });
});

describe('useDappConfirmation — session isolation', () => {
  it('only surfaces requests for the subscribed sessionId', () => {
    const { result } = renderHook(() => useDappConfirmation('s1'));
    act(() => {
      void dappConfirmationStore.requestConfirmation(makeRequest({ sessionId: 's2', type: 'transaction' }));
    });
    expect(result.current.request).toBeNull();
  });

  it('the resolve callback targets the subscribed sessionId', async () => {
    let resolved = false;
    const promise = dappConfirmationStore.requestConfirmation(makeRequest({ sessionId: 's1' })).then(res => {
      resolved = res.confirmed;
    });
    const { result } = renderHook(() => useDappConfirmation('s1'));

    act(() => {
      result.current.resolve({ confirmed: true });
    });

    await promise;
    expect(resolved).toBe(true);
  });
});

describe('useDappConfirmation — legacy default slot', () => {
  it('without a sessionId returns the default-slot pending request', () => {
    void dappConfirmationStore.requestConfirmation(makeRequest()); // no sessionId
    const { result } = renderHook(() => useDappConfirmation());
    expect(result.current.request?.type).toBe('connect');
  });
});
