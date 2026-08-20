import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { sendEvent, dropQueue, __setTransportForTest, __getQueueLengthForTest } from './sink';
import { TelemetryContext, TelemetryEvent, TelemetryWirePayload } from './types';

jest.mock('lib/settings/helpers', () => ({
  isTelemetryEnabledAsync: jest.fn()
}));

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

const context: TelemetryContext = { appVersion: '1.15.21', platform: 'extension' };
const started: TelemetryEvent = { phase: 'started', flow: 'send', flowId: 'f1' };

describe('telemetry sink', () => {
  let sent: TelemetryWirePayload[];
  const originalFetch = global.fetch;

  beforeEach(() => {
    sent = [];
    __setTransportForTest(async payload => {
      sent.push(payload);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __setTransportForTest(null);
    dropQueue();
    jest.resetAllMocks();
  });

  it('sends nothing when consent is off', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
    await sendEvent(started, context);
    expect(sent).toEqual([]);
  });

  it('sends nothing when consent has never been given', async () => {
    // Read-miss resolves false — a fresh install must be silent.
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
    await sendEvent(started, context);
    expect(sent).toEqual([]);
  });

  it('sends the serialized payload when consent is on', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    await sendEvent(started, context);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      phase: 'started',
      flow: 'send',
      flowId: 'f1',
      appVersion: '1.15.21',
      platform: 'extension'
    });
  });

  it('emits only allowlisted keys', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    await sendEvent(
      { phase: 'ended', flow: 'send', flowId: 'f1', result: 'errored', errorKind: 'network', durationMs: 5 },
      context
    );
    const [payload] = sent;
    expect(payload).toBeDefined();
    for (const key of Object.keys(payload ?? {})) {
      expect(['phase', 'flow', 'flowId', 'result', 'errorKind', 'durationMs', 'appVersion', 'platform']).toContain(key);
    }
  });

  it('POSTs the payload over fetch when no transport override is set', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    __setTransportForTest(null);
    const fetchMock = jest.fn().mockResolvedValue(undefined);
    global.fetch = fetchMock;
    await sendEvent(started, context);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    );
  });

  it('never throws when the transport fails', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    __setTransportForTest(async () => {
      throw new Error('network down');
    });
    await expect(sendEvent(started, context)).resolves.toBeUndefined();
  });

  it('drops the queue when consent is withdrawn', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    __setTransportForTest(() => new Promise(() => {}));
    void sendEvent(started, context);
    // `sendEvent` awaits the consent check before it pushes, so the push has
    // not landed yet at this point in the synchronous execution — flush
    // microtasks first, or this assertion runs against an empty queue and
    // passes whether or not `dropQueue` does anything at all.
    await flushMicrotasks();
    dropQueue();
    expect(__getQueueLengthForTest()).toBe(0);
  });

  it('bounds the queue so an offline device cannot grow it without limit', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    __setTransportForTest(() => new Promise(() => {}));
    for (let i = 0; i < 200; i++) {
      void sendEvent({ phase: 'started', flow: 'send', flowId: `f${i}` }, context);
    }
    // A single `Promise.resolve()` only flushes one microtask tick, before any
    // of the 200 awaited pushes have landed — the bound would hold trivially
    // against an empty queue. `setTimeout` flushes the macrotask queue too, so
    // every pending push has actually landed by the time we assert.
    await flushMicrotasks();
    expect(__getQueueLengthForTest()).toBeGreaterThan(0);
    expect(__getQueueLengthForTest()).toBeLessThanOrEqual(50);
  });
});
