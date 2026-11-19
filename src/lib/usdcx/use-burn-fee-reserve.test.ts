import { act, renderHook, waitFor } from '@testing-library/react';

import type { UsdcxBurnFeeEstimate } from 'lib/shared/types';

import { useBurnFeeReserve } from './use-burn-fee-reserve';

const mockEstimate = jest.fn<Promise<UsdcxBurnFeeEstimate>, [string, number]>();
jest.mock('lib/miden/front/client', () => ({ useMidenContext: () => ({ estimateUsdcxBurnFee: mockEstimate }) }));

let mockSourceScope = 'rpc-a|testnet';
let mockNative = 'mm1native';
jest.mock('lib/miden-chain/native-asset', () => ({
  cacheScope: () => mockSourceScope,
  getNativeAssetIdSync: () => mockNative
}));
const SCOPE = '0eab4363008ac48565a556005f9429c4a85838ec79dc00c463d15dcbb4c14c5c';
const TARGET = { accountPublicKey: 'mm1account', destinationChainId: 5042002 };
const never = () => new Promise<UsdcxBurnFeeEstimate>(() => {});
const measured = (reserve: bigint): UsdcxBurnFeeEstimate => ({
  outcome: 'measured',
  reserve,
  faucetId: 'mm1native',
  scope: SCOPE
});
const BUSY: UsdcxBurnFeeEstimate = { outcome: 'busy' };
const FAILED: UsdcxBurnFeeEstimate = { outcome: 'failed' };
/** Longer than every busy backoff the hook waits, so each ask it schedules runs. */
const PAST_EVERY_BACKOFF_MS = 120_000;
/** Settles every answer that has landed and runs the timers due within `ms`. */
const elapse = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  mockSourceScope = 'rpc-a|testnet';
  mockNative = 'mm1native';
  mockEstimate.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('is pending while the estimate runs, and asks for the account and chain only', () => {
  mockEstimate.mockImplementation(never);

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  expect(result.current).toEqual({ status: 'pending', reserve: undefined });
  expect(mockEstimate).toHaveBeenCalledTimes(1);
  expect(mockEstimate).toHaveBeenCalledWith('mm1account', 5042002);
});

it.each(['source', 'native faucet'])('invalidates a measured reserve when its %s changes', async changed => {
  mockEstimate.mockResolvedValueOnce(measured(315n)).mockImplementationOnce(never);
  const { result, rerender } = renderHook(() => useBurnFeeReserve(TARGET));
  await waitFor(() => expect(result.current.reserve).toBe(315n));
  if (changed === 'source') mockSourceScope = 'rpc-b|testnet';
  else mockNative = 'mm1other';
  rerender();
  expect(result.current.status).toBe('pending');
  await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(2));
});

it.each(['scope', 'faucetId'])('does not relabel a backend estimate with the current %s', async field => {
  const reply = measured(315n);
  Reflect.set(reply, field, 'stale');
  mockEstimate.mockResolvedValue(reply);
  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await waitFor(() => expect(result.current).toEqual({ status: 'failed', failure: 'configuration_failed' }));
  expect(mockEstimate).toHaveBeenCalledTimes(2);
});

it('does not invent a scope for an old unscoped backend response', async () => {
  const reply = measured(315n);
  Reflect.deleteProperty(reply, 'scope');
  mockEstimate.mockResolvedValue(reply);
  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await waitFor(() => expect(result.current.status).toBe('failed'));
  expect(result.current.reserve).toBeUndefined();
});

it('reports the measured reserve', async () => {
  mockEstimate.mockResolvedValue(measured(315n));

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  await waitFor(() =>
    expect(result.current).toEqual({ status: 'measured', reserve: 315n, faucetId: 'mm1native', scope: SCOPE })
  );
  expect(mockEstimate).toHaveBeenCalledTimes(1);
});

it('reports a measured zero as measured, not failed', async () => {
  mockEstimate.mockResolvedValue(measured(0n));

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  await waitFor(() =>
    expect(result.current).toEqual({ status: 'measured', reserve: 0n, faucetId: 'mm1native', scope: SCOPE })
  );
  expect(mockEstimate).toHaveBeenCalledTimes(1);
});

it('retries a failed estimate once and reports what the retry measured', async () => {
  mockEstimate.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(measured(400n));

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  await waitFor(() =>
    expect(result.current).toEqual({ status: 'measured', reserve: 400n, faucetId: 'mm1native', scope: SCOPE })
  );
  expect(mockEstimate).toHaveBeenCalledTimes(2);
  expect(mockEstimate).toHaveBeenNthCalledWith(2, 'mm1account', 5042002);
});

it('reports failed once the retry fails too, and stops asking', async () => {
  mockEstimate.mockResolvedValueOnce(FAILED).mockRejectedValueOnce(new Error('the request failed'));

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));

  await waitFor(() => expect(result.current).toEqual({ status: 'failed', failure: 'request_failed' }));
  await act(async () => {});
  expect(mockEstimate).toHaveBeenCalledTimes(2);
});

it('stays pending while the lock is busy and asks again after a backoff, reporting what a later ask measured', async () => {
  jest.useFakeTimers();
  mockEstimate.mockResolvedValueOnce(BUSY).mockResolvedValueOnce(BUSY).mockResolvedValueOnce(measured(315n));

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await elapse(0);

  expect(result.current).toEqual({ status: 'pending', reserve: undefined });
  expect(mockEstimate).toHaveBeenCalledTimes(1);

  await elapse(PAST_EVERY_BACKOFF_MS);

  expect(result.current).toEqual({ status: 'measured', reserve: 315n, faucetId: 'mm1native', scope: SCOPE });
  expect(mockEstimate).toHaveBeenCalledTimes(3);
});

