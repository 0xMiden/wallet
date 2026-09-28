/* eslint-disable import/first */
/**
 * Coverage for `src/lib/lock-up/checks.ts` - the lock-up checks have no top-level `await`, so they
 * can be unit tested (the bootstrap that awaits `runLockUpChecks` at module scope stays untestable;
 * that is what `run-checks.ts` is for).
 *
 * `webextension-polyfill` and `lib/miden/front` are mocked so every storage, messaging and
 * lock-request call is a controllable `jest.fn()`; `globalThis.chrome` is replaced for the
 * `runtime.connect` background-connection call `runLockUpChecks` makes on every call.
 */

import { CHECK_PAGES_EXIST, WALLET_AUTOLOCK_TIME } from 'lib/fixed-times';
import { WalletMessageType } from 'lib/shared/types';

const mockGetViews = jest.fn();
const mockSendMessage = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();

jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    extension: { getViews: (...args: unknown[]) => mockGetViews(...args) },
    runtime: { sendMessage: (...args: unknown[]) => mockSendMessage(...args) },
    storage: {
      local: {
        get: (...args: unknown[]) => mockGet(...args),
        set: (...args: unknown[]) => mockSet(...args)
      }
    }
  }
}));

const mockRequest = jest.fn();

jest.mock('lib/miden/front', () => ({
  __esModule: true,
  request: (...args: unknown[]) => mockRequest(...args),
  // Mirrors the real assertResponse: throws on a falsy argument.
  assertResponse: (condition: unknown) => {
    if (!condition) throw new Error('Invalid response received.');
  }
}));

import { runLockUpChecks } from './checks';

const CLOSURE_STORAGE_KEY = 'last-page-closure-timestamp';
const NOW = 1_700_000_000_000;

