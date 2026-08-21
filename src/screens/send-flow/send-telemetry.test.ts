import { enterSendFlow, hasOpenSendFlow, settleSendFlow } from './send-telemetry';

type Handle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };

const begun: Handle[] = [];
const mockBeginFlow = jest.fn((_flow: string) => {
  const handle: Handle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  begun.push(handle);
  return handle;
});

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => mockBeginFlow(flow)
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
  // Module state survives between tests, exactly as it survives between routes.
  settleSendFlow(flow => flow.cancel());
  jest.clearAllMocks();
  begun.length = 0;
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
});
