import { reportNoteClaim } from './claim-telemetry';

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

describe('reportNoteClaim', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    telemetryHandles.length = 0;
  });

  it('begins a note_handle flow per attempt and completes it on success', async () => {
    await reportNoteClaim(() => Promise.resolve('tx'));

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('note_handle');
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('returns the attempt result unchanged', async () => {
    await expect(reportNoteClaim(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it('fails the flow with a classified kind and rethrows', async () => {
    const failure = new Error('rpc down');

    await expect(reportNoteClaim(() => Promise.reject(failure))).rejects.toThrow('rpc down');

    expect(classifyErrorMock).toHaveBeenCalledWith(failure);
    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('never passes the claim payload to telemetry', async () => {
    await reportNoteClaim(() => Promise.resolve({ noteId: '0xsecret-note', amount: '4200' }));

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('0xsecret-note');
    expect(telemetryPayload()).not.toContain('4200');
  });
});
