import { act, renderHook } from '@testing-library/react';

import { useDepositToken } from './useDepositToken';

describe('useDepositToken', () => {
  it('can open directly on Circle USDC without clearing an in-flight attempt', () => {
    const onChange = jest.fn();
    const { result } = renderHook(() => useDepositToken(onChange, 'CIRCLE_USDC'));
    expect(result.current.token).toBe('CIRCLE_USDC');
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
});
