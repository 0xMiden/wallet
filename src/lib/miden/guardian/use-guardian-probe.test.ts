/**
 * The hook's job is entirely about ordering: a probe for an abandoned seed
 * phrase must never publish over the probe for the phrase the user actually
 * entered, and nothing may set state after unmount. `discover` and
 * `derive-seed` are mocked because the hook imports them dynamically — what is
 * under test is the run-token / abort bookkeeping around them, not the probe.
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { _resetGuardianRegistryForTest, setDocumentGuardians } from 'lib/miden-chain/guardian-registry';

import type { GuardianDiscoveryResult } from './discover';
import { useGuardianProbe } from './use-guardian-probe';

const mockDiscover = jest.fn();
const mockDiscoverByHotKey = jest.fn();
const mockMakeColdSeedDeriver = jest.fn((_mnemonic: string) => (hdIndex: number) => new Uint8Array([hdIndex]));

jest.mock('./discover', () => ({
  discoverGuardianForSeed: (...args: unknown[]) => mockDiscover(...args),
  discoverGuardianForHotKey: (...args: unknown[]) => mockDiscoverByHotKey(...args)
}));

jest.mock('lib/miden/sdk/derive-seed', () => ({
  makeColdSeedDeriver: (mnemonic: string) => mockMakeColdSeedDeriver(mnemonic)
}));

// A release build's own network is testnet or devnet; mainnet is a stored choice.
let mockEffectiveNetwork: MIDEN_NETWORK_NAME = MIDEN_NETWORK_NAME.TESTNET;
// The developer's custom Guardian, set while the effective network is the one it belongs to.
let mockCustomGuardian = '';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockEffectiveNetwork,
  getEffectiveGuardianUrl: () => mockCustomGuardian
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
  mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
  mockCustomGuardian = '';
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  _resetGuardianRegistryForTest();
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

/**
 * The hot-key variant rides the same run-token scaffolding as `start`; what
 * matters is that it drives the key discovery (no seed derivation) and that
 * the two variants supersede EACH OTHER — a user backing out of the key screen
 * to re-enter a seed must not see the abandoned key probe publish late.
 */
