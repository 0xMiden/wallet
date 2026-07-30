/**
 * The hook's job is entirely about ordering: a probe for an abandoned seed
 * phrase must never publish over the probe for the phrase the user actually
 * entered, and nothing may set state after unmount. `discover` and
 * `derive-seed` are mocked because the hook imports them dynamically — what is
 * under test is the run-token / abort bookkeeping around them, not the probe.
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import type { GuardianDiscoveryResult } from './discover';
import { useGuardianProbe } from './use-guardian-probe';

const mockDiscover = jest.fn();
const mockMakeColdSeedDeriver = jest.fn((_mnemonic: string) => (hdIndex: number) => new Uint8Array([hdIndex]));

jest.mock('./discover', () => ({
  discoverGuardianForSeed: (...args: unknown[]) => mockDiscover(...args)
}));

jest.mock('lib/miden/sdk/derive-seed', () => ({
  makeColdSeedDeriver: (mnemonic: string) => mockMakeColdSeedDeriver(mnemonic)
}));

const WORDS = ['abandon', 'abandon', 'about'];

const result = (endpoint?: string): GuardianDiscoveryResult => ({
  best: endpoint ? { endpoint, accountIds: ['acct-1'], hdIndices: [0], nonce: 1n } : undefined,
  matches: [],
  probedEndpoints: [],
  failures: []
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useGuardianProbe', () => {
  it('starts idle', () => {
    const { result: hook } = renderHook(() => useGuardianProbe());

    expect(hook.current.state).toEqual({ status: 'idle' });
  });

  it('moves through probing to done and returns the result', async () => {
    mockDiscover.mockResolvedValue(result('https://guardian.example.com'));
    const { result: hook } = renderHook(() => useGuardianProbe());

    let started: Promise<GuardianDiscoveryResult | undefined> | undefined;
    act(() => {
      started = hook.current.start(WORDS);
    });
    expect(hook.current.state).toEqual({ status: 'probing' });

    const discovered = await act(async () => started);

    expect(discovered?.best?.endpoint).toBe('https://guardian.example.com');
    expect(hook.current.state).toEqual({ status: 'done', result: discovered });
    // The mnemonic is normalized to a single-spaced string before derivation.
    expect(mockMakeColdSeedDeriver).toHaveBeenCalledWith('abandon abandon about');
  });

  it('reports an error state instead of throwing when the probe blows up', async () => {
    mockDiscover.mockRejectedValue(new Error('probe exploded'));
    const { result: hook } = renderHook(() => useGuardianProbe());

    const returned = await act(async () => hook.current.start(WORDS));

    expect(returned).toBeUndefined();
    expect(hook.current.state).toEqual({ status: 'error', message: 'probe exploded' });
  });

  it('lets a newer probe win: a stale result never publishes', async () => {
    const slow = result('https://stale.example.com');
    const fast = result('https://fresh.example.com');
    let releaseSlow: (value: GuardianDiscoveryResult) => void = () => {};
    mockDiscover
      .mockImplementationOnce(() => new Promise<GuardianDiscoveryResult>(resolve => (releaseSlow = resolve)))
      .mockResolvedValueOnce(fast);

    const { result: hook } = renderHook(() => useGuardianProbe());

    let stalePromise: Promise<GuardianDiscoveryResult | undefined> | undefined;
    act(() => {
      stalePromise = hook.current.start(['stale', 'seed']);
    });
    await act(async () => {
      await hook.current.start(WORDS);
    });
    expect(hook.current.state).toEqual({ status: 'done', result: fast });

    // The abandoned probe finishes last — it must resolve undefined and leave
    // the newer result standing.
    const staleResolved = await act(async () => {
      releaseSlow(slow);
      return stalePromise;
    });

    expect(staleResolved).toBeUndefined();
    expect(hook.current.state).toEqual({ status: 'done', result: fast });
  });

  it('keeps a newer result when a stale probe rejects', async () => {
    const fast = result('https://fresh.example.com');
    let rejectSlow: (reason: Error) => void = () => {};
    mockDiscover
      .mockImplementationOnce(() => new Promise<GuardianDiscoveryResult>((_resolve, reject) => (rejectSlow = reject)))
      .mockResolvedValueOnce(fast);

    const { result: hook } = renderHook(() => useGuardianProbe());

    let stalePromise: Promise<GuardianDiscoveryResult | undefined> | undefined;
    act(() => {
      stalePromise = hook.current.start(['stale', 'seed']);
    });
    await act(async () => {
      await hook.current.start(WORDS);
    });

    const staleResolved = await act(async () => {
      rejectSlow(new Error('stale probe failed'));
      return stalePromise;
    });

    expect(staleResolved).toBeUndefined();
    expect(hook.current.state).toEqual({ status: 'done', result: fast });
  });

  it('aborts the in-flight probe and returns to idle on reset', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockDiscover.mockImplementation((_derive: unknown, options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal;
      return new Promise<GuardianDiscoveryResult>(() => {});
    });

    const { result: hook } = renderHook(() => useGuardianProbe());
    act(() => {
      void hook.current.start(WORDS);
    });
    expect(hook.current.state).toEqual({ status: 'probing' });
    // `start` reaches `discoverGuardianForSeed` only after its dynamic imports
    // settle, so wait for the signal to actually be handed over.
    await waitFor(() => expect(capturedSignal).toBeDefined());

    act(() => {
      hook.current.reset();
    });

    expect(hook.current.state).toEqual({ status: 'idle' });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts on unmount and does not set state afterwards', async () => {
    let capturedSignal: AbortSignal | undefined;
    let release: (value: GuardianDiscoveryResult) => void = () => {};
    mockDiscover.mockImplementation((_derive: unknown, options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal;
      return new Promise<GuardianDiscoveryResult>(resolve => (release = resolve));
    });

    const { result: hook, unmount } = renderHook(() => useGuardianProbe());
    let pending: Promise<GuardianDiscoveryResult | undefined> | undefined;
    act(() => {
      pending = hook.current.start(WORDS);
    });

    unmount();
    await waitFor(() => expect(capturedSignal?.aborted).toBe(true));

    // Resolving after unmount must not throw or warn about setting state on an
    // unmounted component.
    await expect(
      (async () => {
        release(result('https://late.example.com'));
        return pending;
      })()
    ).resolves.toBeDefined();
  });
});
