/**
 * Unit coverage for `src/contentScript.ts` — the injected content script that
 * bridges an in-page dApp to the extension's intercom port.
 *
 * The module does all of its work at *import time*: it injects `addToWindow.js`
 * into the page, (on MV3) starts a service-worker keep-alive loop, and registers
 * a single `window` `message` listener that proxies `MIDEN_PAGE_REQUEST`
 * envelopes to the `IntercomClient` and posts the reply back via
 * `window.postMessage`. None of its functions are exported.
 *
 * Strategy: mock `webextension-polyfill` and `lib/intercom/client`, spy on
 * `window.addEventListener` to capture the registered `message` handler (the
 * same "capture the listener" technique used by `lib/adapter/client.test.ts`),
 * then `jest.resetModules()` + `require('./contentScript')` per test to re-run
 * its module scope against freshly-configured mocks (the `jest.resetModules()` +
 * `require()` pattern used by `src/i18n.test.ts`). The enum modules are mocked
 * to the exact string values from source so the unit stays isolated from their
 * deep dependency graphs, while the real (dependency-free) `serializeError`
 * from `lib/intercom/helpers` is used so the error envelope assertion is real.
 */

import { MidenPageMessageType } from 'lib/adapter/types';
import { MidenMessageType } from 'lib/miden/types';

// ── webextension-polyfill mock ─────────────────────────────────────
const mockGetURL = jest.fn((path: string) => `chrome-extension://test/${path}`);
const mockSendMessage = jest.fn();
const mockGetManifest = jest.fn();
// Mutated per-test to flip the MV2/MV3 branch; read lazily by getManifest().
let mockManifestVersion = 3;

jest.mock('webextension-polyfill', () => {
  const runtime = {
    getURL: mockGetURL,
    getManifest: mockGetManifest,
    sendMessage: mockSendMessage
  };
  return { __esModule: true, default: { runtime }, runtime };
});

// ── lib/intercom/client mock ───────────────────────────────────────
const mockRequest = jest.fn();
const mockIntercomInstances: Array<{ request: jest.Mock }> = [];
const MockIntercomClient = jest.fn(() => {
  const inst = { request: mockRequest };
  mockIntercomInstances.push(inst);
  return inst;
});

jest.mock('lib/intercom/client', () => ({
  __esModule: true,
  IntercomClient: MockIntercomClient
}));

// ── Enum modules (exact string values from source) ─────────────────
jest.mock('lib/adapter/types', () => ({
  __esModule: true,
  MidenPageMessageType: {
    Request: 'MIDEN_PAGE_REQUEST',
    Response: 'MIDEN_PAGE_RESPONSE',
    ErrorResponse: 'MIDEN_PAGE_ERROR_RESPONSE'
  }
}));

jest.mock('lib/miden/types', () => ({
  __esModule: true,
  MidenMessageType: {
    PageRequest: 'MIDEN_PAGE_REQUEST',
    PageResponse: 'MIDEN_PAGE_RESPONSE'
  }
}));

// ── Captured window `message` listeners + spies ────────────────────
let messageListeners: Array<(evt: any) => void> = [];
let postSpy: jest.SpyInstance;
let debugSpy: jest.SpyInstance;

/** Flush pending microtasks so the request/response promise chain settles. */
const flush = async (times = 8) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

/** Re-run the module's top-level side effects against the current mocks. */
function load(): void {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./contentScript');
}

/** The `message` listener registered by the most recent `load()`. */
function handler(): (evt: any) => void {
  const cb = messageListeners[messageListeners.length - 1];
  if (!cb) throw new Error('contentScript did not register a message listener');
  return cb;
}

/** Build a well-formed page-request envelope with `source === window`. */
function requestEvent(overrides: { payload?: any; reqId?: any; origin?: string } = {}): {
  source: Window;
  data: any;
  origin: string;
} {
  const { payload = { a: 1 }, reqId = 'req-1', origin = 'https://dapp.example' } = overrides;
  return { source: window, data: { type: MidenPageMessageType.Request, payload, reqId }, origin };
}