let mockChromeConnect: jest.Mock;
let mockOnDisconnectAddListener: jest.Mock;
let originalChrome: typeof chrome | undefined;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });

  mockGetViews.mockReset().mockReturnValue([window]);
  mockSendMessage.mockReset().mockResolvedValue(undefined);
  mockGet.mockReset().mockResolvedValue({});
  mockSet.mockReset().mockResolvedValue(undefined);
  mockRequest.mockReset().mockResolvedValue({ type: WalletMessageType.LockResponse });

  mockOnDisconnectAddListener = jest.fn();
  mockChromeConnect = jest.fn(() => ({ onDisconnect: { addListener: mockOnDisconnectAddListener } }));
  originalChrome = globalThis.chrome;
  // lastError is an accessor, not a plain value, so a test can spy on reads of it
  // the way the real chrome.runtime.lastError getter is read.
  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime: Object.defineProperty({ connect: mockChromeConnect }, 'lastError', {
        get: () => undefined,
        configurable: true
      })
    },
    configurable: true,
    writable: true
  });

  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  Object.defineProperty(globalThis, 'chrome', {
    value: originalChrome,
    configurable: true,
    writable: true
  });
  // Every call registers its own setInterval; leaking them across tests would let a later test's
  // fake-timer advance fire an earlier test's tick against torn-down mocks.
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('runLockUpChecks', () => {
  it('locks when the only open page opens after the auto-lock time', async () => {
    mockGet.mockResolvedValue({ [CLOSURE_STORAGE_KEY]: String(NOW - WALLET_AUTOLOCK_TIME) });

    await runLockUpChecks();

    expect(mockRequest).toHaveBeenCalledWith({ type: WalletMessageType.LockRequest });
    // A throwing assertResponse reaches only the silenced warn spy, so assert it stayed silent.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not lock within the auto-lock time, or with another page open', async () => {
    mockGet.mockResolvedValue({ [CLOSURE_STORAGE_KEY]: String(NOW - 1) });
    await runLockUpChecks();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    mockGetViews.mockReturnValue([window, window]);
    mockGet.mockResolvedValue({ [CLOSURE_STORAGE_KEY]: String(NOW - WALLET_AUTOLOCK_TIME) });
    await runLockUpChecks();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves and locks when the closure time cannot be read, and reads nothing with another page open', async () => {
    mockGet.mockRejectedValue(new Error('get failed'));

    await expect(runLockUpChecks()).resolves.toBeUndefined();
    expect(mockRequest).toHaveBeenCalledWith({ type: WalletMessageType.LockRequest });
    expect(warnSpy).toHaveBeenCalledWith('[lock-up] Could not read the closure time; locking:', expect.any(Error));

    mockGet.mockClear();
    mockRequest.mockClear();
    warnSpy.mockClear();
    mockGetViews.mockReturnValue([window, window]);
    await expect(runLockUpChecks()).resolves.toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('locks when the stored closure time is not a number, unless another page is open', async () => {
    mockGet.mockResolvedValue({ [CLOSURE_STORAGE_KEY]: 'garbage' });

    await runLockUpChecks();
    expect(mockRequest).toHaveBeenCalledWith({ type: WalletMessageType.LockRequest });
    expect(warnSpy).toHaveBeenCalledWith('[lock-up] The closure time is not a number; locking:', 'garbage');

    mockRequest.mockClear();
    warnSpy.mockClear();
    mockGetViews.mockReturnValue([window, window]);
    await runLockUpChecks();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not lock when no closure time is stored', async () => {
    mockGet.mockResolvedValue({});
    await runLockUpChecks();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    mockGet.mockResolvedValue({ [CLOSURE_STORAGE_KEY]: null });
    await runLockUpChecks();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when the lock request fails', async () => {
    mockGet.mockResolvedValue({ [CLOSURE_STORAGE_KEY]: String(NOW - WALLET_AUTOLOCK_TIME) });
    mockRequest.mockRejectedValue(new Error('lock failed'));

    await runLockUpChecks();
    // The lock request is fire-and-forget (`lock().catch(...)`, not awaited by runLockUpChecks), so
    // flush the microtask queue for its rejection to reach the `.catch` handler.
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledWith('[lock-up] Auto-lock request failed:', new Error('lock failed'));
  });

  it('writes the closure time at load only while a page is open', async () => {
    mockGetViews.mockReturnValue([window]);
    await runLockUpChecks();
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ [CLOSURE_STORAGE_KEY]: String(NOW) });

    mockSet.mockClear();
    mockGetViews.mockReturnValue([]);
    await runLockUpChecks();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('resolves when the load-time closure write fails', async () => {
    mockSet.mockRejectedValue(new Error('set failed'));

    await expect(runLockUpChecks()).resolves.toBeUndefined();
  });

  it("keeps writing on later ticks after a tick's write fails", async () => {
    await runLockUpChecks();
    expect(mockSet).toHaveBeenCalledTimes(1);

    mockSet.mockRejectedValueOnce(new Error('set failed'));

    await jest.advanceTimersByTimeAsync(CHECK_PAGES_EXIST);
    await jest.advanceTimersByTimeAsync(CHECK_PAGES_EXIST);

    expect(mockSet).toHaveBeenCalledTimes(3);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenCalledWith('wakeup');
  });

  it('still writes the closure time when the wake-up message fails', async () => {
    mockSendMessage.mockRejectedValue(new Error('wakeup failed'));

    await runLockUpChecks();
    await jest.advanceTimersByTimeAsync(CHECK_PAGES_EXIST);

    expect(mockSet).toHaveBeenCalledTimes(2);
  });

  it('reads chrome.runtime.lastError when the background connection disconnects', async () => {
    await runLockUpChecks();
    const onDisconnect = mockOnDisconnectAddListener.mock.calls[0][0];

    const lastErrorSpy = jest.spyOn(globalThis.chrome.runtime, 'lastError', 'get');
    onDisconnect();

    expect(lastErrorSpy).toHaveBeenCalledTimes(1);
  });
});
