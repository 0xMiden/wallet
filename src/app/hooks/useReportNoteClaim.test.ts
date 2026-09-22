import { act, renderHook } from '@testing-library/react';

import { useReportNoteClaim } from './useReportNoteClaim';

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});
const classifyErrorMock = jest.fn((_error: unknown) => 'rpc');

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: (error: unknown) => classifyErrorMock(error)
}));

/** Throwing accessor so a missing handle names how many flows were begun. */
const handleAt = (index: number): TelemetryHandle => {
  const handle = telemetryHandles[index];
  if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${telemetryHandles.length})`);
  return handle;
};

/** Everything a test handed to telemetry, for the privacy assertions. */
const telemetryPayload = () =>
  JSON.stringify({
    begun: beginFlowMock.mock.calls,
    classified: classifyErrorMock.mock.calls,
    settled: telemetryHandles.map(handle => [
      handle.complete.mock.calls,
      handle.cancel.mock.calls,
      handle.fail.mock.calls
    ])
  });

describe('useReportNoteClaim', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    telemetryHandles.length = 0;
  });

  it('does not begin a flow until a claim is attempted', () => {
    renderHook(() => useReportNoteClaim());

    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('begins a note_handle flow per attempt and completes it on success', async () => {
    const { result } = renderHook(() => useReportNoteClaim());

    await act(async () => {
      await result.current(() => Promise.resolve('tx'));
    });

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('note_handle');
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('returns the attempt result unchanged', async () => {
    const { result } = renderHook(() => useReportNoteClaim());

    const value = await act(async () => result.current(() => Promise.resolve(42)));

    expect(value).toBe(42);
  });

  it('fails the flow with a classified kind and rethrows', async () => {
    const { result } = renderHook(() => useReportNoteClaim());

    const failure = new Error('rpc down');
    await act(async () => {
      await expect(result.current(() => Promise.reject(failure))).rejects.toThrow('rpc down');
    });

    expect(classifyErrorMock).toHaveBeenCalledWith(failure);
    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(0).complete).not.toHaveBeenCalled();
  });

  it('keeps a stable reporter across renders so consumers do not re-subscribe', () => {
    const { result, rerender } = renderHook(() => useReportNoteClaim());

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });

  it('cancels an attempt still in flight when the surface unmounts', async () => {
    const { result, unmount } = renderHook(() => useReportNoteClaim());

    let release = () => {};
    const pending = new Promise<string>(resolve => {
      release = () => resolve('tx');
    });
    let attempt: Promise<string> | null = null;
    await act(async () => {
      attempt = result.current(() => pending);
    });

    unmount();
    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await attempt;
    });
    expect(handleAt(0).complete).not.toHaveBeenCalled();
  });

  it('does not cancel attempts that already settled', async () => {
    const { result, unmount } = renderHook(() => useReportNoteClaim());

    await act(async () => {
      await result.current(() => Promise.resolve('tx'));
    });
    unmount();

    expect(handleAt(0).cancel).not.toHaveBeenCalled();
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('never passes the claim payload to telemetry', async () => {
    const { result } = renderHook(() => useReportNoteClaim());

    await act(async () => {
      await result.current(() => Promise.resolve({ noteId: '0xsecret-note', amount: '4200' }));
    });

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('0xsecret-note');
    expect(telemetryPayload()).not.toContain('4200');
  });
});
