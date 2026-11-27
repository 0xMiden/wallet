import { act, renderHook } from '@testing-library/react';

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
});
