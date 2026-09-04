import { renderHook, waitFor } from '@testing-library/react';

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

  it('unsubscribes on unmount', () => {
    const unsub = jest.fn();
    mockSync.mockReturnValue(10000);
    mockAsync.mockResolvedValue(10000);
    mockSubscribe.mockReturnValue(unsub);

    renderHook(() => useVerificationBaseFee()).unmount();

    expect(unsub).toHaveBeenCalled();
  });
});
