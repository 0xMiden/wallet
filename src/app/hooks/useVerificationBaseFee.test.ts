import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { maxSendableNative } from 'lib/miden/fees/spendable';
import {
  FEE_PROBE_RETRY_COOLDOWN_MS,
  getClaimFloorBaseFee,
  getClaimFloorBaseFeeSync,
  getVerificationBaseFee,
  getVerificationBaseFeeSync,
  onNativeAssetChanged
} from 'lib/miden-chain/native-asset';

import useVerificationBaseFee, { useClaimFloorBaseFee } from './useVerificationBaseFee';

jest.mock('lib/miden-chain/native-asset', () => ({
  FEE_PROBE_RETRY_COOLDOWN_MS: 60_000,
  getClaimFloorBaseFee: jest.fn(),
  getClaimFloorBaseFeeSync: jest.fn(),
  getVerificationBaseFee: jest.fn(),
  getVerificationBaseFeeSync: jest.fn(),
  onNativeAssetChanged: jest.fn()
}));

const mockAsync = getVerificationBaseFee as jest.MockedFunction<typeof getVerificationBaseFee>;
const mockSync = getVerificationBaseFeeSync as jest.MockedFunction<typeof getVerificationBaseFeeSync>;
const mockFloorAsync = getClaimFloorBaseFee as jest.MockedFunction<typeof getClaimFloorBaseFee>;
const mockFloorSync = getClaimFloorBaseFeeSync as jest.MockedFunction<typeof getClaimFloorBaseFeeSync>;
const mockSubscribe = onNativeAssetChanged as jest.MockedFunction<typeof onNativeAssetChanged>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useVerificationBaseFee', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribe.mockReturnValue(() => {});
  });

  it('reports null before the fee has been discovered', () => {
    // null must survive to the caller: it means "unknown", and a consumer that
    // read it as 0 would reserve nothing on a chain that does charge.
    mockSync.mockReturnValue(null);
    mockAsync.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useVerificationBaseFee());

    expect(result.current).toBeNull();
  });

  it('serves an already-discovered fee synchronously on first render', () => {
    mockSync.mockReturnValue(10000);
    mockAsync.mockResolvedValue(10000);

    const { result } = renderHook(() => useVerificationBaseFee());

    expect(result.current).toBe(10000);
  });

  it('publishes a zero fee rather than leaving the caller at null', async () => {
    // Testnet charges nothing. Zero is a real answer and must replace "unknown",
    // or fee-gated UI would stay hidden forever on a zero-fee chain.
    mockSync.mockReturnValue(null);
    mockAsync.mockResolvedValue(0);

    const { result } = renderHook(() => useVerificationBaseFee());

    await waitFor(() => expect(result.current).toBe(0));
  });

  it('re-reads the fee when native-asset discovery fires', async () => {
    // The fee belongs to ONE chain. Without a subscription the hook kept whatever it
    // read at mount, so a screen mounted before discovery resolved never saw the fee,
    // and an endpoint change left every mounted screen gating on the old chain's
    // value. `useMidenFaucetId` subscribes to this same signal.
    mockSync.mockReturnValue(null);
    mockAsync.mockResolvedValue(null);

    const { result } = renderHook(() => useVerificationBaseFee());
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());
    expect(result.current).toBeNull();

    mockAsync.mockResolvedValue(10000);
    const fire = mockSubscribe.mock.calls[0]![0];
    fire('bech32-native-faucet');

    await waitFor(() => expect(result.current).toBe(10000));
  });

  it('leaves the fee unknown when discovery rejects, rather than failing the render', async () => {
    // A rejected read has to leave the fee `null` -- every guard fails open on null,
    // which is the safe direction -- instead of surfacing as an unhandled rejection.
    mockSync.mockReturnValue(null);
    mockAsync.mockRejectedValue(new Error('rpc unreachable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useVerificationBaseFee());

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current).toBeNull();
    warn.mockRestore();
  });

  it.each([
    { obsoleteFee: null, currentFee: 7, spendable: 0.99979 },
    { obsoleteFee: 19, currentFee: 0, spendable: 1 },
    { obsoleteFee: 7, currentFee: null, spendable: 1 }
  ])('retains current fee $currentFee after obsolete mount fee $obsoleteFee resolves', async fixture => {
    const initial = deferred<number | null>();
    const current = deferred<number | null>();
    mockSync.mockReturnValue(null);
    mockAsync.mockReturnValueOnce(initial.promise).mockReturnValueOnce(current.promise);
    const { result } = renderHook(() => useVerificationBaseFee());
    const fire = mockSubscribe.mock.calls[0]![0];

    await act(async () => {
      fire('current-native');
      current.resolve(fixture.currentFee);
    });
    expect(result.current).toBe(fixture.currentFee);
    expect(maxSendableNative(1, result.current, 6)).toBe(fixture.spendable);

    await act(async () => initial.resolve(fixture.obsoleteFee));
    expect(result.current).toBe(fixture.currentFee);
    expect(maxSendableNative(1, result.current, 6)).toBe(fixture.spendable);
  });

  it('retains the latest discovery fee when two event reads finish out of order', async () => {
    const previous = deferred<number | null>();
    const current = deferred<number | null>();
    mockSync.mockReturnValue(null);
    mockAsync.mockResolvedValueOnce(7).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const { result } = renderHook(() => useVerificationBaseFee());
    await waitFor(() => expect(result.current).toBe(7));
    const fire = mockSubscribe.mock.calls[0]![0];

    await act(async () => {
      fire('previous-native');
      fire('current-native');
      current.resolve(3);
    });
    expect(result.current).toBe(3);
    expect(maxSendableNative(1, result.current, 6)).toBe(0.99991);

    await act(async () => previous.resolve(19));
    expect(result.current).toBe(3);
    expect(maxSendableNative(1, result.current, 6)).toBe(0.99991);
  });

  it('unsubscribes on unmount', () => {
    const unsub = jest.fn();
    mockSync.mockReturnValue(10000);
    mockAsync.mockResolvedValue(10000);
    mockSubscribe.mockReturnValue(unsub);

    renderHook(() => useVerificationBaseFee()).unmount();

    expect(unsub).toHaveBeenCalled();
  });
});

