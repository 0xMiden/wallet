import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { sendEvent, dropQueue, __setTransportForTest, __getQueueLengthForTest } from './sink';
import { TelemetryContext, TelemetryEvent, TelemetryWirePayload } from './types';

jest.mock('lib/settings/helpers', () => ({
  isTelemetryEnabledAsync: jest.fn()
}));

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

const context: TelemetryContext = { appVersion: '1.15.21', platform: 'extension' };
const started: TelemetryEvent = { phase: 'started', flow: 'send', flowId: 'f1', runId: 'r1' };

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
      runId: 'r1',
      appVersion: '1.15.21',
      platform: 'extension'
    });
  });

  it('emits only allowlisted keys', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    await sendEvent(
      {
        phase: 'ended',
        flow: 'send',
        flowId: 'f1',
        runId: 'r1',
        result: 'errored',
        errorKind: 'network',
        durationMs: 5
      },
      context
    );
    const [payload] = sent;
    expect(payload).toBeDefined();
    for (const key of Object.keys(payload ?? {})) {
      expect([
        'phase',
        'flow',
        'flowId',
        'runId',
        'result',
        'errorKind',
        'durationMs',
        'appVersion',
        'platform'
      ]).toContain(key);
    }
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
      void sendEvent({ phase: 'started', flow: 'send', flowId: `f${i}`, runId: 'r1' }, context);
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

describe('the real Aptabase transport', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.APTABASE_APP_KEY;
  const originalHost = process.env.APTABASE_HOST;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    __setTransportForTest(null);
    fetchMock = jest.fn().mockResolvedValue(undefined);
    global.fetch = fetchMock;
    process.env.APTABASE_APP_KEY = 'A-EU-1234567890';
    delete process.env.APTABASE_HOST;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.APTABASE_APP_KEY = originalKey;
    process.env.APTABASE_HOST = originalHost;
    if (originalKey === undefined) delete process.env.APTABASE_APP_KEY;
    if (originalHost === undefined) delete process.env.APTABASE_HOST;
    dropQueue();
    jest.resetAllMocks();
  });

  /** The single argument pair `fetch` was called with, or a loud failure. */
  function onlyRequest(): { url: unknown; init: Record<string, unknown> } {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call: unknown[] = fetchMock.mock.calls[0] ?? [];
    const init: unknown = call[1];
    if (typeof init !== 'object' || init === null) throw new Error('fetch was called without an init object');
    const entries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(init)) entries[key] = value;
    return { url: call[0], init: entries };
  }

  function sentEnvelope(): Record<string, unknown> {
    const { init } = onlyRequest();
    const body: unknown = init.body;
    if (typeof body !== 'string') throw new Error('fetch was called with a non-string body');
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`the request body is not a JSON object: ${body}`);
    }
    const envelope: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) envelope[key] = value;
    return envelope;
  }

  it('POSTs one event to the region derived from the app key', async () => {
    await sendEvent(started, context);
    const { url, init } = onlyRequest();
    expect(url).toBe('https://eu.aptabase.com/api/v0/event');
    expect(init.method).toBe('POST');
  });

  it('sends the App-Key header Aptabase authenticates on', async () => {
    await sendEvent(started, context);
    expect(onlyRequest().init.headers).toEqual({
      'Content-Type': 'application/json',
      'App-Key': 'A-EU-1234567890'
    });
  });

  it('omits credentials, so no cookie can turn a stateless POST into an identifier', async () => {
    await sendEvent(started, context);
    expect(onlyRequest().init.credentials).toBe('omit');
  });

  it('sends the Aptabase envelope as the body, not the internal payload', async () => {
    await sendEvent(started, context);
    const envelope = sentEnvelope();
    expect(envelope.eventName).toBe('send_started');
    expect(envelope.sessionId).toBe('r1');
    expect(envelope.systemProps).toEqual({
      isDebug: true,
      osName: 'extension',
      appVersion: '1.15.21',
      sdkVersion: 'miden-wallet-aptabase@1.0.0'
    });
    expect(envelope.props).toEqual({ flowId: 'f1' });
    expect(Object.keys(envelope).sort()).toEqual(['eventName', 'props', 'sessionId', 'systemProps', 'timestamp']);
  });

  it('posts to the self-hosted host when one is configured', async () => {
    process.env.APTABASE_APP_KEY = 'A-SH-1234567890';
    process.env.APTABASE_HOST = 'https://analytics.example.org';
    await sendEvent(started, context);
    expect(onlyRequest().url).toBe('https://analytics.example.org/api/v0/event');
  });

  it.each([
    ['the app key is unset', undefined, undefined],
    ['the app key is empty', '', undefined],
    ['the app key is malformed', 'not-a-key', undefined],
    ['a self-hosted key has no host', 'A-SH-1234567890', undefined],
    ['a self-hosted key has an unusable host', 'A-SH-1234567890', 'not-a-url']
  ])('sends nothing, and does not throw, when %s', async (_label, appKey, host) => {
    if (appKey === undefined) delete process.env.APTABASE_APP_KEY;
    else process.env.APTABASE_APP_KEY = appKey;
    if (host === undefined) delete process.env.APTABASE_HOST;
    else process.env.APTABASE_HOST = host;

    await expect(sendEvent(started, context)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still sends nothing when consent is off, however well configured it is', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
    await sendEvent(started, context);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
