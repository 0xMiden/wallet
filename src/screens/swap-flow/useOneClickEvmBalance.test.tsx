import { act, renderHook } from '@testing-library/react';

import { OneClickAsset } from 'lib/one-click/types';

import { useOneClickEvmBalance } from './useOneClickEvmBalance';

const firstAddress = '0x1111111111111111111111111111111111111111';
const secondAddress = '0x2222222222222222222222222222222222222222';
const asset: OneClickAsset = {
  assetId: 'usdc',
  blockchain: 'base',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x3333333333333333333333333333333333333333',
  chainId: 8453
};
const snapshot = (account: string) => ({
  chainId: 8453,
  account,
  assetId: asset.assetId,
  tokenBalance: 10n,
  nativeBalance: 20n,
  gasReserve: 2n,
  spendableTokenBalance: 10n,
  spendableNativeBalance: 18n,
  requiredTokenAmount: 8n,
  tokenSufficient: true,
  gasSufficient: true,
  canDeposit: true,
  estimatedGas: 100n,
  maxFeePerGas: 3n,
  updatedAt: Date.now()
});

const mockRead = jest.fn();
jest.mock('lib/one-click/evm-balance', () => ({
  readOneClickEvmBalance: (...args: unknown[]) => mockRead(...args)
}));

describe('useOneClickEvmBalance', () => {
  beforeEach(() => jest.clearAllMocks());

  it('clears stale account data and ignores an older response after an account change', async () => {
    let resolveFirst: (value: ReturnType<typeof snapshot>) => void = () => {};
    mockRead.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        })
    );
    mockRead.mockResolvedValueOnce(snapshot(secondAddress));
    const { result, rerender } = renderHook(props => useOneClickEvmBalance(props), {
      initialProps: { active: true, account: firstAddress, asset, amountIn: '8', depositAddress: secondAddress }
    });
    expect(result.current.status).toBe('loading');

    rerender({ active: true, account: secondAddress, asset, amountIn: '8', depositAddress: firstAddress });
    await act(async () => {});
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.account).toBe(secondAddress);

    await act(async () => {
      resolveFirst(snapshot(firstAddress));
    });
    expect(result.current.snapshot?.account).toBe(secondAddress);
  });

  it('does not poll while inactive and exposes no prior snapshot when a refresh fails', async () => {
    mockRead.mockResolvedValueOnce(snapshot(firstAddress));
    mockRead.mockRejectedValueOnce(new Error('RPC unavailable'));
    const { result, rerender } = renderHook(props => useOneClickEvmBalance(props), {
      initialProps: { active: true, account: firstAddress, asset, amountIn: '8', depositAddress: secondAddress }
    });
    await act(async () => {});
    expect(result.current.status).toBe('ready');

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.snapshot).toBeUndefined();

    rerender({ active: false, account: firstAddress, asset, amountIn: '8', depositAddress: secondAddress });
    expect(result.current.status).toBe('idle');
  });

  it('stops balance refreshes once a deposit is submitted', async () => {
    mockRead.mockResolvedValue(snapshot(firstAddress));
    const { result, rerender } = renderHook(props => useOneClickEvmBalance(props), {
      initialProps: { active: true, submitted: false, account: firstAddress, asset, amountIn: '8' }
    });
    await act(async () => {});
    expect(mockRead).toHaveBeenCalledTimes(1);

    rerender({ active: true, submitted: true, account: firstAddress, asset, amountIn: '8' });
    expect(result.current.status).toBe('idle');
    await act(async () => {
      await result.current.refresh();
    });
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('debounces rapid amount edits to one settled balance and gas read', async () => {
    jest.useFakeTimers();
    mockRead.mockImplementation(async ({ account: currentAccount }: { account: string }) => snapshot(currentAccount));
    const { result, rerender } = renderHook(props => useOneClickEvmBalance(props), {
      initialProps: { active: true, account: firstAddress, asset, amountIn: '8' }
    });
    await act(async () => {});
    expect(mockRead).toHaveBeenCalledTimes(1);

    rerender({ active: true, account: firstAddress, asset, amountIn: '9' });
    expect(result.current.status).toBe('loading');
    rerender({ active: true, account: firstAddress, asset, amountIn: '10' });
    await act(async () => {
      jest.advanceTimersByTime(349);
    });
    expect(mockRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(mockRead.mock.calls[1][0]).toMatchObject({ amountIn: '10' });
    jest.useRealTimers();
  });
});
