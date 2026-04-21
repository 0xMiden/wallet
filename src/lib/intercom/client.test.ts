import { isDesktop, isMobile } from 'lib/platform';

import { createIntercomClient, IntercomClient } from './client';
import { MessageType } from './types';

// Mock lib/platform for createIntercomClient tests
jest.mock('lib/platform', () => ({
  isMobile: jest.fn(() => false),
  isDesktop: jest.fn(() => false)
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockIsDesktop = isDesktop as jest.MockedFunction<typeof isDesktop>;

// Mock webextension-polyfill before importing
const mockAddListener = jest.fn();
const mockRemoveListener = jest.fn();
const mockPostMessage = jest.fn();
let disconnectCallback: (() => void) | null = null;

const mockPort = {
  onMessage: {
    addListener: mockAddListener,
    removeListener: mockRemoveListener
  },
  onDisconnect: {
    addListener: jest.fn((cb: () => void) => {
      disconnectCallback = cb;
    })
  },
  postMessage: mockPostMessage
};

const mockRuntime = {
  connect: jest.fn(() => mockPort)
};

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    runtime: mockRuntime
  },
  runtime: mockRuntime
}));

// Helper to flush all pending promises with fake timers
const flushPromises = async () => {
  // Run pending timers and promises
  await Promise.resolve();
  jest.runAllTimers();
  await Promise.resolve();
};

