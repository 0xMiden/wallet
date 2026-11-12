import { act, renderHook } from '@testing-library/react';

import type { ISubmitEvidence } from 'lib/miden/db/types';
import { GUARDIAN_PENDING_HOLD_SEC } from 'lib/miden/transaction/verdict-rules';

import { useGuardianHoldUntil } from './useGuardianHoldUntil';

const START_SEC = 1_800_000_000;

const keptEntry = (capturedAt: number): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt,
  source: 'stage',
  candidateKept: true
});

describe('useGuardianHoldUntil (#2060)', () => {
  let renders = 0;
  const render = (row: { submitEvidence?: ISubmitEvidence[] } | undefined) =>
    renderHook(
      ({ current }) => {
        renders += 1;
        return useGuardianHoldUntil(current);
      },
      { initialProps: { current: row } }
    );

  beforeEach(() => {
    renders = 0;
    jest.useFakeTimers();
    jest.setSystemTime(START_SEC * 1000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads no hold for a missing row or one the Guardian holds nothing for', () => {
    expect(render(undefined).result.current).toBeUndefined();
    expect(render({}).result.current).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reads the rule live from the row, so a release needs no wait', () => {
    const clearsAt = START_SEC - 60 + GUARDIAN_PENDING_HOLD_SEC;
    const { result, rerender } = render({ submitEvidence: [keptEntry(START_SEC - 60)] });
    expect(result.current).toBe(clearsAt);

    rerender({ current: { submitEvidence: [{ ...keptEntry(START_SEC - 60), candidateKept: undefined }] } });

    expect(result.current).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('re-renders for the end of the hold and for nothing before it', () => {
    const { result } = render({ submitEvidence: [keptEntry(START_SEC - GUARDIAN_PENDING_HOLD_SEC + 5)] });
    expect(result.current).toBe(START_SEC + 5);
    const before = renders;

    act(() => {
      jest.advanceTimersByTime(4_999);
    });
    expect(renders).toBe(before);
    expect(result.current).toBe(START_SEC + 5);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBeUndefined();
    expect(renders).toBe(before + 1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('follows a clock stepped back behind the capture, which the rule reads as no hold', () => {
    const { result } = render({ submitEvidence: [keptEntry(START_SEC - 60)] });
    expect(result.current).toBeDefined();

    jest.setSystemTime((START_SEC - 3_600) * 1000);
    act(() => {
      jest.advanceTimersByTime(1_000);
    });

    expect(result.current).toBeUndefined();
  });

  it('stops sampling when it unmounts', () => {
    const { unmount } = render({ submitEvidence: [keptEntry(START_SEC - 60)] });
    expect(jest.getTimerCount()).toBe(1);

    unmount();

    expect(jest.getTimerCount()).toBe(0);
  });
});