describe('useGuardianProbe.startWithKey', () => {
  const HOT_KEY_HEX = 'ab'.repeat(32);

  it('probes by key, publishes the result, and never touches seed derivation', async () => {
    mockDiscoverByHotKey.mockResolvedValue(result('https://guardian.example.com'));
    const { result: hook } = renderHook(() => useGuardianProbe());

    let started: Promise<GuardianDiscoveryResult | undefined> | undefined;
    act(() => {
      started = hook.current.startWithKey(HOT_KEY_HEX);
    });
    expect(hook.current.state).toEqual({ status: 'probing' });

    const discovered = await act(async () => started);

    expect(discovered?.best?.endpoint).toBe('https://guardian.example.com');
    expect(hook.current.state).toEqual({ status: 'done', result: discovered });
    expect(mockDiscoverByHotKey).toHaveBeenCalledWith(
      HOT_KEY_HEX,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mockMakeColdSeedDeriver).not.toHaveBeenCalled();
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('reports an error state instead of throwing when the key probe blows up', async () => {
    mockDiscoverByHotKey.mockRejectedValue(new Error('key probe exploded'));
    const { result: hook } = renderHook(() => useGuardianProbe());

    const returned = await act(async () => hook.current.startWithKey(HOT_KEY_HEX));

    expect(returned).toBeUndefined();
    expect(hook.current.state).toEqual({ status: 'error', message: 'key probe exploded' });
  });

  it('a seed probe started after a key probe supersedes it', async () => {
    const stale = result('https://stale-key.example.com');
    const fresh = result('https://fresh-seed.example.com');
    let releaseKeyProbe: (value: GuardianDiscoveryResult) => void = () => {};
    mockDiscoverByHotKey.mockImplementation(
      () => new Promise<GuardianDiscoveryResult>(resolve => (releaseKeyProbe = resolve))
    );
    mockDiscover.mockResolvedValue(fresh);

    const { result: hook } = renderHook(() => useGuardianProbe());

    let stalePromise: Promise<GuardianDiscoveryResult | undefined> | undefined;
    act(() => {
      stalePromise = hook.current.startWithKey(HOT_KEY_HEX);
    });
    await act(async () => {
      await hook.current.start(WORDS);
    });
    expect(hook.current.state).toEqual({ status: 'done', result: fresh });

    const staleResolved = await act(async () => {
      releaseKeyProbe(stale);
      return stalePromise;
    });

    expect(staleResolved).toBeUndefined();
    expect(hook.current.state).toEqual({ status: 'done', result: fresh });
  });

  it('aborts the in-flight key probe on reset', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockDiscoverByHotKey.mockImplementation((_hex: unknown, options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal;
      return new Promise<GuardianDiscoveryResult>(() => {});
    });

    const { result: hook } = renderHook(() => useGuardianProbe());
    act(() => {
      void hook.current.startWithKey(HOT_KEY_HEX);
    });
    await waitFor(() => expect(capturedSignal).toBeDefined());

    act(() => {
      hook.current.reset();
    });

    expect(hook.current.state).toEqual({ status: 'idle' });
    expect(capturedSignal?.aborted).toBe(true);
  });
});

/**
 * The probe asks the operators of the network the recovery restores into: the effective one, or the one the host
 * names (ForgotPassword recovers on mainnet before it switches). A network that lists no operator has nothing to
 * detect, so the probe never starts.
 */
describe('useGuardianProbe network', () => {
  const HOT_KEY_HEX = 'ab'.repeat(32);
  const MAINNET_OPERATOR = {
    id: 'mainnet-operator',
    name: 'Mainnet Operator',
    operatedBy: 'Operator Co',
    location: 'EU',
    endpoint: 'https://guardian-mainnet.example'
  };
  type Starter = (probe: ReturnType<typeof useGuardianProbe>) => Promise<GuardianDiscoveryResult | undefined>;
  const starters: Array<[string, Starter, jest.Mock]> = [
    ['a seed', probe => probe.start(WORDS), mockDiscover],
    ['a hot key', probe => probe.startWithKey(HOT_KEY_HEX), mockDiscoverByHotKey]
  ];

  beforeEach(() => {
    mockDiscover.mockResolvedValue(result());
    mockDiscoverByHotKey.mockResolvedValue(result());
  });

  it.each(starters)('starts no probe for %s on a network that lists no operator', async (_flow, begin, discover) => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []);
    const { result: hook } = renderHook(() => useGuardianProbe());

    const returned = await act(async () => begin(hook.current));

    expect(returned).toBeUndefined();
    expect(hook.current.state).toEqual({ status: 'idle' });
    expect(discover).not.toHaveBeenCalled();
    expect(mockMakeColdSeedDeriver).not.toHaveBeenCalled();
  });

  it.each(starters)('probes for %s at the operators mainnet lists', async (_flow, begin, discover) => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, [MAINNET_OPERATOR]);
    const { result: hook } = renderHook(() => useGuardianProbe());

    await act(async () => begin(hook.current));

    expect(discover).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ network: MIDEN_NETWORK_NAME.MAINNET })
    );
  });

  it.each(starters)('probes for %s at the operators of the network the host names', async (_flow, begin, discover) => {
    setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []);
    const { result: hook } = renderHook(() => useGuardianProbe(MIDEN_NETWORK_NAME.MAINNET));

    await act(async () => begin(hook.current));
    expect(discover).not.toHaveBeenCalled();
    expect(hook.current.state).toEqual({ status: 'idle' });

    setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, [MAINNET_OPERATOR]);
    await act(async () => begin(hook.current));
    expect(discover).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ network: MIDEN_NETWORK_NAME.MAINNET })
    );
  });

  it.each(starters)(
    'probes for %s at the custom Guardian set on a mainnet that lists no operator',
    async (_flow, begin, discover) => {
      mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
      mockCustomGuardian = 'https://custom.guardian.example';
      setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []);
      const { result: hook } = renderHook(() => useGuardianProbe());

      await act(async () => begin(hook.current));

      expect(discover).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ network: MIDEN_NETWORK_NAME.MAINNET })
      );
    }
  );

  it.each(starters)(
    'starts no probe for %s at a testnet custom Guardian when the host names mainnet',
    async (_flow, begin, discover) => {
      mockCustomGuardian = 'https://custom.guardian.example';
      setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []);
      const { result: hook } = renderHook(() => useGuardianProbe(MIDEN_NETWORK_NAME.MAINNET));

      const returned = await act(async () => begin(hook.current));

      expect(returned).toBeUndefined();
      expect(discover).not.toHaveBeenCalled();
      expect(hook.current.state).toEqual({ status: 'idle' });
    }
  );

  it.each(starters)('probes for %s at the testnet operators on testnet', async (_flow, begin, discover) => {
    const { result: hook } = renderHook(() => useGuardianProbe());

    await act(async () => begin(hook.current));

    expect(discover).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ network: MIDEN_NETWORK_NAME.TESTNET })
    );
  });

  it('ends a running probe when a later start finds no operator', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockDiscover.mockImplementation((_derive: unknown, options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal;
      return new Promise<GuardianDiscoveryResult>(() => {});
    });
    const { result: hook } = renderHook(() => useGuardianProbe());
    act(() => {
      void hook.current.start(WORDS);
    });
    await waitFor(() => expect(capturedSignal).toBeDefined());

    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []);
    await act(async () => hook.current.start(WORDS));

    expect(capturedSignal?.aborted).toBe(true);
    expect(hook.current.state).toEqual({ status: 'idle' });
  });
});
