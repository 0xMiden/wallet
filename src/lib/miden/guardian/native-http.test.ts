/**
 * The Guardian fetch boundary. On mobile it routes a Guardian's origin through CapacitorHttp and every other request
 * through the WebView's own fetch; off mobile a Guardian request keeps the original fetch. Two rules keep binary
 * traffic off CapacitorHttp: an origin the app itself fetches from never routes, judged per request, and an origin
 * only probed routes while its probe is in flight. On every platform a routed request is cut off at
 * GUARDIAN_REQUEST_TIMEOUT_MS (#312).
 */
import { isGuardianRequestTimeout } from './serialize';

const mockIsMobile = jest.fn(() => true);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

const mockNativeRequest = jest.fn();
jest.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: (...args: unknown[]) => mockNativeRequest(...args) }
}));

jest.mock('lib/miden-chain/constants', () => ({
  GUARDIAN_OPTIONS: [{ endpoint: new Map([['testnet', 'https://builtin.guardian.test']]) }]
}));

let mockRpcUrl = 'https://rpc.test';
let mockProverUrl: string | undefined = 'https://prover.test';
let mockNoteTransportUrl: string | undefined = 'https://transport.test';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => mockRpcUrl,
  getEffectiveProverUrl: () => mockProverUrl,
  getEffectiveNoteTransportUrl: () => mockNoteTransportUrl
}));

// jsdom has no fetch classes: the interceptor needs `Request` for an instanceof check and a Request input's url and
// signal, and `Response` to wrap a native answer.
class FakeRequest {
  readonly signal: AbortSignal | undefined;
  constructor(
    readonly url: string,
    init?: { signal?: AbortSignal | null }
  ) {
    this.signal = init?.signal ?? undefined;
  }
}
class FakeResponse {
  constructor(
    readonly body: unknown,
    readonly init: { status: number; statusText?: string; headers?: unknown }
  ) {}
}
Object.assign(globalThis, { Request: FakeRequest, Response: FakeResponse });

const BUILTIN = 'https://builtin.guardian.test';
const CUSTOM = 'https://custom.guardian.test';

// `installed` and both origin sets are module state, so every test loads a fresh copy.
function loadNativeHttp(): typeof import('./native-http') {
  let mod!: typeof import('./native-http');
  jest.isolateModules(() => {
    mod = require('./native-http');
  });
  return mod;
}

const mockWebFetch = jest.fn();
let nativeHttp: typeof import('./native-http');

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMobile.mockReturnValue(true);
  mockRpcUrl = 'https://rpc.test';
  mockProverUrl = 'https://prover.test';
  mockNoteTransportUrl = 'https://transport.test';
  mockWebFetch.mockResolvedValue('web answer');
  mockNativeRequest.mockResolvedValue({ status: 200, headers: {}, data: '{}' });
  globalThis.fetch = mockWebFetch;
  nativeHttp = loadNativeHttp();
  nativeHttp.installGuardianFetchBoundary();
});

/** Which transport a GET to `url` took through the installed interceptor. */
async function transportFor(url: string): Promise<'native' | 'web'> {
  mockNativeRequest.mockClear();
  mockWebFetch.mockClear();
  await globalThis.fetch(url);
  if (mockNativeRequest.mock.calls.length === 1 && mockWebFetch.mock.calls.length === 0) return 'native';
  if (mockWebFetch.mock.calls.length === 1 && mockNativeRequest.mock.calls.length === 0) return 'web';
  throw new Error(`${url} took no single transport`);
}

/** Load a fresh copy as the extension or desktop would: the boundary installs, but never routes through native HTTP. */
function loadOffMobile(): typeof import('./native-http') {
  mockIsMobile.mockReturnValue(false);
  globalThis.fetch = mockWebFetch;
  return loadNativeHttp();
}

