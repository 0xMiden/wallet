import { act, renderHook, waitFor } from '@testing-library/react';

import { maxSendableNative } from 'lib/miden/fees/spendable';
import { getVerificationBaseFee, getVerificationBaseFeeSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

import useVerificationBaseFee from './useVerificationBaseFee';

jest.mock('lib/miden-chain/native-asset', () => ({
  getVerificationBaseFee: jest.fn(),
  getVerificationBaseFeeSync: jest.fn(),
  onNativeAssetChanged: jest.fn()
}));

const mockAsync = getVerificationBaseFee as jest.MockedFunction<typeof getVerificationBaseFee>;
const mockSync = getVerificationBaseFeeSync as jest.MockedFunction<typeof getVerificationBaseFeeSync>;
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
