import { act, renderHook } from '@testing-library/react';

import { useDepositToken } from './useDepositToken';

describe('useDepositToken', () => {
  it('switches to a different token and clears the old token state once', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useDepositToken(onChange));
    expect(result.current.token).toBe('USDC');

    act(() => result.current.selectToken('ETH'));

    expect(result.current.token).toBe('ETH');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the quote and every other state when the selected token is picked again', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useDepositToken(onChange));

    act(() => result.current.selectToken('USDC'));

    expect(result.current.token).toBe('USDC');
    expect(onChange).not.toHaveBeenCalled();
  });
});
