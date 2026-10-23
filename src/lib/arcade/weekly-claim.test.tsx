import { act, renderHook, waitFor } from '@testing-library/react';

import { useWeeklyClaim } from './use-weekly-claim';
import {
  nextWeeklyBoundary,
  unavailableWeeklyClaimService,
  type WeeklyClaimReview,
  type WeeklyClaimService,
  type WeeklyClaimSnapshot
} from './weekly-claim';

const scope = { accountId: 'account', networkId: 'mainnet' };
const eligible: WeeklyClaimSnapshot = { status: { kind: 'eligible' }, balance: '50' };
const review: WeeklyClaimReview = {
  quoteId: 'quote-1',
  mode: 'claim',
  allocationWeekStart: '2026-10-19T00:00:00Z',
  expiresAt: '2099-10-25T23:59:59Z',
  nativeSymbol: 'MIDEN',
  requestFee: '0.001',
  issuerBudget: '0.002',
  receiptFeeBudget: '0.003'
};
const prepare = jest.fn(async () => review);

beforeEach(() => prepare.mockClear());

const claimed: WeeklyClaimSnapshot = {
  status: { kind: 'claimed', nextEligibleAt: '2026-10-26T00:00:00Z' },
  balance: '60'
};

it.each([
  ['2026-10-25T23:59:59Z', '2026-10-26T00:00:00.000Z'],
  ['2026-10-26T00:00:00Z', '2026-11-02T00:00:00.000Z'],
  ['2026-12-31T23:59:59Z', '2027-01-04T00:00:00.000Z']
])('displays the next UTC Monday after %s', (now, next) => {
  expect(nextWeeklyBoundary(new Date(now)).toISOString()).toBe(next);
});

it('leaves production claims unavailable with an unread balance', async () => {
  const { result } = renderHook(() => useWeeklyClaim(scope, unavailableWeeklyClaimService));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  expect(result.current.snapshot).toEqual({ status: { kind: 'unavailable' }, balance: null });
});
it('continues history checks automatically and allows an eligible claim without remounting', async () => {
  let checks = 0;
  const service: WeeklyClaimService = {
    read: async () => (++checks < 3 ? { status: { kind: 'checking' }, balance: '0' } : eligible),
    prepare,
    submit: async () => claimed
  };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.snapshot.status.kind).toBe('eligible'), { timeout: 5000 });
  await act(() => result.current.claim());
  expect(result.current.review).toEqual(review);
});
it('pauses automatic history reads while the owning page is hidden', async () => {
  let reads = 0;
  const service: WeeklyClaimService = {
    read: async () => {
      reads++;
      return { status: { kind: 'checking' }, balance: null };
    },
    prepare,
    submit: async () => claimed
  };
  const { result, rerender } = renderHook(({ active }) => useWeeklyClaim(scope, service, active), {
    initialProps: { active: true }
  });
  await waitFor(() => expect(result.current.busy).toBe(false));
  rerender({ active: false });
  const before = reads;
  await act(async () => new Promise(resolve => setTimeout(resolve, 350)));
  expect(reads).toBe(before);
});

it('blocks concurrent clicks, does not add an optimistic grant, and waits for receipt', async () => {
  let finish: (value: WeeklyClaimSnapshot) => void = () => {};
  const submit = jest.fn(
    () =>
      new Promise<WeeklyClaimSnapshot>(resolve => {
        finish = resolve;
      })
  );
  const service: WeeklyClaimService = { read: async () => eligible, prepare, submit };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.snapshot.status.kind).toBe('eligible'));
  act(() => {
    void result.current.claim();
    void result.current.claim();
  });
  await waitFor(() => expect(result.current.review).toEqual(review));
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  expect(result.current.review).toEqual(review);
  act(() => {
    void result.current.confirmReview();
    void result.current.confirmReview();
  });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith(scope, 'quote-1');
  expect(result.current.snapshot).toEqual({ status: { kind: 'pending' }, balance: '50' });
  await act(async () => finish(claimed));
  expect(result.current.snapshot).toEqual(claimed);
  await act(() => result.current.claim());
  expect(submit).toHaveBeenCalledTimes(1);
});

