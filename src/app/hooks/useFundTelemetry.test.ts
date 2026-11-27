import React, { useEffect } from 'react';

import { act, render, renderHook } from '@testing-library/react';

import { useFundFlow, useFundTelemetry } from './useFundTelemetry';

type TelemetryHandle = { flowId: string; runId: string; complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const RUN_ID = 'run-fund-1234567890123';
const telemetryHandles: TelemetryHandle[] = [];
const emittedSteps: unknown[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = {
    flowId: `flow-fund-${telemetryHandles.length + 1}`,
    runId: RUN_ID,
    complete: jest.fn(),
    cancel: jest.fn(),
    fail: jest.fn()
  };
  telemetryHandles.push(handle);
  return handle;
});
const classifyErrorMock = jest.fn((_error: unknown) => 'rpc');

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: (error: unknown) => classifyErrorMock(error)
}));
jest.mock('lib/telemetry/report-flow', () => ({
  reportTelemetryEvent: (event: unknown) => {
    emittedSteps.push(event);
  }
}));
jest.mock('lib/telemetry/run', () => ({
  touchRun: () => RUN_ID
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

describe('useFundTelemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    telemetryHandles.length = 0;
    emittedSteps.length = 0;
  });

  it('begins one fund flow on entry to the surface', () => {
    renderHook(() => useFundTelemetry());

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('fund');
  });

  it('does not begin another flow on re-render', () => {
    const { rerender } = renderHook(() => useFundTelemetry());

    rerender();
    rerender();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the flow when the user leaves without depositing', () => {
    const { unmount } = renderHook(() => useFundTelemetry());

    unmount();

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
    expect(handleAt(0).complete).not.toHaveBeenCalled();
  });

  it('completes the flow begun on entry rather than opening a second one', async () => {
    const { result } = renderHook(() => useFundTelemetry());

    await act(async () => {
      await result.current(() => Promise.resolve('bridge-tx'));
    });

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('returns the deposit result unchanged', async () => {
    const { result } = renderHook(() => useFundTelemetry());

    const value = await act(async () => result.current(() => Promise.resolve('bridge-tx')));

    expect(value).toBe('bridge-tx');
  });

  it('fails the flow with a classified kind and rethrows', async () => {
    const { result } = renderHook(() => useFundTelemetry());

    const failure = new Error('bridge row failed');
    await act(async () => {
      await expect(result.current(() => Promise.reject(failure))).rejects.toThrow('bridge row failed');
    });

    expect(classifyErrorMock).toHaveBeenCalledWith(failure);
    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
  });

  it('gives a retry after a failed deposit its own flow', async () => {
    const { result } = renderHook(() => useFundTelemetry());

    await act(async () => {
      await expect(result.current(() => Promise.reject(new Error('nope')))).rejects.toThrow();
    });
    await act(async () => {
      await result.current(() => Promise.resolve('bridge-tx'));
    });

    expect(beginFlowMock).toHaveBeenCalledTimes(2);
    expect(handleAt(1).complete).toHaveBeenCalledTimes(1);
  });

  it('does not re-report a settled deposit when the surface goes away', async () => {
    const { result, unmount } = renderHook(() => useFundTelemetry());

    await act(async () => {
      await result.current(() => Promise.resolve('bridge-tx'));
    });
    unmount();

    expect(handleAt(0).cancel).not.toHaveBeenCalled();
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('lets the leave win over a deposit that settles afterwards', async () => {
    const { result, unmount } = renderHook(() => useFundTelemetry());

    let release = () => {};
    const pending = new Promise<string>(resolve => {
      release = () => resolve('bridge-tx');
    });
    let attempt: Promise<string> | null = null;
    await act(async () => {
      attempt = result.current(() => pending);
    });

    unmount();
    await act(async () => {
      release();
      await attempt;
    });

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
    expect(handleAt(0).complete).not.toHaveBeenCalled();
  });

  it('never passes the deposit payload to telemetry', async () => {
    const { result } = renderHook(() => useFundTelemetry());

    await act(async () => {
      await result.current(() => Promise.resolve({ evmAddress: '0xdeadbeef', amount: '4200' }));
    });

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('0xdeadbeef');
    expect(telemetryPayload()).not.toContain('4200');
  });
});

describe('useFundFlow step progression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    telemetryHandles.length = 0;
    emittedSteps.length = 0;
  });

  it('tracks funding steps from wallet connect through submission and status close without leaking inputs', async () => {
    const { result, unmount } = renderHook(() => useFundFlow());

    act(() => {
      result.current.enterStep('connect_wallet');
      result.current.transitionStep('continue', 'select_amount');
      result.current.transitionStep('continue', 'select_route');
      result.current.transitionStep('back', 'select_amount');
      result.current.transitionStep('continue', 'select_route');
      result.current.transitionStep('continue', 'review');
      result.current.recordActionWithoutProgress();
      result.current.recordActionWithoutProgress();
    });

    await act(async () => {
      await result.current.reportDeposit(() => Promise.resolve({ evmAddress: '0xsecret', amount: '9999' }));
    });

    act(() => {
      result.current.enterStep('status');
      result.current.transitionStep('close');
    });
    unmount();

    expect(emittedSteps).toMatchObject([
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'connect_wallet',
        stepAction: 'continue',
        order: 1,
        complete: true
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'select_amount',
        stepAction: 'continue',
        order: 2,
        complete: true
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'select_route',
        stepAction: 'back',
        order: 3,
        complete: true
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'select_amount',
        stepAction: 'continue',
        order: 4,
        complete: true
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'select_route',
        stepAction: 'continue',
        order: 5,
        complete: true
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'review',
        stepAction: 'repeat',
        order: 6,
        complete: true
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'review',
        stepAction: 'submit',
        order: 7,
        complete: true
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'submitting',
        stepAction: 'continue',
        order: 8,
        complete: true
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'status',
        stepAction: 'close',
        order: 9,
        complete: true
      }
    ]);
    expect(JSON.stringify(emittedSteps)).not.toContain('0xsecret');
    expect(JSON.stringify(emittedSteps)).not.toContain('9999');
  });

  it('starts a new progression flow on retry after a failed deposit submission', async () => {
    const { result } = renderHook(() => useFundFlow());

    act(() => {
      result.current.enterStep('review');
    });

    await act(async () => {
      await expect(result.current.reportDeposit(() => Promise.reject(new Error('rejected')))).rejects.toThrow(
        'rejected'
      );
    });

    await act(async () => {
      await result.current.reportDeposit(() => Promise.resolve('bridge-tx-2'));
    });

    expect(emittedSteps).toMatchObject([
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'review',
        stepAction: 'submit',
        order: 1
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'submitting',
        stepAction: 'leave',
        order: 2
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-2',
        runId: RUN_ID,
        step: 'review',
        stepAction: 'retry',
        order: 1
      },
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-2',
        runId: RUN_ID,
        step: 'submitting',
        stepAction: 'continue',
        order: 2
      }
    ]);
  });

  it('keeps tracker alive on review after failure, records post-error events, and carries dwell to retry', async () => {
    let clock = 500;
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const { result, unmount } = renderHook(() => useFundFlow());
      act(() => {
        result.current.enterStep('review');
        clock += 200;
      });

      await act(async () => {
        await expect(result.current.reportDeposit(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
      });

      act(() => {
        clock += 400;
        result.current.recordActionWithoutProgress();
        result.current.recordActionWithoutProgress();
        result.current.recordRetry();
        clock += 250;
      });

      await act(async () => {
        await result.current.reportDeposit(() => Promise.resolve('bridge-tx-ok'));
      });
      expect(emittedSteps).toMatchObject([
        { flowId: 'flow-fund-1', step: 'review', stepAction: 'submit', order: 1, visibleMs: 200 },
        { flowId: 'flow-fund-1', step: 'submitting', stepAction: 'leave', order: 2 },
        { flowId: 'flow-fund-1', step: 'review', stepAction: 'repeat', order: 3, visibleMs: 400 },
        { flowId: 'flow-fund-1', step: 'review', stepAction: 'retry', order: 4, visibleMs: 400 },
        { flowId: 'flow-fund-2', step: 'review', stepAction: 'retry', order: 1, visibleMs: 250 },
        { flowId: 'flow-fund-2', step: 'submitting', stepAction: 'continue', order: 2 }
      ]);

      // Post-failure close/unmount without retry also emits review exit without calling cancel on failed handle.
      emittedSteps.length = 0;
      const { result: second, unmount: unmountSecond } = renderHook(() => useFundFlow());
      act(() => {
        second.current.enterStep('review');
      });
      await act(async () => {
        await expect(second.current.reportDeposit(() => Promise.reject(new Error('fail-2')))).rejects.toThrow('fail-2');
      });
      act(() => {
        clock += 150;
      });
      unmountSecond();
      unmount();

      expect(handleAt(2).fail).toHaveBeenCalledWith('rpc');
      expect(handleAt(2).cancel).not.toHaveBeenCalled();
      expect(emittedSteps).toMatchObject([
        { flowId: 'flow-fund-3', step: 'review', stepAction: 'submit', order: 1 },
        { flowId: 'flow-fund-3', step: 'submitting', stepAction: 'leave', order: 2 },
        { flowId: 'flow-fund-3', step: 'review', stepAction: 'leave', order: 3, visibleMs: 150, complete: true }
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not misclassify the first deposit as a retry when beginFlow returned undefined on mount', async () => {
    beginFlowMock.mockReturnValueOnce(undefined as any);
    const { result } = renderHook(() => useFundFlow());

    await act(async () => {
      await result.current.reportDeposit(() => Promise.resolve('bridge-tx'));
    });

    expect(emittedSteps).toMatchObject([
      { flowId: 'flow-fund-1', step: 'review', stepAction: 'submit', order: 1 },
      { flowId: 'flow-fund-1', step: 'submitting', stepAction: 'continue', order: 2 }
    ]);
  });

  it('consumes a child enterStep registered before mount effect runs and ignores overwriting active parent steps', () => {
    function Child({ onEnter }: { onEnter: (step: 'select_route') => void }) {
      useEffect(() => {
        onEnter('select_route');
      }, [onEnter]);
      return null;
    }

    function Parent() {
      const fundFlow = useFundFlow();
      useEffect(() => {
        fundFlow.enterStep('select_amount');
      }, [fundFlow]);
      return React.createElement(Child, { onEnter: fundFlow.enterStep });
    }

    const { unmount } = render(React.createElement(Parent));
    unmount();

    expect(emittedSteps).toEqual([
      expect.objectContaining({
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-fund-1',
        runId: RUN_ID,
        step: 'select_route',
        stepAction: 'leave',
        order: 1,
        complete: true
      })
    ]);
  });

  it('closes failed flow on backtrack, resets retry state, opens fresh flow, and disposes non-review trackers cleanly', async () => {
    const { result, unmount } = renderHook(() => useFundFlow());
    act(() => {
      result.current.enterStep('review');
    });

    await act(async () => {
      await expect(result.current.reportDeposit(() => Promise.reject(new Error('rpc fail')))).rejects.toThrow(
        'rpc fail'
      );
    });

    // Stepping back from failed Review closes flow-fund-1 and opens flow-fund-2 at select_route.
    act(() => {
      result.current.transitionStep('back', 'select_route');
      result.current.transitionStep('continue', 'review');
    });

    await act(async () => {
      await result.current.reportDeposit(() => Promise.resolve('bridge-ok'));
    });

    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(1).complete).toHaveBeenCalledTimes(1);
    expect(emittedSteps).toMatchObject([
      { flowId: 'flow-fund-1', step: 'review', stepAction: 'submit', order: 1 },
      { flowId: 'flow-fund-1', step: 'submitting', stepAction: 'leave', order: 2 },
      { flowId: 'flow-fund-1', step: 'review', stepAction: 'back', order: 3, complete: true },
      { flowId: 'flow-fund-2', step: 'select_route', stepAction: 'continue', order: 1, complete: true },
      { flowId: 'flow-fund-2', step: 'review', stepAction: 'submit', order: 2, complete: true },
      { flowId: 'flow-fund-2', step: 'submitting', stepAction: 'continue', order: 3, complete: true }
    ]);

    // Closing directly on a failed Review emits close on the failed flow without starting a fresh flow.
    emittedSteps.length = 0;
    const second = renderHook(() => useFundFlow());
    act(() => {
      second.result.current.enterStep('review');
    });
    await act(async () => {
      await expect(second.result.current.reportDeposit(() => Promise.reject(new Error('nope')))).rejects.toThrow(
        'nope'
      );
    });
    act(() => {
      second.result.current.transitionStep('close');
    });
    second.unmount();

    expect(beginFlowMock).toHaveBeenCalledTimes(3);
    expect(handleAt(2).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(2).cancel).not.toHaveBeenCalled();
    expect(emittedSteps).toMatchObject([
      { flowId: 'flow-fund-3', step: 'review', stepAction: 'submit', order: 1 },
      { flowId: 'flow-fund-3', step: 'submitting', stepAction: 'leave', order: 2 },
      { flowId: 'flow-fund-3', step: 'review', stepAction: 'close', order: 3, complete: true }
    ]);
    unmount();
  });

  it('ignores late reportDeposit settlement after transitionStep back without corrupting steps, flow outcome, or retry state', async () => {
    const first = renderHook(() => useFundFlow());
    act(() => {
      first.result.current.enterStep('review');
    });

    let resolveDeposit!: (value: string) => void;
    const pendingSuccess = new Promise<string>(resolve => {
      resolveDeposit = resolve;
    });
    let lateResolvePromise!: Promise<string>;
    act(() => {
      lateResolvePromise = first.result.current.reportDeposit(() => pendingSuccess);
      first.result.current.transitionStep('back', 'select_route');
    });

    const eventsBeforeLateResolve = emittedSteps.length;
    await act(async () => {
      resolveDeposit('late-bridge-tx');
      await expect(lateResolvePromise).resolves.toBe('late-bridge-tx');
    });

    expect(handleAt(0).complete).not.toHaveBeenCalled();
    expect(emittedSteps.length).toBe(eventsBeforeLateResolve);

    act(() => {
      first.result.current.transitionStep('continue', 'review');
    });
    await act(async () => {
      await first.result.current.reportDeposit(() => Promise.resolve('fresh-bridge-tx'));
    });

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(emittedSteps).toMatchObject([
      { flowId: 'flow-fund-1', step: 'review', stepAction: 'submit', order: 1 },
      { flowId: 'flow-fund-1', step: 'submitting', stepAction: 'back', order: 2 },
      { flowId: 'flow-fund-1', step: 'select_route', stepAction: 'continue', order: 3 },
      { flowId: 'flow-fund-1', step: 'review', stepAction: 'submit', order: 4 },
      { flowId: 'flow-fund-1', step: 'submitting', stepAction: 'continue', order: 5, complete: true }
    ]);
    first.unmount();

    emittedSteps.length = 0;
    const second = renderHook(() => useFundFlow());
    act(() => {
      second.result.current.enterStep('review');
    });

    let rejectDeposit!: (reason?: unknown) => void;
    const pendingFailure = new Promise<string>((_resolve, reject) => {
      rejectDeposit = reject;
    });
    let lateRejectPromise!: Promise<string>;
    act(() => {
      lateRejectPromise = second.result.current.reportDeposit(() => pendingFailure);
      second.result.current.transitionStep('back', 'select_route');
    });

    const eventsBeforeLateReject = emittedSteps.length;
    await act(async () => {
      rejectDeposit(new Error('late rpc fail'));
      await expect(lateRejectPromise).rejects.toThrow('late rpc fail');
    });

    expect(handleAt(1).fail).not.toHaveBeenCalled();
    expect(emittedSteps.length).toBe(eventsBeforeLateReject);

    act(() => {
      second.result.current.transitionStep('continue', 'review');
    });
    await act(async () => {
      await second.result.current.reportDeposit(() => Promise.resolve('recovered-ok'));
    });

    expect(handleAt(1).complete).toHaveBeenCalledTimes(1);
    expect(emittedSteps).toMatchObject([
      { flowId: 'flow-fund-2', step: 'review', stepAction: 'submit', order: 1 },
      { flowId: 'flow-fund-2', step: 'submitting', stepAction: 'back', order: 2 },
      { flowId: 'flow-fund-2', step: 'select_route', stepAction: 'continue', order: 3 },
      { flowId: 'flow-fund-2', step: 'review', stepAction: 'submit', order: 4 },
      { flowId: 'flow-fund-2', step: 'submitting', stepAction: 'continue', order: 5, complete: true }
    ]);
    second.unmount();
  });
});