describe('IntercomClient', () => {
  let client: IntercomClient;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    disconnectCallback = null;
    client = new IntercomClient();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates client and connects to port', async () => {
    // Wait for async initialization
    await flushPromises();
    expect(mockRuntime.connect).toHaveBeenCalledWith({ name: 'INTERCOM' });
  });

  it('sends request and resolves on response', async () => {
    // Wait for port initialization
    await flushPromises();

    const requestPromise = client.request({ action: 'test' });

    // Wait for the listener to be added
    await flushPromises();

    // Get the message listener
    const messageListener = mockAddListener.mock.calls[0][0];

    // Simulate response
    messageListener({
      type: MessageType.Res,
      reqId: 0,
      data: { result: 'success' }
    });

    const result = await requestPromise;
    expect(result).toEqual({ result: 'success' });
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: MessageType.Req,
      data: { action: 'test' },
      reqId: 0
    });
  });

  it('sends request and rejects on error', async () => {
    // Wait for port initialization
    await flushPromises();

    const requestPromise = client.request({ action: 'test' });

    // Wait for the listener to be added
    await flushPromises();

    // Get the message listener
    const messageListener = mockAddListener.mock.calls[0][0];

    // Simulate error response
    messageListener({
      type: MessageType.Err,
      reqId: 0,
      data: 'Something went wrong'
    });

    await expect(requestPromise).rejects.toMatchObject({
      message: 'Something went wrong'
    });
  });

  it('abort via AbortSignal rejects and removes the port listener', async () => {
    await flushPromises();

    const controller = new AbortController();
    const requestPromise = client.request({ action: 'x' }, { signal: controller.signal });
    await flushPromises();

    expect(mockAddListener).toHaveBeenCalledTimes(1);
    const listener = mockAddListener.mock.calls[0][0];

    controller.abort();

    await expect(requestPromise).rejects.toThrow('Aborted');
    expect(mockRemoveListener).toHaveBeenCalledWith(listener);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    await flushPromises();
    const controller = new AbortController();
    controller.abort();
    await expect(client.request({ action: 'x' }, { signal: controller.signal })).rejects.toThrow('Aborted');
  });

  it('abort after port replacement does not throw (cleanup swallows dead-port removeListener)', async () => {
    await flushPromises();
    const controller = new AbortController();
    const requestPromise = client.request({ action: 'x' }, { signal: controller.signal });
    await flushPromises();

    // Simulate the port being torn down after request started — e.g. SW evicted it.
    mockRemoveListener.mockImplementationOnce(() => {
      throw new Error('port disconnected');
    });

    expect(() => controller.abort()).not.toThrow();
    await expect(requestPromise).rejects.toThrow('Aborted');
  });

  it('ignores messages with different reqId', async () => {
    // Wait for port initialization
    await flushPromises();

    const requestPromise = client.request({ action: 'test' });

    // Wait for the listener to be added
    await flushPromises();

    // Get the message listener
    const messageListener = mockAddListener.mock.calls[0][0];

    // Simulate response with different reqId - should be ignored
    messageListener({
      type: MessageType.Res,
      reqId: 999,
      data: { result: 'wrong' }
    });

    // Now send the correct response
    messageListener({
      type: MessageType.Res,
      reqId: 0,
      data: { result: 'correct' }
    });

    const result = await requestPromise;
    expect(result).toEqual({ result: 'correct' });
  });

  it('increments reqId for each request', async () => {
    // Wait for port initialization
    await flushPromises();

    // First request
    const promise1 = client.request({ action: 'first' });
    await flushPromises();
    const messageListener1 = mockAddListener.mock.calls[0][0];
    messageListener1({ type: MessageType.Res, reqId: 0, data: {} });
    await promise1;

    // Second request
    const promise2 = client.request({ action: 'second' });
    await flushPromises();
    const messageListener2 = mockAddListener.mock.calls[1][0];
    messageListener2({ type: MessageType.Res, reqId: 1, data: {} });
    await promise2;

    expect(mockPostMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ reqId: 0 }));
    expect(mockPostMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ reqId: 1 }));
  });

  it('subscribes to notifications and calls callback', async () => {
    // Wait for port initialization
    await flushPromises();

    const callback = jest.fn();
    client.subscribe(callback);

    // Wait for the subscription listener to be added
    await flushPromises();

    // Get the subscription listener
    const subListener = mockAddListener.mock.calls[0][0];

    // Simulate subscription message
    subListener({
      type: MessageType.Sub,
      data: { event: 'update' }
    });

    expect(callback).toHaveBeenCalledWith({ event: 'update' });
  });

  it('unsubscribes when calling returned function', async () => {
    // Wait for port initialization
    await flushPromises();

    const callback = jest.fn();
    const unsubscribe = client.subscribe(callback);

    unsubscribe();

    expect(mockRemoveListener).toHaveBeenCalled();
  });

  it('subscribe ignores non-Sub messages', async () => {
    // Wait for port initialization
    await flushPromises();

    const callback = jest.fn();
    client.subscribe(callback);

    // Wait for the subscription listener to be added
    await flushPromises();

    // Get the subscription listener
    const subListener = mockAddListener.mock.calls[0][0];

    // Simulate non-Sub message
    subListener({
      type: MessageType.Req,
      data: { event: 'update' }
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('reconnects after disconnect', async () => {
    // Wait for port initialization
    await flushPromises();

    // Trigger disconnect
    if (disconnectCallback) {
      disconnectCallback();
    }

    // Advance timers by 1 second and flush
    jest.advanceTimersByTime(1000);
    await flushPromises();

    // Should have reconnected
    expect(mockRuntime.connect).toHaveBeenCalledTimes(2);
  });
});

describe('createIntercomClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(false);
    // Clean up any Tauri globals
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('returns IntercomClient when in extension context', () => {
    mockIsMobile.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(false);

    const client = createIntercomClient();

    expect(client).toBeInstanceOf(IntercomClient);
  });

  it('returns MobileIntercomClientWrapper when on mobile', () => {
    mockIsMobile.mockReturnValue(true);

    const client = createIntercomClient();

    // Should not be an IntercomClient
    expect(client).not.toBeInstanceOf(IntercomClient);
    // But should have the interface methods
    expect(typeof client.request).toBe('function');
    expect(typeof client.subscribe).toBe('function');
  });

  it('returns DesktopIntercomClientWrapper when on desktop', () => {
    mockIsMobile.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(true);

    const client = createIntercomClient();

    // Should not be an IntercomClient
    expect(client).not.toBeInstanceOf(IntercomClient);
    // But should have the interface methods
    expect(typeof client.request).toBe('function');
    expect(typeof client.subscribe).toBe('function');
  });

  it('returns DesktopIntercomClientWrapper when Tauri globals are present', () => {
    mockIsMobile.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(false);
    (window as any).__TAURI__ = {};

    const client = createIntercomClient();

    // Should not be an IntercomClient
    expect(client).not.toBeInstanceOf(IntercomClient);
    // But should have the interface methods
    expect(typeof client.request).toBe('function');
    expect(typeof client.subscribe).toBe('function');

    // Cleanup
    delete (window as any).__TAURI__;
  });

  it('returns DesktopIntercomClientWrapper when TAURI_INTERNALS__ global is present', () => {
    mockIsMobile.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(false);
    (window as any).__TAURI_INTERNALS__ = {};

    const client = createIntercomClient();

    // Should not be an IntercomClient
    expect(client).not.toBeInstanceOf(IntercomClient);
    // But should have the interface methods
    expect(typeof client.request).toBe('function');
    expect(typeof client.subscribe).toBe('function');

    // Cleanup
    delete (window as any).__TAURI_INTERNALS__;
  });
});

// ── Mobile / desktop wrapper coverage ──────────────────────────────

describe('MobileIntercomClientWrapper', () => {
  const mockMobileAdapter = {
    request: jest.fn(),
    subscribe: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile.mockReturnValue(true);
    mockIsDesktop.mockReturnValue(false);
    jest.doMock('./mobile-adapter', () => ({
      getMobileIntercomAdapter: () => mockMobileAdapter
    }));
  });

  afterEach(() => {
    jest.dontMock('./mobile-adapter');
  });

  it('request delegates to the mobile adapter', async () => {
    mockMobileAdapter.request.mockResolvedValueOnce({ ok: true });
    const client = createIntercomClient();
    const result = await client.request({ payload: 'p' });
    expect(mockMobileAdapter.request).toHaveBeenCalledWith({ payload: 'p' }, undefined);
    expect(result).toEqual({ ok: true });
  });

  it('subscribe wires the callback through after the adapter resolves', async () => {
    const innerUnsub = jest.fn();
    mockMobileAdapter.subscribe.mockReturnValue(innerUnsub);
    const client = createIntercomClient();
    const cb = jest.fn();
    const unsub = client.subscribe(cb);
    // Wait for the adapter promise to resolve
    await new Promise(r => setTimeout(r, 0));
    expect(mockMobileAdapter.subscribe).toHaveBeenCalledWith(cb);
    unsub();
    expect(innerUnsub).toHaveBeenCalled();
  });

  it('unsubscribe is a no-op if called before adapter resolves', () => {
    const client = createIntercomClient();
    const unsub = client.subscribe(jest.fn());
    expect(() => unsub()).not.toThrow();
  });
});