it('keeps a lost submission response pending until authoritative reconciliation', async () => {
  const read = jest.fn().mockResolvedValue(eligible);
  const submit = jest.fn().mockRejectedValue(new Error('timeout'));
  const service: WeeklyClaimService = { read, prepare, submit };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  await act(() => result.current.confirmReview());
  expect(result.current.snapshot.status.kind).toBe('pending');
  await act(() => result.current.claim());
  expect(submit).toHaveBeenCalledTimes(1);
  read.mockRejectedValueOnce(new Error('offline'));
  await act(() => result.current.refresh());
  expect(result.current.snapshot.status.kind).toBe('pending');
  read.mockResolvedValueOnce({ status: { kind: 'unavailable' }, balance: null });
  await act(() => result.current.refresh());
  expect(result.current.snapshot.status.kind).toBe('pending');
  read.mockResolvedValueOnce({ status: { kind: 'checking' }, balance: null });
  await act(() => result.current.refresh());
  expect(result.current.snapshot.status.kind).toBe('pending');
  read.mockResolvedValueOnce(eligible);
  await act(() => result.current.refresh());
  expect(result.current.snapshot.status.kind).toBe('pending');
  read.mockResolvedValueOnce(claimed);
  await act(() => result.current.refresh());
  expect(result.current.snapshot).toEqual(claimed);
});

it('permits retry only after a verified failure; reads pending state after remount', async () => {
  const submit = jest
    .fn()
    .mockResolvedValueOnce({ status: { kind: 'failed' }, balance: '50' })
    .mockResolvedValueOnce(claimed);
  const service: WeeklyClaimService = { read: async () => eligible, prepare, submit };
  const { result, unmount } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  await act(() => result.current.confirmReview());
  expect(result.current.snapshot.status.kind).toBe('failed');
  await act(() => result.current.claim());
  await act(() => result.current.confirmReview());
  expect(result.current.snapshot).toEqual(claimed);
  unmount();
  const recovering: WeeklyClaimService = {
    read: async () => ({ status: { kind: 'pending' }, balance: null }),
    prepare,
    submit
  };
  const recovered = renderHook(() => useWeeklyClaim(scope, recovering));
  await waitFor(() => expect(recovered.result.current.busy).toBe(false));
  await act(() => recovered.result.current.claim());
  expect(submit).toHaveBeenCalledTimes(2);
});

it('cancels a review without submitting or creating uncertainty', async () => {
  const submit = jest.fn();
  const service: WeeklyClaimService = { read: async () => eligible, prepare, submit };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  expect(result.current.review).toEqual(review);
  expect(result.current.snapshot).toEqual(eligible);
  act(() => result.current.cancelReview());
  expect(result.current.review).toBeNull();
  expect(result.current.snapshot).toEqual(eligible);
  expect(submit).not.toHaveBeenCalled();
  await act(() => result.current.claim());
  expect(prepare).toHaveBeenCalledTimes(2);
});

it('keeps preparation failures eligible and permits a new preparation', async () => {
  const service: WeeklyClaimService = {
    read: async () => eligible,
    prepare: jest.fn().mockRejectedValue(new Error('offline')),
    submit: jest.fn()
  };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  expect(result.current.snapshot).toEqual(eligible);
  expect(result.current.review).toBeNull();
  await act(() => result.current.claim());
  expect(service.prepare).toHaveBeenCalledTimes(2);
});

