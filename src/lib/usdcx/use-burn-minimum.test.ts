import { act, renderHook } from '@testing-library/react';

import { readUsdcxMinimumBurn } from './burn';
import { useBurnMinimum } from './use-burn-minimum';

jest.mock('./burn', () => ({ readUsdcxMinimumBurn: jest.fn() }));

beforeEach(() => {
  jest.mocked(readUsdcxMinimumBurn).mockReset();
});

it('shows 5 USDCx until the read lands, then the read minimum', async () => {
  jest.mocked(readUsdcxMinimumBurn).mockResolvedValue(8_000_000n);
  const { result } = renderHook(() => useBurnMinimum(true));
  expect(result.current).toBe(5_000_000n);
  await act(async () => {});
  expect(result.current).toBe(8_000_000n);
});

it('makes no read while disabled', () => {
  const { result } = renderHook(() => useBurnMinimum(false));
  expect(result.current).toBe(5_000_000n);
  expect(readUsdcxMinimumBurn).not.toHaveBeenCalled();
});

it('ignores a stale read after disabling and re-enabling', async () => {
  let landPrevious: (value: bigint) => void = () => {};
  let landCurrent: (value: bigint) => void = () => {};
  jest
    .mocked(readUsdcxMinimumBurn)
    .mockReturnValueOnce(
      new Promise(resolve => {
        landPrevious = resolve;
      })
    )
    .mockReturnValueOnce(
      new Promise(resolve => {
        landCurrent = resolve;
      })
    );
  const { result, rerender } = renderHook(({ enabled }) => useBurnMinimum(enabled), {
    initialProps: { enabled: true }
  });
  rerender({ enabled: false });
  rerender({ enabled: true });
  await act(async () => landCurrent(8_000_000n));
  expect(result.current).toBe(8_000_000n);
  await act(async () => landPrevious(9_000_000n));
  expect(result.current).toBe(8_000_000n);
});
