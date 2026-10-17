import { act, renderHook, waitFor } from '@testing-library/react';

import { useBurnFeeReserve } from './use-burn-fee-reserve';

const mockEstimate = jest.fn<Promise<bigint | null>, [string, number]>();
jest.mock('lib/miden/front/client', () => ({ useMidenContext: () => ({ estimateUsdcxBurnFee: mockEstimate }) }));

const TARGET = { accountPublicKey: 'mm1account', destinationChainId: 5042002 };
const never = () => new Promise<bigint | null>(() => {});

beforeEach(() => {
  mockEstimate.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('is pending while the estimate runs, and asks for the account and chain only', () => {
  mockEstimate.mockImplementation(never);

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  expect(result.current).toEqual({ status: 'pending', reserve: undefined });
  expect(mockEstimate).toHaveBeenCalledTimes(1);
  expect(mockEstimate).toHaveBeenCalledWith('mm1account', 5042002);
});

it('reports the measured reserve', async () => {
  mockEstimate.mockResolvedValue(315n);

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  await waitFor(() => expect(result.current).toEqual({ status: 'measured', reserve: 315n }));
  expect(mockEstimate).toHaveBeenCalledTimes(1);
});

it('retries a failed estimate once and reports what the retry measured', async () => {
  mockEstimate.mockResolvedValueOnce(null).mockResolvedValueOnce(400n);

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  await waitFor(() => expect(result.current).toEqual({ status: 'measured', reserve: 400n }));
  expect(mockEstimate).toHaveBeenCalledTimes(2);
  expect(mockEstimate).toHaveBeenNthCalledWith(2, 'mm1account', 5042002);
});

it('reports failed once the retry fails too, and stops asking', async () => {
  mockEstimate.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('the request failed'));

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  await waitFor(() => expect(result.current).toEqual({ status: 'failed', reserve: undefined }));
  await act(async () => {});
  expect(mockEstimate).toHaveBeenCalledTimes(2);
});

it('measures nothing without a target', () => {
  renderHook(() => useBurnFeeReserve(undefined));

  expect(mockEstimate).not.toHaveBeenCalled();
});

it('starts pending for a new chain and drops the answer for the previous one', async () => {
  let answerFirst: (reserve: bigint | null) => void = () => {};
  mockEstimate
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerFirst = resolve;
        })
    )
    .mockResolvedValueOnce(500n);

  const { result, rerender } = renderHook(({ target }) => useBurnFeeReserve(target), {
    initialProps: { target: TARGET }
  });
  rerender({ target: { ...TARGET, destinationChainId: 84532 } });
  expect(result.current).toEqual({ status: 'pending', reserve: undefined });

  await act(async () => answerFirst(315n));
  await waitFor(() => expect(result.current).toEqual({ status: 'measured', reserve: 500n }));
  expect(mockEstimate).toHaveBeenLastCalledWith('mm1account', 84532);
});

it('asks again for the same target only once it changes', async () => {
  mockEstimate.mockResolvedValue(315n);

  const { result, rerender } = renderHook(({ target }) => useBurnFeeReserve(target), {
    initialProps: { target: TARGET }
  });
  await waitFor(() => expect(result.current).toEqual({ status: 'measured', reserve: 315n }));
  rerender({ target: { ...TARGET } });

  expect(mockEstimate).toHaveBeenCalledTimes(1);
});
