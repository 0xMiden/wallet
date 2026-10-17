import {
  __resetRelayDiagnosticsForTest,
  claimRelayRange,
  classifyRelayFailure,
  followRelay,
  noteConnectModalOpen,
  noteConnectivityChanged,
  recordRelaySurface,
  type RelayDiagnostics,
  type RelayFailure
} from './relay-diagnostics';

const RELAY_FAILURE = 'WebSocket connection failed for host: wss://relay.walletconnect.org';

/** An Error whose `message` is `message`, even one that is not text, as a hostile error's can be. */
function relayError(message: unknown = RELAY_FAILURE): Error {
  return Object.defineProperty(new Error(), 'message', { value: message });
}

/** Classifies `failure` under the text it carries, as its capture does. */
function classify(failure: Error): RelayFailure | undefined {
  return classifyRelayFailure(failure, failure.message);
}

/** Classifies `failure` and, as a report that is sent does, uses up its range. */
function reported(failure: Error = relayError()): RelayDiagnostics | undefined {
  const verdict = classify(failure);
  return verdict?.report && claimRelayRange(verdict.diagnostics.relayFailures) ? verdict.diagnostics : undefined;
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
    expect(classify(relayError(message))).toBeUndefined();
  });

  it.each(['relay.walletconnect.org', 'relay.walletconnect.com'])(
    'is the relay on %s, reported under its fixed text without the query',
    host => {
      const failure = classify(
        relayError(
          `WebSocket connection failed for host: wss://${host}?projectId=${'ab'.repeat(16)}&auth=eyJhbGciOiJFZERTQSJ9.e30.c2ln`
        )
      );
      expect(failure).toEqual({
        report: true,
        message: `WebSocket connection failed for host: wss://${host}`,
        diagnostics: {
          service: 'walletconnect_relay',
          connectivity: 'steady',
          visibility: 'visible',
          relayTrigger: 'no_connect_modal',
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
    expect(classify(relayError())).toEqual({ report: false });
    restores.pop()?.();
    expect(reported()?.relayFailures).toBe('2-5');
  });

  it('reports the range a window reached offline at its first online failure: six offline, then one online', () => {
    replace(navigator, 'onLine', false);
    expect(Array.from({ length: 6 }, () => classify(relayError()))).toEqual(
      Array.from({ length: 6 }, () => ({ report: false }))
    );
    restores.pop()?.();
    expect(reported()?.relayFailures).toBe('6+');
  });

  it('reports a range an offline failure entered at its next online failure: 1 online, 2 offline, 3 online', () => {
    const verdicts = [reported()?.relayFailures];
    replace(navigator, 'onLine', false);
    verdicts.push(reported()?.relayFailures);
    restores.pop()?.();
    verdicts.push(reported()?.relayFailures);
    expect(verdicts).toEqual(['1', undefined, '2-5']);
  });

  it('uses a range up only when it is claimed, so a failure whose report was dropped leaves it to the next', () => {
    expect(reported()?.relayFailures).toBe('1');
    const dropped = classify(relayError());
    expect(dropped?.report && dropped.diagnostics.relayFailures).toBe('2-5');
    expect(reported()?.relayFailures).toBe('2-5');
  });

  it('claims each range once, and never a range below one already claimed', () => {
    const ranges: RelayDiagnostics['relayFailures'][] = ['2-5', '2-5', '6+', '1', '2-5', '6+'];
    expect(ranges.map(range => claimRelayRange(range))).toEqual([true, false, true, false, false, false]);
  });

  it('reports one of two failures of one range classified before either is sent', () => {
    reported();
    const together = [classify(relayError()), classify(relayError())];
    expect(together.map(failure => failure?.report && claimRelayRange(failure.diagnostics.relayFailures))).toEqual([
      true,
      false
    ]);
  });

  it('starts counting again after a reset, as a new page does', () => {
    reported();
    __resetRelayDiagnosticsForTest();
    expect(reported()?.relayFailures).toBe('1');
  });
});

describe('what counts as one failure', () => {
  it('counts an Error once however often it is classified, and a new Error with the same text as the next', () => {
    const failure = relayError();
    expect(reported(failure)?.relayFailures).toBe('1');
    expect(Array.from({ length: 5 }, () => classify(failure))).toEqual(
      Array.from({ length: 5 }, () => ({ report: false }))
    );
    expect(reported()?.relayFailures).toBe('2-5');
  });

  it('withholds a repeat of an Error whose report was dropped, without counting it again', () => {
    const failure = relayError();
    expect(classify(failure)?.report).toBe(true);
    expect(classify(failure)).toEqual({ report: false });
    expect(reported()?.relayFailures).toBe('2-5');
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

  it.each([
    ['it never opened', [], 'no_connect_modal'],
    ['it is open', [true], 'connect_modal'],
    ['it opened and closed', [true, false], 'no_connect_modal'],
    ['it opened again', [true, false, true], 'connect_modal']
  ])('says whether the connect modal is open when the relay fails: %s', (_label, states, trigger) => {
    for (const open of states) noteConnectModalOpen(open);
    expect(reported()?.relayTrigger).toBe(trigger);
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