describe('useClaimFloorBaseFee', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribe.mockReturnValue(() => {});
  });

  it('useClaimFloorBaseFee reports 0 once the chain is known to charge nothing', async () => {
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockResolvedValue(0);

    const { result } = renderHook(() => useClaimFloorBaseFee());

    await waitFor(() => expect(result.current).toBe(0));
  });

  it('useClaimFloorBaseFee reads null once the fee is unknown, replacing the fee it was seeded with', async () => {
    mockFloorSync.mockReturnValue(7);
    mockFloorAsync.mockResolvedValue(null);

    const { result } = renderHook(() => useClaimFloorBaseFee());

    expect(result.current).toBe(7);
    await waitFor(() => expect(result.current).toBeNull());
  });

  it('useClaimFloorBaseFee names itself when its read fails', async () => {
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockRejectedValue(new Error('rpc unreachable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    renderHook(() => useClaimFloorBaseFee());

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith('useClaimFloorBaseFee: base fee read failed', expect.any(Error))
    );
    warn.mockRestore();
  });

  it('useClaimFloorBaseFee re-reads when the native asset changes', async () => {
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockResolvedValueOnce(null).mockResolvedValueOnce(7);
    const { result } = renderHook(() => useClaimFloorBaseFee());
    await waitFor(() => expect(mockFloorAsync).toHaveBeenCalledTimes(1));

    await act(async () => {
      mockSubscribe.mock.calls[0]![0]('native');
    });

    await waitFor(() => expect(result.current).toBe(7));
  });
});