it('reports failed after three busy answers and stops asking', async () => {
  jest.useFakeTimers();
  mockEstimate.mockResolvedValue(BUSY);

  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await elapse(PAST_EVERY_BACKOFF_MS);

  expect(result.current).toEqual({ status: 'failed', failure: 'busy_exhausted' });
  expect(mockEstimate).toHaveBeenCalledTimes(3);
  await elapse(PAST_EVERY_BACKOFF_MS);
  expect(mockEstimate).toHaveBeenCalledTimes(3);
});

it('makes no further estimate once it unmounts during the busy backoff', async () => {
  jest.useFakeTimers();
  mockEstimate.mockResolvedValue(BUSY);

  const { result, unmount } = renderHook(() => useBurnFeeReserve(TARGET));
  await elapse(0);
  expect(result.current).toEqual({ status: 'pending', reserve: undefined });
  unmount();
  await elapse(PAST_EVERY_BACKOFF_MS);

  expect(mockEstimate).toHaveBeenCalledTimes(1);
});

it("makes no call for the old chain once the chain changes during that chain's busy backoff", async () => {
  jest.useFakeTimers();
  mockEstimate.mockImplementation(async (_account, chainId) =>
    chainId === TARGET.destinationChainId ? BUSY : measured(500n)
  );

  const { result, rerender } = renderHook(({ target }) => useBurnFeeReserve(target), {
    initialProps: { target: TARGET }
  });
  await elapse(0);
  expect(result.current).toEqual({ status: 'pending', reserve: undefined });
  rerender({ target: { ...TARGET, destinationChainId: 84532 } });
  await elapse(PAST_EVERY_BACKOFF_MS);

  expect(result.current).toEqual({ status: 'measured', reserve: 500n, faucetId: 'mm1native', scope: SCOPE });
  expect(mockEstimate.mock.calls).toEqual([
    ['mm1account', 5042002],
    ['mm1account', 84532]
  ]);
});

it('measures nothing without a target', () => {
  renderHook(() => useBurnFeeReserve(undefined));

  expect(mockEstimate).not.toHaveBeenCalled();
});

it('starts pending for a new chain and drops the answer for the previous one', async () => {
  let answerFirst: (estimate: UsdcxBurnFeeEstimate) => void = () => {};
  mockEstimate
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerFirst = resolve;
        })
    )
    .mockResolvedValueOnce(measured(500n));

  const { result, rerender } = renderHook(({ target }) => useBurnFeeReserve(target), {
    initialProps: { target: TARGET }
  });
  rerender({ target: { ...TARGET, destinationChainId: 84532 } });
  expect(result.current).toEqual({ status: 'pending', reserve: undefined });

  await act(async () => answerFirst(measured(315n)));
  await waitFor(() =>
    expect(result.current).toEqual({ status: 'measured', reserve: 500n, faucetId: 'mm1native', scope: SCOPE })
  );
  expect(mockEstimate).toHaveBeenLastCalledWith('mm1account', 84532);
});

it('asks again for the same target only once it changes', async () => {
  mockEstimate.mockResolvedValue(measured(315n));

  const { result, rerender } = renderHook(({ target }) => useBurnFeeReserve(target), {
    initialProps: { target: TARGET }
  });
  await waitFor(() =>
    expect(result.current).toEqual({ status: 'measured', reserve: 315n, faucetId: 'mm1native', scope: SCOPE })
  );
  rerender({ target: { ...TARGET } });

  expect(mockEstimate).toHaveBeenCalledTimes(1);
});

it('keeps the backend failure reason without forwarding backend error content', async () => {
  mockEstimate.mockResolvedValue(
    Object.assign({}, FAILED, { failure: 'dry_run_failed', message: 'private-account amount=123' })
  );
  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await waitFor(() => expect(result.current).toEqual({ status: 'failed', failure: 'dry_run_failed' }));
});

it('distinguishes request rejection from an estimate that failed', async () => {
  mockEstimate.mockRejectedValue(new Error('private-account amount=123'));
  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await waitFor(() => expect(result.current).toEqual({ status: 'failed', failure: 'request_failed' }));
  expect(mockEstimate).toHaveBeenCalledTimes(2);
});

it('identifies exhaustion of the existing three-answer busy budget', async () => {
  jest.useFakeTimers();
  mockEstimate.mockResolvedValue(BUSY);
  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await elapse(PAST_EVERY_BACKOFF_MS);
  expect(result.current).toEqual({ status: 'failed', failure: 'busy_exhausted' });
  expect(mockEstimate).toHaveBeenCalledTimes(3);
});

it('labels unknown legacy failure metadata without copying arbitrary values', async () => {
  mockEstimate.mockResolvedValue(Object.assign({}, FAILED, { failure: 'private-account amount=123' }));
  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await waitFor(() => expect(result.current).toEqual({ status: 'failed', failure: 'estimate_failed' }));
});

it('does not retain a failure reason after a successful retry', async () => {
  mockEstimate
    .mockResolvedValueOnce(Object.assign({}, FAILED, { failure: 'dry_run_failed' }))
    .mockResolvedValueOnce(measured(315n));
  const { result } = renderHook(() => useBurnFeeReserve(TARGET));
  await waitFor(() => expect(result.current.status).toBe('measured'));
  expect(result.current.reserve).toBe(315n);
  expect(Reflect.get(result.current, 'failure')).toBeUndefined();
});