beforeEach(() => {
  jest.useFakeTimers();
  messageListeners = [];

  mockManifestVersion = 3;
  mockGetURL.mockReset().mockImplementation((path: string) => `chrome-extension://test/${path}`);
  mockGetManifest.mockReset().mockImplementation(() => ({ manifest_version: mockManifestVersion }));
  mockSendMessage.mockReset().mockResolvedValue(undefined);
  mockRequest.mockReset().mockResolvedValue(undefined);
  mockIntercomInstances.length = 0;
  MockIntercomClient.mockReset().mockImplementation(() => {
    const inst = { request: mockRequest };
    mockIntercomInstances.push(inst);
    return inst;
  });

  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);
  jest.spyOn(window, 'addEventListener').mockImplementation((type: string, cb: any, opts?: any) => {
    if (type === 'message') {
      messageListeners.push(cb);
      return;
    }
    return realAdd(type, cb, opts);
  });
  jest.spyOn(window, 'removeEventListener').mockImplementation((type: string, cb: any, opts?: any) => {
    if (type === 'message') {
      const i = messageListeners.indexOf(cb);
      if (i >= 0) messageListeners.splice(i, 1);
      return;
    }
    return realRemove(type, cb, opts);
  });

  postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
  debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  jest.clearAllTimers();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ── Module-scope side effects: script injection ────────────────────
describe('addToWindow.js injection', () => {
  it('resolves the packaged script URL and appends it to document.head', () => {
    load();

    expect(mockGetURL).toHaveBeenCalledWith('addToWindow.js');
    const injected = [...document.head.querySelectorAll('script')].filter(s => s.src.includes('addToWindow.js'));
    expect(injected.length).toBeGreaterThan(0);
    expect(injected[injected.length - 1]!.src).toContain('chrome-extension://test/addToWindow.js');
  });

  it('falls back to documentElement when document.head is absent', () => {
    const head = document.head;
    head.remove();
    expect(document.head).toBeNull();

    try {
      load();

      const injected = [...document.documentElement.querySelectorAll('script')].filter(s =>
        s.src.includes('addToWindow.js')
      );
      expect(injected.length).toBeGreaterThan(0);
    } finally {
      // Restore a <head> so later tests see a non-null document.head.
      document.documentElement.insertBefore(document.createElement('head'), document.documentElement.firstChild);
    }
  });

  it('registers exactly one window message listener on load', () => {
    load();
    expect(messageListeners).toHaveLength(1);
  });
});

// ── Module-scope side effects: SW keep-alive loop ──────────────────
describe('service-worker keep-alive loop', () => {
  it('starts the keep-alive loop when the manifest is MV3', () => {
    load();
    expect(mockGetManifest).toHaveBeenCalled();
    // A single pending setTimeout is scheduled by keepSWAlive().
    expect(jest.getTimerCount()).toBe(1);
  });

  it('does not start the loop when the manifest is not MV3', () => {
    mockManifestVersion = 2;
    load();
    expect(mockGetManifest).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('wakes the SW and pings intercom on each tick, then reschedules', async () => {
    mockRequest.mockResolvedValue(undefined);
    load();
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockSendMessage).toHaveBeenCalledWith('wakeup');
    // getIntercom() lazily constructs a single client, then pings it.
    expect(MockIntercomClient).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith({ type: 'PING', payload: 'PING' });
    // The loop rescheduled itself for the next tick.
    expect(jest.getTimerCount()).toBe(1);
  });

  it('logs and still reschedules when the intercom ping rejects', async () => {
    mockRequest.mockRejectedValue(new Error('down'));
    load();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockSendMessage).toHaveBeenCalledWith('wakeup');
    expect(mockRequest).toHaveBeenCalledWith({ type: 'PING', payload: 'PING' });
    // testIntercomConnection() logs then rethrows; keepSWAlive() catches + logs.
    expect(debugSpy).toHaveBeenCalledWith('Intercom connection corrupted', expect.any(Error));
    // The loop keeps going despite the failure.
    expect(jest.getTimerCount()).toBe(1);
  });

  it('logs and reschedules when the wakeup message itself rejects', async () => {
    mockSendMessage.mockRejectedValue(new Error('no sw'));
    load();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockSendMessage).toHaveBeenCalledWith('wakeup');
    // Failure happened before the ping, so intercom was never constructed.
    expect(MockIntercomClient).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith('Intercom connection corrupted', expect.any(Error));
    expect(jest.getTimerCount()).toBe(1);
  });
});