/** What the original fetch hands back for a routed request off mobile. */
const webResponse = (status: number, body: string) => ({
  status,
  statusText: status === 200 ? 'OK' : 'No Content',
  headers: { 'content-type': 'application/json' },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer
});

/** Whether `promise` settled, and with what error, without leaving its rejection unhandled. */
function track(promise: Promise<unknown>): { settled: boolean; error: unknown } {
  const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    }
  );
  return state;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('installGuardianFetchBoundary', () => {
  it.each([
    ['node RPC', 'https://rpc.test'],
    ['prover', 'https://prover.test'],
    ['note transport', 'https://transport.test'],
    ['page', globalThis.location.origin]
  ])('never sends the %s origin through native HTTP, even when registered as a Guardian', async (_name, origin) => {
    nativeHttp.registerGuardianOrigin(origin);

    expect(await transportFor(`${origin}/rpc.Api/SyncState`)).toBe('web');
  });

  it('honours an endpoint override saved after the origin was registered, from the next request', async () => {
    nativeHttp.registerGuardianOrigin(CUSTOM);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');

    mockRpcUrl = CUSTOM;

    expect(await transportFor(`${CUSTOM}/rpc.Api/SyncState`)).toBe('web');
  });

  it('keeps routing Guardians on a network with no prover or note transport configured', async () => {
    mockProverUrl = undefined;
    mockNoteTransportUrl = undefined;
    nativeHttp.registerGuardianOrigin(CUSTOM);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('treats a URL with a path, trailing slash, host capitals or default port as the RPC origin', async () => {
    mockRpcUrl = 'https://rpc.test/v1/';
    nativeHttp.registerGuardianOrigin('https://RPC.test:443/guardian/');

    expect(await transportFor('https://rpc.test/rpc.Api/SyncState')).toBe('web');
  });

  it('never routes the page origin, even once a probe of it settles as a Guardian', async () => {
    nativeHttp.probeGuardianOrigin(`${globalThis.location.origin}/`)(true);

    expect(await transportFor(`${globalThis.location.origin}/assets/app.wasm`)).toBe('web');
  });

  it('never routes a non-http origin such as capacitor://localhost, the iOS WebView page', async () => {
    nativeHttp.registerGuardianOrigin('capacitor://localhost');
    nativeHttp.probeGuardianOrigin('capacitor://localhost')(true);

    expect(await transportFor('capacitor://localhost/assets/app.wasm')).toBe('web');
  });
});

describe('probeGuardianOrigin', () => {
  it('routes a probed origin while the probe is in flight and releases it on false', async () => {
    const settle = nativeHttp.probeGuardianOrigin(`${CUSTOM}/`);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');

    settle(false);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });

  it('keeps a probed origin routed for the session once the probe settles true', async () => {
    nativeHttp.probeGuardianOrigin(CUSTOM)(true);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('keeps an origin routed until the last overlapping probe of it lets go', async () => {
    const pickerCheck = nativeHttp.probeGuardianOrigin(CUSTOM);
    const driftCheck = nativeHttp.probeGuardianOrigin(CUSTOM);

    pickerCheck(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
    driftCheck(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });

  it('keeps an origin routed when one overlapping probe proves it a Guardian and the other then fails', async () => {
    const pickerCheck = nativeHttp.probeGuardianOrigin(CUSTOM);
    const driftCheck = nativeHttp.probeGuardianOrigin(CUSTOM);

    pickerCheck(true);
    driftCheck(false);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('never removes a built-in origin when a probe of it fails', async () => {
    nativeHttp.probeGuardianOrigin(BUILTIN)(false);

    expect(await transportFor(`${BUILTIN}/pubkey`)).toBe('native');
  });

  it('never removes a registered origin when a probe of it fails', async () => {
    nativeHttp.registerGuardianOrigin(CUSTOM);

    nativeHttp.probeGuardianOrigin(CUSTOM)(false);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('never removes an origin registered while a probe of it is in flight when that probe fails', async () => {
    const settle = nativeHttp.probeGuardianOrigin(CUSTOM);
    nativeHttp.registerGuardianOrigin(CUSTOM);

    settle(false);

    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('ignores every settle after the first', async () => {
    const first = nativeHttp.probeGuardianOrigin(CUSTOM);
    const second = nativeHttp.probeGuardianOrigin(CUSTOM);

    first(false);
    first(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
    first(true);
    second(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });

  it('gives an unparseable endpoint a settle that does nothing, and never throws', () => {
    expect(() => nativeHttp.probeGuardianOrigin('https://')(true)).not.toThrow();
    expect(() => nativeHttp.registerGuardianOrigin('https://')).not.toThrow();
  });

  it('routes a probed origin again once an override that reserved it mid-probe is cleared', async () => {
    const settle = nativeHttp.probeGuardianOrigin(CUSTOM);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');

    mockRpcUrl = `${CUSTOM}/`;
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
    mockRpcUrl = 'https://rpc.test';
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');

    settle(false);
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });
});

describe('withGuardianProbe', () => {
  it('routes the origin while the check runs and keeps it routed once the check resolves', async () => {
    let duringCheck: 'native' | 'web' | undefined;

    const result = await nativeHttp.withGuardianProbe(CUSTOM, async () => {
      duringCheck = await transportFor(`${CUSTOM}/pubkey`);
      return 'commitment';
    });

    expect(result).toBe('commitment');
    expect(duringCheck).toBe('native');
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });

  it('releases the origin and rethrows when the check rejects', async () => {
    const refused = new Error('malformed key commitment');
    let duringCheck: 'native' | 'web' | undefined;

    await expect(
      nativeHttp.withGuardianProbe(CUSTOM, async () => {
        duringCheck = await transportFor(`${CUSTOM}/pubkey`);
        throw refused;
      })
    ).rejects.toBe(refused);

    expect(duringCheck).toBe('native');
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });

  it('returns the result and releases the origin when the verdict on it is false', async () => {
    const result = await nativeHttp.withGuardianProbe(
      CUSTOM,
      async () => '',
      commitment => commitment !== ''
    );

    expect(result).toBe('');
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('web');
  });

  it('keeps the origin routed when the verdict on the result is true', async () => {
    const result = await nativeHttp.withGuardianProbe(
      CUSTOM,
      async () => 'commitment',
      commitment => commitment === 'commitment'
    );

    expect(result).toBe('commitment');
    expect(await transportFor(`${CUSTOM}/pubkey`)).toBe('native');
  });
});

describe('off mobile (#312)', () => {
  it('sends a Guardian request through the original fetch under the boundary signal, never native HTTP', async () => {
    const offMobile = loadOffMobile();
    mockWebFetch.mockResolvedValue(webResponse(200, '{"ok":true}'));
    offMobile.registerGuardianOrigin(CUSTOM);

    const response = await globalThis.fetch(`${CUSTOM}/state`, { method: 'GET', headers: { 'x-a': 'b' } });

    expect(mockNativeRequest).not.toHaveBeenCalled();
    expect(mockWebFetch).toHaveBeenCalledWith(
      `${CUSTOM}/state`,
      expect.objectContaining({ method: 'GET', headers: { 'x-a': 'b' }, signal: expect.any(AbortSignal) })
    );
    // Rebuilt from the buffered body, with the answer's own status line.
    expect(response).toMatchObject({ init: { status: 200, statusText: 'OK' } });
  });

  it('hands a bodyless status back with no body, as Response requires', async () => {
    const offMobile = loadOffMobile();
    mockWebFetch.mockResolvedValue(webResponse(204, ''));
    offMobile.registerGuardianOrigin(CUSTOM);

    const response = await globalThis.fetch(`${CUSTOM}/delta`, { method: 'DELETE' });

    expect(response).toMatchObject({ body: null, init: { status: 204 } });
  });

  it('passes a request to an unrouted origin to the original fetch untouched and unbounded', async () => {
    const offMobile = loadOffMobile();
    offMobile.installGuardianFetchBoundary();
    const init = { method: 'POST' };

    await globalThis.fetch('https://rpc.test/rpc.Api/SyncState', init);

    expect(mockWebFetch).toHaveBeenCalledTimes(1);
    expect(mockWebFetch.mock.calls[0]?.[1]).toBe(init);
  });
});

describe('installing the boundary (#312)', () => {
  it('registerGuardianOrigin installs it off mobile, once', () => {
    const offMobile = loadOffMobile();
    offMobile.registerGuardianOrigin(CUSTOM);
    const boundary = globalThis.fetch;
    expect(boundary).not.toBe(mockWebFetch);

    offMobile.installGuardianFetchBoundary();
    offMobile.registerGuardianOrigin(BUILTIN);

    expect(globalThis.fetch).toBe(boundary);
  });

  it('probeGuardianOrigin installs it off mobile too', () => {
    const offMobile = loadOffMobile();

    offMobile.probeGuardianOrigin(CUSTOM);

    expect(globalThis.fetch).not.toBe(mockWebFetch);
  });

  it('waits for a realm that has no fetch yet, and installs once it has one', () => {
    mockIsMobile.mockReturnValue(false);
    Reflect.deleteProperty(globalThis, 'fetch');
    const offMobile = loadNativeHttp();

    offMobile.registerGuardianOrigin(CUSTOM);
    expect(typeof globalThis.fetch).toBe('undefined');

    globalThis.fetch = mockWebFetch;
    offMobile.registerGuardianOrigin(CUSTOM);
    expect(globalThis.fetch).not.toBe(mockWebFetch);
  });
});

describe('the Guardian request deadline (#312)', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    ['on mobile', true],
    ['off mobile', false]
  ])('cuts a routed request off at GUARDIAN_REQUEST_TIMEOUT_MS, %s', async (_label, mobile) => {
    jest.useFakeTimers();
    mockIsMobile.mockReturnValue(mobile);
    globalThis.fetch = mockWebFetch;
    const boundary = loadNativeHttp();
    mockNativeRequest.mockReturnValue(new Promise(() => undefined));
    mockWebFetch.mockReturnValue(new Promise(() => undefined));
    boundary.registerGuardianOrigin(CUSTOM);

    const request = track(globalThis.fetch(`${CUSTOM}/delta/proposal`, { method: 'POST' }));
    await jest.advanceTimersByTimeAsync(boundary.GUARDIAN_REQUEST_TIMEOUT_MS - 1);
    expect(request.settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(request.error).toBeInstanceOf(boundary.GuardianRequestTimeoutError);
    expect(request.error).toMatchObject({
      name: 'GuardianRequestTimeoutError',
      url: `${CUSTOM}/delta/proposal`,
      timeoutMs: 60_000
    });
  });

  // The signal the boundary hands the original fetch, which is what ends the request itself off mobile.
  const forwardedSignal = (): unknown => mockWebFetch.mock.calls[0]?.[1]?.signal;

  it('aborts the signal it hands the original fetch at the deadline, off mobile', async () => {
    jest.useFakeTimers();
    const offMobile = loadOffMobile();
    mockWebFetch.mockReturnValue(new Promise(() => undefined));
    offMobile.registerGuardianOrigin(CUSTOM);

    track(globalThis.fetch(`${CUSTOM}/delta/proposal`, { method: 'POST' }));
    const signal = forwardedSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    await jest.advanceTimersByTimeAsync(offMobile.GUARDIAN_REQUEST_TIMEOUT_MS - 1);
    expect(signal).toHaveProperty('aborted', false);

    await jest.advanceTimersByTimeAsync(1);
    expect(signal).toHaveProperty('aborted', true);
  });

  it('aborts the signal it hands the original fetch when the caller aborts, off mobile', () => {
    const offMobile = loadOffMobile();
    mockWebFetch.mockReturnValue(new Promise(() => undefined));
    offMobile.registerGuardianOrigin(CUSTOM);
    const caller = new AbortController();

    track(globalThis.fetch(`${CUSTOM}/state`, { signal: caller.signal }));
    const signal = forwardedSignal();
    expect(signal).toHaveProperty('aborted', false);
    caller.abort(new Error('the caller gave up'));

    expect(signal).toHaveProperty('aborted', true);
  });

  it("honours a routed Request's own signal that aborts mid-flight, off mobile", async () => {
    const offMobile = loadOffMobile();
    mockWebFetch.mockReturnValue(new Promise(() => undefined));
    offMobile.registerGuardianOrigin(CUSTOM);
    const caller = new AbortController();
    const reason = new Error('the caller gave up');

    const request = track(globalThis.fetch(new Request(`${CUSTOM}/state`, { signal: caller.signal })));
    const signal = forwardedSignal();
    expect(signal).toHaveProperty('aborted', false);
    caller.abort(reason);
    await flush();

    expect(signal).toHaveProperty('aborted', true);
    expect(request.error).toBe(reason);
  });

  it('never sends a routed Request whose own signal already aborted, off mobile', async () => {
    const offMobile = loadOffMobile();
    mockWebFetch.mockResolvedValue(webResponse(200, '{}'));
    offMobile.registerGuardianOrigin(CUSTOM);
    const caller = new AbortController();
    const reason = new Error('aborted before sending');
    caller.abort(reason);

    const request = track(globalThis.fetch(new Request(`${CUSTOM}/state`, { signal: caller.signal })));
    await flush();

    expect(mockWebFetch).not.toHaveBeenCalled();
    expect(request.error).toBe(reason);
  });

  it('cuts off a response whose body never arrives at the deadline, off mobile', async () => {
    // guardian-client reads the body after fetch resolves, so a deadline that ended at the headers would leave it hung.
    jest.useFakeTimers();
    const offMobile = loadOffMobile();
    mockWebFetch.mockResolvedValue({ ...webResponse(200, '{}'), arrayBuffer: () => new Promise(() => undefined) });
    offMobile.registerGuardianOrigin(CUSTOM);

    const request = track(globalThis.fetch(`${CUSTOM}/state`));
    await jest.advanceTimersByTimeAsync(offMobile.GUARDIAN_REQUEST_TIMEOUT_MS - 1);
    expect(request.settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(request.error).toBeInstanceOf(offMobile.GuardianRequestTimeoutError);
  });

  it('asks native HTTP for the same deadline, so the request itself ends too', async () => {
    nativeHttp.registerGuardianOrigin(CUSTOM);

    await globalThis.fetch(`${CUSTOM}/pubkey`);

    expect(mockNativeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeout: nativeHttp.GUARDIAN_REQUEST_TIMEOUT_MS,
        readTimeout: nativeHttp.GUARDIAN_REQUEST_TIMEOUT_MS
      })
    );
  });

  it('drops a native answer that arrives after the deadline cut the request off', async () => {
    jest.useFakeTimers();
    let answer: (value: unknown) => void = () => undefined;
    mockNativeRequest.mockReturnValue(
      new Promise(resolve => {
        answer = resolve;
      })
    );
    nativeHttp.registerGuardianOrigin(CUSTOM);

    const request = track(globalThis.fetch(`${CUSTOM}/delta/proposal`, { method: 'POST' }));
    await jest.advanceTimersByTimeAsync(nativeHttp.GUARDIAN_REQUEST_TIMEOUT_MS);
    answer({ status: 200, headers: {}, data: '{}' });
    await jest.advanceTimersByTimeAsync(0);

    expect(request.error).toBeInstanceOf(nativeHttp.GuardianRequestTimeoutError);
  });

  it.each([
    ['on mobile', true],
    ['off mobile', false]
  ])("rejects with the caller's own reason when the caller aborts, %s", async (_label, mobile) => {
    mockIsMobile.mockReturnValue(mobile);
    globalThis.fetch = mockWebFetch;
    const boundary = loadNativeHttp();
    mockNativeRequest.mockReturnValue(new Promise(() => undefined));
    mockWebFetch.mockReturnValue(new Promise(() => undefined));
    boundary.registerGuardianOrigin(CUSTOM);
    const caller = new AbortController();
    const reason = new Error('the caller gave up');

    const request = track(globalThis.fetch(`${CUSTOM}/state`, { signal: caller.signal }));
    caller.abort(reason);
    await flush();

    expect(request.error).toBe(reason);
  });

  // JS timers can run late or sleep through a suspension while the native request times out on its own, so the
  // native error can settle the request before the deadline's timer fires.
  describe('a native request that fails once its deadline has passed', () => {
    let now = 0;
    let nowSpy: jest.SpyInstance<number, []>;
    let failNative: (error: unknown) => void = () => undefined;
    const nativeTimeout = new Error('The request timed out.');

    beforeEach(() => {
      now = 1_000_000;
      nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => now);
      mockNativeRequest.mockReturnValue(
        new Promise((_resolve, reject) => {
          failNative = reject;
        })
      );
      nativeHttp.registerGuardianOrigin(CUSTOM);
    });
    afterEach(() => nowSpy.mockRestore());

    it('rejects as a Guardian request timeout even though the timer has not fired', async () => {
      const request = globalThis.fetch(`${CUSTOM}/delta/proposal`, { method: 'POST' });
      now += nativeHttp.GUARDIAN_REQUEST_TIMEOUT_MS;
      failNative(nativeTimeout);

      await expect(request).rejects.toBeInstanceOf(nativeHttp.GuardianRequestTimeoutError);
    });

    it('keeps the native error when the request fails before its deadline', async () => {
      const request = globalThis.fetch(`${CUSTOM}/delta/proposal`, { method: 'POST' });
      now += nativeHttp.GUARDIAN_REQUEST_TIMEOUT_MS - 1;
      failNative(nativeTimeout);

      await expect(request).rejects.toBe(nativeTimeout);
    });

    it("keeps the caller's reason when the caller aborted", async () => {
      const caller = new AbortController();
      const reason = new Error('the caller gave up');
      const request = globalThis.fetch(`${CUSTOM}/delta/proposal`, { method: 'POST', signal: caller.signal });
      now += nativeHttp.GUARDIAN_REQUEST_TIMEOUT_MS;
      caller.abort(reason);
      failNative(nativeTimeout);

      await expect(request).rejects.toBe(reason);
    });
  });

  it.each([
    ['on mobile', true],
    ['off mobile', false]
  ])('never sends a request whose caller already aborted, %s', async (_label, mobile) => {
    mockIsMobile.mockReturnValue(mobile);
    globalThis.fetch = mockWebFetch;
    const boundary = loadNativeHttp();
    boundary.registerGuardianOrigin(CUSTOM);
    const caller = new AbortController();
    const reason = new Error('aborted before sending');
    caller.abort(reason);

    await expect(globalThis.fetch(`${CUSTOM}/state`, { signal: caller.signal })).rejects.toBe(reason);
    expect(mockNativeRequest).not.toHaveBeenCalled();
    expect(mockWebFetch).not.toHaveBeenCalled();
  });
});

describe('the timeout the transaction loop sees (#312)', () => {
  it('is recognized by isGuardianRequestTimeout, directly and as a cause', () => {
    const timeout = new nativeHttp.GuardianRequestTimeoutError(
      `${CUSTOM}/delta/proposal`,
      nativeHttp.GUARDIAN_REQUEST_TIMEOUT_MS
    );

    expect(isGuardianRequestTimeout(timeout)).toBe(true);
    expect(isGuardianRequestTimeout(new Error('proposal failed', { cause: timeout }))).toBe(true);
  });
});
