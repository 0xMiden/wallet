import { act, renderHook, waitFor } from '@testing-library/react';

import { isAgglayerFaucetAllowed } from 'lib/agglayer/allowed-faucets';

import { useAgglayerEligibility } from './useAgglayerEligibility';

jest.mock('lib/agglayer/allowed-faucets', () => ({ isAgglayerFaucetAllowed: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => 'https://rpc.testnet.miden.io'
}));

beforeEach(() => jest.resetAllMocks());

it('shows loading, then allows an approved token', async () => {
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValue(true);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  expect(result.current).toBe('loading');
  await waitFor(() => expect(result.current).toBe('allowed'));
});

it('blocks an unregistered token', async () => {
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValue(false);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await waitFor(() => expect(result.current).toBe('unsupported'));
});

it('blocks a failed read', async () => {
  jest.mocked(isAgglayerFaucetAllowed).mockRejectedValue(new Error('RPC unavailable'));
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await waitFor(() => expect(result.current).toBe('error'));
});

it('does not apply an old approval to a newly selected token', async () => {
  let approveOldToken = (_allowed: boolean) => {};
  const oldCheck = new Promise<boolean>(resolve => {
    approveOldToken = resolve;
  });
  jest.mocked(isAgglayerFaucetAllowed).mockReturnValueOnce(oldCheck).mockResolvedValueOnce(false);
  const { result, rerender } = renderHook(({ id }) => useAgglayerEligibility(id), {
    initialProps: { id: 'old-token' }
  });
  rerender({ id: 'new-token' });
  expect(result.current).toBe('loading');
  await waitFor(() => expect(result.current).toBe('unsupported'));
  await act(async () => {
    approveOldToken(true);
    await oldCheck;
  });
  expect(result.current).toBe('unsupported');
});

it('does not check Miden registry entries for an EVM deposit', () => {
  const { result } = renderHook(() => useAgglayerEligibility());
  expect(result.current).toBe('allowed');
  expect(isAgglayerFaucetAllowed).not.toHaveBeenCalled();
});