// ── window message listener: filtering ─────────────────────────────
describe('message listener filtering', () => {
  it('ignores messages whose source is not the current window', async () => {
    load();
    handler()({ source: {}, data: { type: MidenPageMessageType.Request, payload: {}, reqId: '1' } });
    await flush();

    expect(MockIntercomClient).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('ignores same-window messages with no data', async () => {
    load();
    handler()({ source: window, data: undefined, origin: 'https://dapp.example' });
    await flush();

    expect(mockRequest).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('ignores same-window messages that are not page requests', async () => {
    load();
    handler()({ source: window, data: { type: 'SOMETHING_ELSE' }, origin: 'https://dapp.example' });
    await flush();

    expect(mockRequest).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });
});

// ── window message listener: request/response proxying ─────────────
describe('page request proxying', () => {
  it('forwards a page request to intercom and posts the response back', async () => {
    mockRequest.mockResolvedValue({ type: MidenMessageType.PageResponse, payload: { ok: true } });
    load();

    handler()(requestEvent({ payload: { a: 1 }, reqId: 'req-1', origin: 'https://dapp.example' }));
    await flush();

    expect(mockRequest).toHaveBeenCalledWith({
      type: MidenMessageType.PageRequest,
      origin: 'https://dapp.example',
      payload: { a: 1 }
    });
    expect(postSpy).toHaveBeenCalledWith(
      { type: MidenPageMessageType.Response, payload: { ok: true }, reqId: 'req-1' },
      'https://dapp.example'
    );
  });

  it('does not post a response when the intercom reply is not a PageResponse', async () => {
    mockRequest.mockResolvedValue({ type: 'MIDEN_DAPP_GET_PAYLOAD_RESPONSE', payload: {} });
    load();

    handler()(requestEvent());
    await flush();

    expect(mockRequest).toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('does not post a response when the intercom reply is empty', async () => {
    mockRequest.mockResolvedValue(undefined);
    load();

    handler()(requestEvent());
    await flush();

    expect(mockRequest).toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('posts a serialized ErrorResponse when the intercom request rejects', async () => {
    mockRequest.mockRejectedValue(new Error('boom'));
    load();

    handler()(requestEvent({ reqId: 'err-1', origin: 'https://dapp.example' }));
    await flush();

    expect(postSpy).toHaveBeenCalledWith(
      { type: MidenPageMessageType.ErrorResponse, payload: 'boom', reqId: 'err-1' },
      'https://dapp.example'
    );
  });

  it('reuses a single intercom client across multiple requests', async () => {
    mockRequest.mockResolvedValue({ type: MidenMessageType.PageResponse, payload: 1 });
    load();

    handler()(requestEvent({ reqId: 'a' }));
    handler()(requestEvent({ reqId: 'b' }));
    await flush();

    expect(MockIntercomClient).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});

// ── send(): target-origin guarding ─────────────────────────────────
describe('response target-origin guarding', () => {
  it('does not post when the resolved response has an empty origin', async () => {
    mockRequest.mockResolvedValue({ type: MidenMessageType.PageResponse, payload: { ok: true } });
    load();

    handler()(requestEvent({ origin: '' }));
    await flush();

    expect(mockRequest).toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('does not post to the wildcard origin', async () => {
    mockRequest.mockResolvedValue({ type: MidenMessageType.PageResponse, payload: { ok: true } });
    load();

    handler()(requestEvent({ origin: '*' }));
    await flush();

    expect(mockRequest).toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('does not post an error to the wildcard origin', async () => {
    mockRequest.mockRejectedValue(new Error('boom'));
    load();

    handler()(requestEvent({ origin: '*' }));
    await flush();

    expect(postSpy).not.toHaveBeenCalled();
  });
});
