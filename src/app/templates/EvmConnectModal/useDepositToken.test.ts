import { act, renderHook } from '@testing-library/react';

import { useDepositToken } from './useDepositToken';

describe('useDepositToken', () => {
  // ETH, not the default, so a hook that ignored its initial token would fail here.
  it('can open directly on another token without clearing an in-flight attempt', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useDepositToken(onChange, 'ETH'));
    expect(result.current.token).toBe('ETH');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('switches to a different token and clears the old token state once', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useDepositToken(onChange));
    expect(result.current.token).toBe('CIRCLE_USDC');

    act(() => result.current.selectToken('ETH'));

    expect(result.current.token).toBe('ETH');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the quote and every other state when the selected token is picked again', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useDepositToken(onChange));

    act(() => result.current.selectToken('CIRCLE_USDC'));

    expect(result.current.token).toBe('CIRCLE_USDC');
    expect(onChange).not.toHaveBeenCalled();
  });

  // An ERC-20 choice is an object: two picks of the same contract are one token, another contract is a change.
  it('compares ERC-20 choices by contract address, not by identity', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useDepositToken(onChange));
    const wbtc = { kind: 'erc20' as const, contractAddress: '0x21472df1b5d2b673f6444b41258c6460294a2c06' as const };

    act(() => result.current.selectToken(wbtc));
    expect(result.current.token).toEqual(wbtc);
    expect(onChange).toHaveBeenCalledTimes(1);

    act(() => result.current.selectToken({ ...wbtc }));
    expect(onChange).toHaveBeenCalledTimes(1);

    act(() =>
      result.current.selectToken({ kind: 'erc20', contractAddress: '0x22939b3a4dfd9fc6211f99cdc6bd9f6708ae2956' })
    );
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
