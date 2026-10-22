import { act, renderHook, waitFor } from '@testing-library/react';

import { useWeeklyClaim } from './use-weekly-claim';
import {
  nextWeeklyBoundary,
  unavailableWeeklyClaimService,
  type WeeklyClaimService,
  type WeeklyClaimSnapshot
} from './weekly-claim';

const scope = { accountId: 'account', networkId: 'mainnet' };
const eligible: WeeklyClaimSnapshot = { status: { kind: 'eligible' }, balance: '50' };
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

it('blocks concurrent clicks, does not add an optimistic grant, and waits for receipt', async () => {
  let finish: (value: WeeklyClaimSnapshot) => void = () => {};
  const submit = jest.fn(
    () =>
      new Promise<WeeklyClaimSnapshot>(resolve => {
        finish = resolve;
      })
  );
  const service: WeeklyClaimService = { read: async () => eligible, submit };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.snapshot.status.kind).toBe('eligible'));
  act(() => {
    void result.current.claim();
    void result.current.claim();
  });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith(scope);
  expect(result.current.snapshot).toEqual({ status: { kind: 'pending' }, balance: '50' });
  await act(async () => finish(claimed));
  expect(result.current.snapshot).toEqual(claimed);
  await act(() => result.current.claim());
  expect(submit).toHaveBeenCalledTimes(1);
});

it('keeps a lost submission response pending until authoritative reconciliation', async () => {
  const read = jest.fn().mockResolvedValue(eligible);
  const submit = jest.fn().mockRejectedValue(new Error('timeout'));
  const service: WeeklyClaimService = { read, submit };
  const { result } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  expect(result.current.snapshot.status.kind).toBe('pending');
  await act(() => result.current.claim());
  expect(submit).toHaveBeenCalledTimes(1);
  read.mockRejectedValueOnce(new Error('offline'));
  await act(() => result.current.refresh());
  expect(result.current.snapshot.status.kind).toBe('pending');
  read.mockResolvedValueOnce({ status: { kind: 'unavailable' }, balance: null });
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
  const service: WeeklyClaimService = { read: async () => eligible, submit };
  const { result, unmount } = renderHook(() => useWeeklyClaim(scope, service));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(() => result.current.claim());
  expect(result.current.snapshot.status.kind).toBe('failed');
  await act(() => result.current.claim());
  expect(result.current.snapshot).toEqual(claimed);
  unmount();
  const recovering: WeeklyClaimService = { read: async () => ({ status: { kind: 'pending' }, balance: null }), submit };
  const recovered = renderHook(() => useWeeklyClaim(scope, recovering));
  await waitFor(() => expect(recovered.result.current.busy).toBe(false));
  await act(() => recovered.result.current.claim());
  expect(submit).toHaveBeenCalledTimes(2);
});
