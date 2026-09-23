import React from 'react';

import { act, render } from '@testing-library/react';

import type { MidenNameTrackerDeps } from './tracker';
import { MIDEN_NAME_TRACKER_INTERVAL_MS, MidenNameWatcher, runTrackerPassExclusive } from './MidenNameWatcher';

const mockReconcile = jest.fn<Promise<void>, [MidenNameTrackerDeps]>();
jest.mock('./tracker', () => ({
  reconcileMidenNameRegistrations: (deps: MidenNameTrackerDeps) => mockReconcile(deps)
}));

let mockSupported = true;
jest.mock('./config', () => ({
  isMidenNameSupported: () => mockSupported
}));

const mockSign = jest.fn();
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ signTransaction: mockSign })
}));

const mockRequestSW = jest.fn();
const mockStartBackground = jest.fn();
jest.mock('lib/miden/activity', () => ({
  requestSWTransactionProcessing: () => mockRequestSW(),
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBackground(...args)
}));
jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { name: 'provider' } }));

let mockExtension = false;
jest.mock('lib/platform', () => ({
  isExtension: () => mockExtension
}));

let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

const settle = async () => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
};
const advance = async () => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(MIDEN_NAME_TRACKER_INTERVAL_MS);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSupported = true;
  mockExtension = false;
  hidden = false;
  mockReconcile.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('MidenNameWatcher', () => {
  it('runs a pass on mount and every interval', async () => {
    const view = render(<MidenNameWatcher />);
    await settle();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    await advance();
    expect(mockReconcile).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('skips a pass while the document is hidden', async () => {
    hidden = true;
    const view = render(<MidenNameWatcher />);
    await settle();
    await advance();
    expect(mockReconcile).not.toHaveBeenCalled();
    hidden = false;
    await advance();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('stops the interval on unmount', async () => {
    const view = render(<MidenNameWatcher />);
    await settle();
    view.unmount();
    await advance();
    await advance();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the network is not supported', async () => {
    mockSupported = false;
    const view = render(<MidenNameWatcher />);
    await settle();
    await advance();
    expect(mockReconcile).not.toHaveBeenCalled();
    view.unmount();
  });

  it('runs one pass at a time', async () => {
    let release: () => void = () => undefined;
    mockReconcile.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );
    const view = render(<MidenNameWatcher />);
    await settle();
    await advance();
    await advance();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
    await advance();
    expect(mockReconcile).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('startProcessing with isExtension true requests SW processing on the extension', async () => {
    mockExtension = true;
    const view = render(<MidenNameWatcher />);
    await settle();
    const deps = mockReconcile.mock.calls[0]?.[0];
    deps?.startProcessing();
    expect(mockRequestSW).toHaveBeenCalledTimes(1);
    expect(mockStartBackground).not.toHaveBeenCalled();
    view.unmount();
  });

  it('startProcessing with isExtension false starts background processing off the extension', async () => {
    mockExtension = false;
    const view = render(<MidenNameWatcher />);
    await settle();
    const deps = mockReconcile.mock.calls[0]?.[0];
    deps?.startProcessing();
    expect(mockStartBackground).toHaveBeenCalledWith(mockSign, false, { name: 'provider' });
    expect(mockRequestSW).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe('runTrackerPassExclusive with navigator.locks', () => {
  const request = jest.fn();

  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('asks for the lock with ifAvailable and skips the pass when the lock is busy', async () => {
    request.mockImplementation(
      async (_name: string, _options: object, callback: (lock: object | null) => Promise<void>) => callback(null)
    );
    const pass = jest.fn(async () => undefined);
    await runTrackerPassExclusive(pass);
    expect(request).toHaveBeenCalledWith('miden-name-tracker', { ifAvailable: true }, expect.any(Function));
    expect(pass).not.toHaveBeenCalled();
  });

  it('runs the pass when it gets the lock', async () => {
    request.mockImplementation(
      async (_name: string, _options: object, callback: (lock: object | null) => Promise<void>) =>
        callback({ name: 'miden-name-tracker' })
    );
    const pass = jest.fn(async () => undefined);
    await runTrackerPassExclusive(pass);
    expect(pass).toHaveBeenCalledTimes(1);
  });
});