describe('claim-floor fee retry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockSubscribe.mockReturnValue(() => {});
  });

  afterEach(() => {
    // Unmount while the fake timer is still the one the hook armed, then restore real timers.
    cleanup();
    jest.useRealTimers();
  });

  async function flushRead(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('reads the claim floor again once the probe cooldown has elapsed', async () => {
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockResolvedValue(null);

    renderHook(() => useClaimFloorBaseFee());
    await flushRead();
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);

    // Fifty-nine seconds: one second short of the probe cooldown.
    await act(async () => {
      jest.advanceTimersByTime(59_000);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS - 59_000);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(2);
  });

  it('does not read the claim floor again when unmounted before the cooldown', async () => {
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockResolvedValue(null);
    const { unmount } = renderHook(() => useClaimFloorBaseFee());
    await flushRead();
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);
    // Settle the mount read first: its continuation arms the retry, so only the cleanup can stop it.
    await act(async () => {
      await mockFloorAsync.mock.results[0]!.value;
    });

    unmount();
    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);
  });

  it('ignores a claim-floor read that resolves after unmount', async () => {
    const pending = deferred<number | null>();
    mockFloorSync.mockReturnValue(4);
    mockFloorAsync.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useClaimFloorBaseFee());
    expect(result.current).toBe(4);
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      pending.resolve(null);
    });
    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);
  });

  it('does not read a resolved zero claim floor again after the cooldown', async () => {
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockResolvedValue(0);
    const { result } = renderHook(() => useClaimFloorBaseFee());
    await flushRead();
    expect(result.current).toBe(0);
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);
  });

  it('does not read the verification fee again after the cooldown while it stays null', async () => {
    mockSync.mockReturnValue(null);
    mockAsync.mockResolvedValue(null);
    renderHook(() => useVerificationBaseFee());
    await flushRead();
    expect(mockAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS);
    });
    expect(mockAsync).toHaveBeenCalledTimes(1);
  });

  it('reads the claim floor again after the cooldown when the read rejects', async () => {
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockRejectedValue(new Error('rpc unreachable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderHook(() => useClaimFloorBaseFee());
    await flushRead();
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('reads a changed native asset immediately and does not also fire the pending retry', async () => {
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockResolvedValueOnce(null).mockResolvedValueOnce(5);
    const { result } = renderHook(() => useClaimFloorBaseFee());
    await flushRead();
    expect(mockFloorAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      mockSubscribe.mock.calls[0]![0]('native');
      await Promise.resolve();
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(5);

    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(2);
  });

  it('drops the pending retry when a native-asset change starts a read that is still in flight', async () => {
    const second = deferred<number | null>();
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockResolvedValueOnce(null).mockReturnValueOnce(second.promise);
    renderHook(() => useClaimFloorBaseFee());
    // Settle the mount read: its continuation arms the retry.
    await act(async () => {
      await mockFloorAsync.mock.results[0]!.value;
    });

    await act(async () => {
      mockSubscribe.mock.calls[0]![0]('native');
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(2);

    // The changed asset's read has not answered when the old retry would have fired.
    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve(5);
    });
  });

  it('keeps a newer claim-floor read when an older one answers after it', async () => {
    const first = deferred<number | null>();
    const second = deferred<number | null>();
    mockFloorSync.mockReturnValue(null);
    mockFloorAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useClaimFloorBaseFee());
    await act(async () => {
      mockSubscribe.mock.calls[0]![0]('native');
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(5);
    });
    expect(result.current).toBe(5);
    // The stale answer neither replaces the newer fee nor arms a retry.
    await act(async () => {
      first.resolve(null);
    });
    expect(result.current).toBe(5);
    await act(async () => {
      jest.advanceTimersByTime(FEE_PROBE_RETRY_COOLDOWN_MS);
    });
    expect(mockFloorAsync).toHaveBeenCalledTimes(2);
  });
});
