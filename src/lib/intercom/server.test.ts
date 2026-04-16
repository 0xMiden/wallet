import { IntercomServer } from './server';
import { MessageType } from './types';

// Mock webextension-polyfill before importing
const mockAddListener = jest.fn();
const mockRemoveListener = jest.fn();
const mockPostMessage = jest.fn();
const mockPort = {
  onMessage: {
    addListener: mockAddListener,
    removeListener: mockRemoveListener
  },
  onDisconnect: {
    addListener: jest.fn(),
    removeListener: jest.fn()
  },
  postMessage: mockPostMessage,
  sender: { id: 'test-extension-id' }
};

let connectListener: (port: any) => void;

jest.mock('webextension-polyfill', () => ({
  runtime: {
    id: 'test-extension-id',
    onConnect: {
      addListener: (fn: (port: any) => void) => {
        connectListener = fn;
      }
    }
  }
}));

describe('IntercomServer', () => {
  let server: IntercomServer;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new IntercomServer();
  });

  it('creates server instance', () => {
    expect(server).toBeDefined();
    expect(connectListener).toBeDefined();
  });

  it('adds port on connect', () => {
    connectListener(mockPort);

    expect(mockPort.onDisconnect.addListener).toHaveBeenCalled();
    expect(mockPort.onMessage.addListener).toHaveBeenCalled();
    expect(server.isConnected(mockPort as any)).toBe(true);
  });

  it('removes port on disconnect', () => {
    connectListener(mockPort);

    // Get the disconnect listener and call it
    const disconnectCallback = mockPort.onDisconnect.addListener.mock.calls[0][0];
    disconnectCallback();

    expect(server.isConnected(mockPort as any)).toBe(false);
  });

  it('registers and unregisters request handlers', () => {
    const handler = jest.fn().mockResolvedValue({ result: 'ok' });

    const unsubscribe = server.onRequest(handler);

    expect(typeof unsubscribe).toBe('function');

    // Unsubscribe
    unsubscribe();
  });

  it('broadcasts to all connected ports', () => {
    connectListener(mockPort);

    server.broadcast({ message: 'hello' });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: MessageType.Sub,
      data: { message: 'hello' }
    });
  });

  it('notifies specific port', () => {
    connectListener(mockPort);

    server.notify(mockPort as any, { event: 'update' });

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: MessageType.Sub,
      data: { event: 'update' }
    });
  });

  it('handles onDisconnect listener registration', () => {
    const listener = jest.fn();

    const unsubscribe = server.onDisconnect(mockPort as any, listener);

    expect(mockPort.onDisconnect.addListener).toHaveBeenCalledWith(listener);
    expect(typeof unsubscribe).toBe('function');

    unsubscribe();
    expect(mockPort.onDisconnect.removeListener).toHaveBeenCalledWith(listener);
  });

  it('handles request messages with registered handler', async () => {
    const handler = jest.fn().mockResolvedValue({ result: 'success' });
    server.onRequest(handler);

    connectListener(mockPort);

    // Get the message handler
    const messageHandler = mockAddListener.mock.calls[0][0];

    // Simulate a request message
    await messageHandler({ type: MessageType.Req, reqId: 'req-1', data: { action: 'test' } }, mockPort);

    // Wait for async handler
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(handler).toHaveBeenCalledWith({ action: 'test' }, mockPort);
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: MessageType.Res,
      reqId: 'req-1',
      data: { result: 'success' }
    });
  });

  it('queues request messages until a handler is registered, then replays them', async () => {
    // Connect first, no handlers yet
    connectListener(mockPort);

    const messageHandler = mockAddListener.mock.calls[0][0];

    // Send a non-GET_STATE/SYNC request — should be queued, NOT responded to
    await messageHandler({ type: MessageType.Req, reqId: 'req-2', data: { type: 'OTHER_REQUEST' } }, mockPort);

    await new Promise(resolve => setTimeout(resolve, 0));

    // No response sent yet — message is queued
    expect(mockPostMessage).not.toHaveBeenCalled();

    // Register a handler — queued message replays through it
    const handler = jest.fn().mockResolvedValue({ result: 'replayed' });
    server.onRequest(handler);

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(handler).toHaveBeenCalledWith({ type: 'OTHER_REQUEST' }, mockPort);
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: MessageType.Res,
      reqId: 'req-2',
      data: { result: 'replayed' }
    });
  });

  it('sends error when handler throws', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('Handler failed'));
    server.onRequest(handler);

    connectListener(mockPort);

    const messageHandler = mockAddListener.mock.calls[0][0];

    await messageHandler({ type: MessageType.Req, reqId: 'req-3', data: {} }, mockPort);

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: MessageType.Err,
      reqId: 'req-3',
      data: 'Handler failed'
    });
  });

  it('sends Not Found error when handler returns undefined but handlers are initialized', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    server.onRequest(handler);

    connectListener(mockPort);

    const messageHandler = mockAddListener.mock.calls[0][0];

    await messageHandler({ type: MessageType.Req, reqId: 'req-4', data: {} }, mockPort);

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: MessageType.Err,
      reqId: 'req-4',
      data: 'Not Found'
    });
  });

  it('ignores messages from other extensions', async () => {
    const handler = jest.fn().mockResolvedValue({ result: 'success' });
    server.onRequest(handler);

    const otherPort = {
      ...mockPort,
      sender: { id: 'other-extension-id' }
    };

    connectListener(otherPort);

    const messageHandler = mockAddListener.mock.calls[0][0];

    await messageHandler({ type: MessageType.Req, reqId: 'req-5', data: {} }, otherPort);

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not send to disconnected port', () => {
    connectListener(mockPort);

    // Simulate disconnect
    const disconnectCallback = mockPort.onDisconnect.addListener.mock.calls[0][0];
    disconnectCallback();

    // Clear previous calls
    mockPostMessage.mockClear();

    // Try to notify the disconnected port
    server.notify(mockPort as any, { event: 'update' });

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('calls onAllClientsDisconnected listeners when the last port disconnects', () => {
    const disconnectHandler = jest.fn();
    server.onAllClientsDisconnected(disconnectHandler);

    connectListener(mockPort);
    // Simulate disconnect — this is the only port, so ports.size becomes 0
    const disconnectCallback = mockPort.onDisconnect.addListener.mock.calls[0][0];
    disconnectCallback();

    expect(disconnectHandler).toHaveBeenCalledTimes(1);
  });

  it('catches errors in onAllClientsDisconnected listeners', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const throwingHandler = () => {
      throw new Error('listener error');
    };
    server.onAllClientsDisconnected(throwingHandler);

    connectListener(mockPort);
    const disconnectCallback = mockPort.onDisconnect.addListener.mock.calls[0][0];
    disconnectCallback();

    expect(errorSpy).toHaveBeenCalledWith('[IntercomServer] Disconnect listener error:', expect.any(Error));
    errorSpy.mockRestore();
  });
});
