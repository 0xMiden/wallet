import {
  beginSendSubmitting,
  enterSendFlow,
  hasOpenSendFlow,
  recordSendActionWithoutProgress,
  recordSendRetry,
  reportSendStep,
  settleSendFlow,
  transitionSendStep
} from './send-telemetry';

type Handle = {
  flowId: string;
  runId: string;
  complete: jest.Mock;
  cancel: jest.Mock;
  fail: jest.Mock;
  step: jest.Mock;
};

const RUN_ID = 'run-test-1234567890123';
const begun: Handle[] = [];
const emittedEvents: unknown[] = [];
const mockBeginFlow = jest.fn((_flow: string) => {
  const handle: Handle = {
    flowId: `flow-send-${begun.length + 1}`,
    runId: RUN_ID,
    complete: jest.fn(),
    cancel: jest.fn(),
    fail: jest.fn(),
    step: jest.fn()
  };
  begun.push(handle);
  return handle;
});

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => mockBeginFlow(flow)
}));
jest.mock('lib/telemetry/report-flow', () => ({
  reportTelemetryEvent: (event: unknown) => {
    emittedEvents.push(event);
  }
}));

/** Throwing accessor so a missing handle names how many flows were begun. */
function handleAt(index: number): Handle {
  const handle = begun[index];
  if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${begun.length})`);
  return handle;
}

beforeEach(() => {
  jest.clearAllMocks();
  begun.length = 0;
  emittedEvents.length = 0;
  // Module state survives between tests, exactly as it survives between routes.
  settleSendFlow(flow => flow.cancel());
  jest.clearAllMocks();
  begun.length = 0;
  emittedEvents.length = 0;
});

describe('send-telemetry', () => {
  it('begins one `send` flow on entry', () => {
    enterSendFlow();

    expect(mockBeginFlow).toHaveBeenCalledTimes(1);
    expect(mockBeginFlow).toHaveBeenCalledWith('send');
    expect(hasOpenSendFlow()).toBe(true);
  });

  it('adopts the open flow instead of beginning a second one', () => {
    enterSendFlow();
    enterSendFlow();
    enterSendFlow();

    expect(mockBeginFlow).toHaveBeenCalledTimes(1);
  });

  it('settles the open flow and clears it, so a later settle is a no-op', () => {
    enterSendFlow();

    settleSendFlow(flow => flow.complete());
    settleSendFlow(flow => flow.cancel());

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
    expect(hasOpenSendFlow()).toBe(false);
  });

  it('does nothing when there is no flow to settle', () => {
    const settle = jest.fn();

    settleSendFlow(settle);

    expect(settle).not.toHaveBeenCalled();
    expect(mockBeginFlow).not.toHaveBeenCalled();
  });

  it('begins a fresh flow after the previous one settled', () => {
    enterSendFlow();
    settleSendFlow(flow => flow.complete());

    enterSendFlow();
    settleSendFlow(flow => flow.fail('rpc'));

    expect(mockBeginFlow).toHaveBeenCalledTimes(2);
    expect(handleAt(1).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(0).fail).not.toHaveBeenCalled();
  });

  it('never passes anything but the flow name to telemetry', () => {
    enterSendFlow();

    expect(mockBeginFlow.mock.calls).toEqual([['send']]);
  });

  it('tracks ordered forward, back, submit, and retry progression sharing flowId across routes', () => {
    enterSendFlow();
    reportSendStep('select_recipient');
    transitionSendStep('continue', 'select_amount');
    reportSendStep('select_amount');
    transitionSendStep('back', 'select_recipient');
    transitionSendStep('continue', 'select_amount');
    transitionSendStep('continue');
    // Second route enters review under the same open attempt.
    reportSendStep('review');
    recordSendActionWithoutProgress();
    recordSendActionWithoutProgress();
    transitionSendStep('submit', 'submitting');
    transitionSendStep('continue');
    settleSendFlow(flow => flow.complete());

    expect(begun).toHaveLength(1);
    expect(emittedEvents).toMatchObject([
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-1',
        runId: RUN_ID,
        step: 'select_recipient',
        stepAction: 'continue',
        order: 1,
        complete: true
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-1',
        runId: RUN_ID,
        step: 'select_amount',
        stepAction: 'back',
        order: 2,
        complete: true
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-1',
        runId: RUN_ID,
        step: 'select_recipient',
        stepAction: 'continue',
        order: 3,
        complete: true
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-1',
        runId: RUN_ID,
        step: 'select_amount',
        stepAction: 'continue',
        order: 4,
        complete: true
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-1',
        runId: RUN_ID,
        step: 'review',
        stepAction: 'repeat',
        order: 5,
        complete: true
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-1',
        runId: RUN_ID,
        step: 'review',
        stepAction: 'submit',
        order: 6,
        complete: true
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-1',
        runId: RUN_ID,
        step: 'submitting',
        stepAction: 'continue',
        order: 7,
        complete: true
      }
    ]);
  });

  it('separates a cancelled attempt from a completed follow-up attempt while sharing runId', () => {
    enterSendFlow();
    reportSendStep('select_recipient');
    transitionSendStep('close');
    settleSendFlow(flow => flow.cancel());

    enterSendFlow();
    reportSendStep('select_recipient');
    transitionSendStep('continue', 'select_amount');
    settleSendFlow(flow => flow.complete());

    expect(begun).toHaveLength(2);
    expect(emittedEvents).toMatchObject([
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-1',
        runId: RUN_ID,
        step: 'select_recipient',
        stepAction: 'close',
        order: 1
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-2',
        runId: RUN_ID,
        step: 'select_recipient',
        stepAction: 'continue',
        order: 1
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-send-2',
        runId: RUN_ID,
        step: 'select_amount',
        stepAction: 'continue',
        order: 2
      }
    ]);
  });

  it('keeps the step tracker alive on review after failure, records post-error actions, and carries dwell into retry', () => {
    let clock = 1_000;
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      enterSendFlow();
      reportSendStep('review');
      clock += 200;
      beginSendSubmitting(false);
      clock += 100;
      settleSendFlow(flow => flow.fail('rpc'));

      // Handle settled as failed, while step tracker remains alive on `review`.
      expect(hasOpenSendFlow()).toBe(false);
      clock += 450;
      recordSendActionWithoutProgress();
      recordSendActionWithoutProgress();
      recordSendRetry();
      clock += 300;
      beginSendSubmitting(true);
      transitionSendStep('continue');
      settleSendFlow(flow => flow.complete());

      // Post-failure teardown without retry also finishes tracker cleanly without cancelling handle.
      enterSendFlow();
      beginSendSubmitting(false);
      settleSendFlow(flow => flow.fail('rpc'));
      clock += 120;
      settleSendFlow(flow => flow.cancel());

      expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
      expect(handleAt(0).cancel).not.toHaveBeenCalled();
      expect(handleAt(1).complete).toHaveBeenCalledTimes(1);
      expect(handleAt(2).fail).toHaveBeenCalledWith('rpc');
      expect(handleAt(2).cancel).not.toHaveBeenCalled();
      expect(emittedEvents).toMatchObject([
        { flowId: 'flow-send-1', step: 'review', stepAction: 'submit', order: 1, visibleMs: 200 },
        { flowId: 'flow-send-1', step: 'submitting', stepAction: 'leave', order: 2, visibleMs: 100 },
        { flowId: 'flow-send-1', step: 'review', stepAction: 'repeat', order: 3, visibleMs: 450 },
        { flowId: 'flow-send-1', step: 'review', stepAction: 'retry', order: 4, visibleMs: 450 },
        { flowId: 'flow-send-2', step: 'review', stepAction: 'retry', order: 1, visibleMs: 300 },
        { flowId: 'flow-send-2', step: 'submitting', stepAction: 'continue', order: 2 },
        { flowId: 'flow-send-3', step: 'review', stepAction: 'submit', order: 1 },
        { flowId: 'flow-send-3', step: 'submitting', stepAction: 'leave', order: 2 },
        { flowId: 'flow-send-3', step: 'review', stepAction: 'leave', order: 3, visibleMs: 120, complete: true }
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
