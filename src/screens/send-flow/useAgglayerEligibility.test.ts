import { act, renderHook, waitFor } from '@testing-library/react';

import { isAgglayerFaucetAllowed } from 'lib/agglayer/allowed-faucets';

import { useAgglayerEligibility } from './useAgglayerEligibility';

let mockRpcUrl = '';
jest.mock('lib/agglayer/allowed-faucets', () => ({ isAgglayerFaucetAllowed: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => mockRpcUrl
}));

beforeEach(() => {
  jest.resetAllMocks();
  mockRpcUrl = 'https://rpc.testnet.miden.io';
});

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
  const failure = new Error('RPC unavailable');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.mocked(isAgglayerFaucetAllowed).mockRejectedValue(failure);
  const { result } = renderHook(() => useAgglayerEligibility('token'));
  await waitFor(() => expect(result.current).toBe('error'));
  expect(warn.mock.calls.map(call => call[call.length - 1])).toContain(failure);
  warn.mockRestore();
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

it('shows loading for a newly selected token after the old one settled (#1276)', async () => {
  const pending = new Promise<boolean>(() => {});
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValueOnce(true).mockReturnValueOnce(pending);
  const { result, rerender } = renderHook(({ id }) => useAgglayerEligibility(id), {
    initialProps: { id: 'old-token' }
  });
  await waitFor(() => expect(result.current).toBe('allowed'));
  rerender({ id: 'new-token' });
  expect(result.current).toBe('loading');
});

it('shows loading after the endpoint changes (#1276)', async () => {
  const pending = new Promise<boolean>(() => {});
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValueOnce(true).mockReturnValueOnce(pending);
  const { result, rerender } = renderHook(() => useAgglayerEligibility('token'));
  await waitFor(() => expect(result.current).toBe('allowed'));
  mockRpcUrl = 'https://rpc.other.example';
  rerender();
  expect(result.current).toBe('loading');
});
