import { renderHook, waitFor } from '@testing-library/react';

import { getVerificationBaseFee, getVerificationBaseFeeSync } from 'lib/miden-chain/native-asset';

import useVerificationBaseFee from './useVerificationBaseFee';

jest.mock('lib/miden-chain/native-asset', () => ({
  getVerificationBaseFee: jest.fn(),
  getVerificationBaseFeeSync: jest.fn()
}));

const mockAsync = getVerificationBaseFee as jest.MockedFunction<typeof getVerificationBaseFee>;
const mockSync = getVerificationBaseFeeSync as jest.MockedFunction<typeof getVerificationBaseFeeSync>;

describe('useVerificationBaseFee', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