it('prepares reclaimable operations through the same explicit approval boundary', async () => {
  const reclaimReview: WeeklyClaimReview = { ...review, mode: 'reclaim' };
  const service: WeeklyClaimService = {
    read: async () => ({ status: { kind: 'reclaimable', reclaimHeight: 200 }, balance: '50' }),
    prepare: jest.fn(async () => reclaimReview),
    submit: jest.fn(async (): Promise<WeeklyClaimSnapshot> => ({ status: { kind: 'pending' }, balance: '50' }))
  };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  expect(result.current.review?.mode).toBe('reclaim');
  expect(service.submit).not.toHaveBeenCalled();
  await act(() => result.current.confirmReview());
  expect(service.submit).toHaveBeenCalledWith(scope, 'quote-1');
});

it('refuses an expired review without dispatch or false pending state', async () => {
  const service: WeeklyClaimService = {
    read: async () => eligible,
    prepare: async () => ({ ...review, expiresAt: '2000-01-01T00:00:00Z' }),
    submit: jest.fn()
  };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  await act(() => result.current.confirmReview());
  expect(service.submit).not.toHaveBeenCalled();
  expect(result.current.snapshot).toEqual(eligible);
  expect(result.current.review).toBeNull();
});

it('releases an uncertain Sunday request only for a different authoritative Monday allocation week', async () => {
  const read = jest.fn(
    async (): Promise<WeeklyClaimSnapshot> => ({ ...eligible, allocationWeekStart: '2026-10-19T00:00:00Z' })
  );
  const service: WeeklyClaimService = { read, prepare, submit: jest.fn().mockRejectedValue(new Error('lost reply')) };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  await act(() => result.current.confirmReview());
  read.mockResolvedValueOnce(eligible);
  await act(() => result.current.refresh());
  expect(result.current.snapshot.status.kind).toBe('pending');
  read.mockResolvedValueOnce({ ...eligible, allocationWeekStart: '2026-10-19T00:00:00Z' });
  await act(() => result.current.refresh());
  expect(result.current.snapshot.status.kind).toBe('pending');
  read.mockResolvedValueOnce({ ...eligible, allocationWeekStart: '2026-10-26T00:00:00Z' });
  await act(() => result.current.refresh());
  expect(result.current.snapshot.status.kind).toBe('eligible');
  service.prepare = jest.fn(async () => ({
    ...review,
    quoteId: 'monday-quote',
    allocationWeekStart: '2026-10-26T00:00:00Z'
  }));
  await act(() => result.current.claim());
  expect(result.current.review?.quoteId).toBe('monday-quote');
  expect(result.current.review?.allocationWeekStart).toBe('2026-10-26T00:00:00Z');
  expect(service.submit).toHaveBeenCalledTimes(1);
});

it('reports preparation failure without pretending a submission failed', async () => {
  const service: WeeklyClaimService = {
    read: async () => eligible,
    prepare: jest.fn().mockRejectedValue(new Error('secret internal detail')),
    submit: jest.fn()
  };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  expect(result.current.error).toBe('arcadeClaimPreparationFailed');
  expect(result.current.snapshot.status.kind).toBe('eligible');
  expect(service.submit).not.toHaveBeenCalled();
});

it('prepares an older recovery separately and keeps this week eligible after a lost recovery response', async () => {
  const monday: WeeklyClaimSnapshot = {
    ...eligible,
    allocationWeekStart: '2026-10-26T00:00:00Z',
    recoveries: [{ operationId: 'older', allocationWeekStart: '2026-10-19T00:00:00Z' }]
  };
  const prepareRecovery = jest.fn(async (): Promise<WeeklyClaimReview> => ({ ...review, mode: 'reclaim' }));
  const service: WeeklyClaimService = {
    read: async () => monday,
    prepare: prepareRecovery,
    submit: jest.fn().mockRejectedValue(new Error('lost reply'))
  };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.recover('older'));
  expect(prepareRecovery).toHaveBeenCalledWith(scope, 'older');
  expect(result.current.review?.mode).toBe('reclaim');
  await act(() => result.current.confirmReview());
  expect(result.current.snapshot.status.kind).toBe('eligible');
  expect(result.current.snapshot.recoveries).toEqual([]);
  await act(() => result.current.recover('older'));
  expect(prepareRecovery).toHaveBeenCalledTimes(1);
  await act(() => result.current.claim());
  expect(prepareRecovery).toHaveBeenCalledTimes(2);
  expect(service.submit).toHaveBeenCalledTimes(1);
});