describe('DesktopIntercomClientWrapper', () => {
  const mockDesktopAdapter = {
    request: jest.fn(),
    subscribe: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(true);
    jest.doMock('./desktop-adapter', () => ({
      getDesktopIntercomAdapter: () => mockDesktopAdapter
    }));
  });

  afterEach(() => {
    jest.dontMock('./desktop-adapter');
  });

  it('request delegates to the desktop adapter', async () => {
    mockDesktopAdapter.request.mockResolvedValueOnce({ from: 'desktop' });
    const client = createIntercomClient();
    const result = await client.request({ x: 1 });
    expect(mockDesktopAdapter.request).toHaveBeenCalledWith({ x: 1 }, undefined);
    expect(result).toEqual({ from: 'desktop' });
  });

  it('subscribe wires the callback through after the adapter resolves', async () => {
    const innerUnsub = jest.fn();
    mockDesktopAdapter.subscribe.mockReturnValue(innerUnsub);
    const client = createIntercomClient();
    const cb = jest.fn();
    const unsub = client.subscribe(cb);
    await new Promise(r => setTimeout(r, 0));
    expect(mockDesktopAdapter.subscribe).toHaveBeenCalledWith(cb);
    unsub();
    expect(innerUnsub).toHaveBeenCalled();
  });
});
