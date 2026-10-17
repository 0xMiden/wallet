import {
  __resetRelayDiagnosticsForTest,
  classifyRelayFailure,
  followRelay,
  noteConnectModalOpened,
  noteConnectivityChanged,
  recordRelaySurface,
  type RelayDiagnostics
} from './relay-diagnostics';

const RELAY_FAILURE = 'WebSocket connection failed for host: wss://relay.walletconnect.org';

function reported(message: string = RELAY_FAILURE): RelayDiagnostics | undefined {
  const failure = classifyRelayFailure(message);
  return failure?.report ? failure.diagnostics : undefined;
}

const restores: Array<() => void> = [];
function replace(target: object, key: string, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (own === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, own);
  });
}

beforeEach(() => __resetRelayDiagnosticsForTest());

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  jest.restoreAllMocks();
});

describe('which failures are the relay', () => {
  it.each([
    ['a value that is not text', 42],
    ['another failure', 'rpc endpoint returned status'],
    ['the text on another host', 'WebSocket connection failed for host: wss://relay.example.invalid'],
    [
      'a host that only starts with the relay',
      'WebSocket connection failed for host: wss://relay.walletconnect.org.example.invalid'
    ],
    ['the relay as a user name', 'WebSocket connection failed for host: wss://relay.walletconnect.org@example.invalid'],
    ['text that is not a URL', 'WebSocket connection failed for host: relay.walletconnect.org'],
    [
      'the text in the middle of another',
      'sync failed: WebSocket connection failed for host: wss://relay.walletconnect.org'
    ]
  ])('is not %s', (_label, message) => {
    expect(classifyRelayFailure(message)).toBeUndefined();
  });

  it.each(['relay.walletconnect.org', 'relay.walletconnect.com'])(
    'is the relay on %s, reported under its fixed text without the query',
    host => {
      const failure = classifyRelayFailure(
        `WebSocket connection failed for host: wss://${host}?projectId=${'ab'.repeat(16)}&auth=eyJhbGciOiJFZERTQSJ9.e30.c2ln`
      );
      expect(failure).toEqual({
        report: true,
        message: `WebSocket connection failed for host: wss://${host}`,
        diagnostics: {
          service: 'walletconnect_relay',
          connectivity: 'steady',
          visibility: 'visible',
          relayTrigger: 'session_restore',
          relayEverConnected: false,
          relayFailures: '1'
        }
      });
    }
  );
});

describe('how often it is reported', () => {
  it('reports the first, second and sixth failure of a window, and withholds the rest', () => {
    const verdicts = Array.from({ length: 8 }, () => reported()?.relayFailures);
    expect(verdicts).toEqual(['1', '2-5', undefined, undefined, undefined, '6+', undefined, undefined]);
  });

  it('counts a failure while offline without reporting it', () => {
    replace(navigator, 'onLine', false);
    expect(classifyRelayFailure(RELAY_FAILURE)).toEqual({ report: false });
    restores.pop()?.();
    expect(reported()?.relayFailures).toBe('2-5');
  });

  it('starts counting again after a reset, as a new page does', () => {
    reported();
    __resetRelayDiagnosticsForTest();
    expect(reported()?.relayFailures).toBe('1');
  });
});

describe('the context it carries', () => {
  it('reads a network change in the 30 seconds before as just changed, and an older one as steady', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    noteConnectivityChanged();
    now.mockReturnValue(1_030_000);
    expect(reported()?.connectivity).toBe('just_changed');
    now.mockReturnValue(1_030_001);
    expect(reported()?.connectivity).toBe('steady');
  });

  it('names a hidden window, and leaves out a visibility that is neither visible nor hidden', () => {
    replace(document, 'visibilityState', 'hidden');
    expect(reported()?.visibility).toBe('hidden');
    restores.pop()?.();
    replace(document, 'visibilityState', 'prerender');
    expect(reported()).not.toHaveProperty('visibility');
  });

  it('names the window it was recorded for, and nothing before that', () => {
    expect(reported()).not.toHaveProperty('surface');
    recordRelaySurface('sidepanel');
    expect(reported()?.surface).toBe('sidepanel');
  });

  it('says the connect modal was opened in this window once it was', () => {
    expect(reported()?.relayTrigger).toBe('session_restore');
    noteConnectModalOpened();
    expect(reported()?.relayTrigger).toBe('connect_modal');
  });

  it('says the relay connected once it was connected when followed, or connected later', () => {
    followRelay({ connected: false, on: jest.fn() });
    expect(reported()?.relayEverConnected).toBe(false);

    __resetRelayDiagnosticsForTest();
    followRelay({ connected: true, on: jest.fn() });
    expect(reported()?.relayEverConnected).toBe(true);

    __resetRelayDiagnosticsForTest();
    const on = jest.fn<void, [string, () => void]>();
    followRelay({ connected: false, on });
    expect(on.mock.calls.map(([event]) => event)).toEqual(['relayer_connect']);
    on.mock.calls[0]?.[1]?.();
    expect(reported()?.relayEverConnected).toBe(true);
  });
});