it('reviews receipt acceptance after issuance without creating a new weekly funding request', async () => {
  const receiptReview: WeeklyClaimReview = { ...review, mode: 'receive', nativeRefund: '0.000091' };
  const service: WeeklyClaimService = {
    read: async () => ({ status: { kind: 'receivable' }, balance: '0' }),
    prepare: jest.fn(async () => receiptReview),
    submit: jest.fn(async () => claimed)
  };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  expect(result.current.review?.mode).toBe('receive');
  expect(service.submit).not.toHaveBeenCalled();
  await act(() => result.current.confirmReview());
  expect(result.current.snapshot.status.kind).toBe('claimed');
});
it('accepts an older receipt separately while preserving the current eligible allowance', async () => {
  const receiptReview: WeeklyClaimReview = { ...review, mode: 'receive', allocationWeekStart: '2026-10-12T00:00:00Z' };
  const available: WeeklyClaimSnapshot = {
    ...eligible,
    receipts: [{ operationId: 'old-receipt', allocationWeekStart: receiptReview.allocationWeekStart }]
  };
  const service: WeeklyClaimService = {
    read: async () => available,
    prepare: jest.fn(async () => receiptReview),
    submit: async () => ({ ...eligible, receipts: [] })
  };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.recover('old-receipt'));
  expect(result.current.review?.mode).toBe('receive');
  await act(() => result.current.confirmReview());
  expect(result.current.snapshot.status.kind).toBe('eligible');
  expect(result.current.snapshot.receipts).toEqual([]);
});

it('continues pending-operation checks after this week was claimed and stops when recovery is ready', async () => {
  jest.useFakeTimers();
  try {
    const read = jest
      .fn()
      .mockResolvedValueOnce({ ...claimed, pendingOperations: true })
      .mockResolvedValue({ status: { kind: 'reclaimable', reclaimHeight: 110 }, balance: '60' });
    const submit = jest.fn();
    const service: WeeklyClaimService = { read, prepare, submit };
    const { result, unmount } = renderHook(() => useWeeklyClaim(scope, service));
    await act(async () => undefined);
    expect(result.current.snapshot.status.kind).toBe('claimed');
    await act(async () => jest.advanceTimersByTime(5000));
    expect(result.current.snapshot.status.kind).toBe('reclaimable');
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTime(5000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    unmount();
  } finally {
    jest.useRealTimers();
  }
});

it.each(['unavailable', 'throw'])('retains the pending recovery watcher across a transient %s read', async failure => {
  jest.useFakeTimers();
  try {
    const read = jest.fn().mockResolvedValueOnce({ ...claimed, pendingOperations: true });
    if (failure === 'throw') read.mockRejectedValueOnce(new Error('offline'));
    else read.mockResolvedValueOnce({ status: { kind: 'unavailable' }, balance: null });
    read.mockResolvedValue({ status: { kind: 'reclaimable', reclaimHeight: 110 }, balance: '60' });
    const service: WeeklyClaimService = { read, prepare, submit: jest.fn() };
    const { result, unmount } = renderHook(() => useWeeklyClaim(scope, service));
    await act(async () => undefined);
    await act(async () => jest.advanceTimersByTime(5000));
    expect(result.current.snapshot).toMatchObject({
      status: { kind: 'unavailable' },
      balance: null,
      pendingOperations: true
    });
    await act(async () => jest.advanceTimersByTime(5000));
    expect(result.current.snapshot.status.kind).toBe('reclaimable');
    expect(result.current.snapshot.pendingOperations).toBeUndefined();
    unmount();
  } finally {
    jest.useRealTimers();
  }
});
