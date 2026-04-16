/**
 * C5 regression test — the transaction-processor wedge.
 *
 * Round-1 review found that `startTransactionProcessing()` set
 * `isProcessing = true` and THEN called `await getBrowser()` OUTSIDE
 * the try/finally. If `getBrowser()` rejected (which is exactly the
 * case the lazy `webextension-polyfill` load is defending against on
 * mobile / desktop builds), the function rejected with `isProcessing`
 * stuck at true, wedging the processor permanently for the rest of
 * the app lifetime.
 *
 * The fix: move `getBrowser()` inside the try so the finally always
 * resets `isProcessing`. This file locks that behavior.
 */

const mockAlarmsCreate = jest.fn();
const mockAlarmsClear = jest.fn();
const mockAlarmsOnAlarm = { addListener: jest.fn() };

// The real webextension-polyfill module shape. Tests override the
// import behavior in specific cases to force rejection.
const mockPolyfill = {
  alarms: {
    create: (...args: unknown[]) => mockAlarmsCreate(...args),
    clear: (...args: unknown[]) => mockAlarmsClear(...args),
    onAlarm: mockAlarmsOnAlarm
  }
};

jest.mock('webextension-polyfill', () => mockPolyfill);

const mockSafeGenerateTransactionsLoop = jest.fn();
const mockGetAllUncompletedTransactions = jest.fn();
const mockHasQueuedTransactions = jest.fn();
const mockRetryPendingTransports = jest.fn().mockResolvedValue(undefined);

// transaction-processor.ts imports directly from lib/miden/activity/transactions
// (not the activity/index re-export) to avoid a circular init deadlock in the
// Vite SW bundle. Mock the same path so the real transactions.ts (which pulls
// in lib/store → real intercom) isn't loaded.
jest.mock('lib/miden/activity/transactions', () => ({
  safeGenerateTransactionsLoop: (...args: unknown[]) => mockSafeGenerateTransactionsLoop(...args),
  getAllUncompletedTransactions: (...args: unknown[]) => mockGetAllUncompletedTransactions(...args),
  hasQueuedTransactions: (...args: unknown[]) => mockHasQueuedTransactions(...args),
  retryPendingTransports: (...args: unknown[]) => mockRetryPendingTransports(...args)
}));

const mockWithUnlocked = jest.fn();
jest.mock('./store', () => ({
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

const mockIntercomBroadcast = jest.fn();
jest.mock('./defaults', () => ({
  getIntercom: () => ({ broadcast: mockIntercomBroadcast })
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockGetAllUncompletedTransactions.mockResolvedValue([]);
  mockSafeGenerateTransactionsLoop.mockResolvedValue({ success: true });
  mockHasQueuedTransactions.mockResolvedValue(false);
});

/** Flush a few microtask / macrotask ticks so in-flight awaits can progress. */
async function flushAsync() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

describe('startTransactionProcessing — happy path', () => {
  it('creates the keepalive alarm, runs the loop, clears the alarm, and resets isProcessing', async () => {
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();
    expect(mockAlarmsCreate).toHaveBeenCalledWith(
      'miden-tx-processor',
      expect.objectContaining({ periodInMinutes: 0.4 })
    );
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalled();
    expect(mockAlarmsClear).toHaveBeenCalledWith('miden-tx-processor');

    // Subsequent call should run again (isProcessing was reset).
    await mod.startTransactionProcessing();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent calls via the isProcessing flag', async () => {
    // Make the loop wait long enough that a second caller arrives
    // while the first is still in flight.
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockSafeGenerateTransactionsLoop.mockImplementation(async () => {
      await gate;
      return { success: true };
    });

    const mod = await import('./transaction-processor');
    const first = mod.startTransactionProcessing();
    // Let the first call progress through its getBrowser / alarms
    // setup and reach the awaited loop before issuing the second.
    await flushAsync();
    // Second call should no-op (isProcessing is true).
    await mod.startTransactionProcessing();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);

    release();
    await first;
  });
});

describe('C5 regression: getBrowser / loop rejections do not wedge isProcessing', () => {
  it('still resets isProcessing when the loop throws synchronously', async () => {
    mockSafeGenerateTransactionsLoop.mockImplementationOnce(() => {
      throw new Error('sync throw inside loop');
    });
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();

    // If isProcessing was stuck at true, the second call would no-op
    // and safeGenerateTransactionsLoop would only be called once.
    mockSafeGenerateTransactionsLoop.mockResolvedValueOnce({ success: true });
    await mod.startTransactionProcessing();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
  });

  it('still resets isProcessing when the loop rejects asynchronously', async () => {
    mockSafeGenerateTransactionsLoop.mockRejectedValueOnce(new Error('async boom'));
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();

    mockSafeGenerateTransactionsLoop.mockResolvedValueOnce({ success: true });
    await mod.startTransactionProcessing();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
  });

  it('still completes successfully when alarms.create throws (mobile / desktop — no alarms API)', async () => {
    mockAlarmsCreate.mockImplementationOnce(() => {
      throw new Error('no alarms API');
    });
    const mod = await import('./transaction-processor');
    // Should not reject — the alarm error is treated as a non-extension
    // context and the loop still runs.
    await expect(mod.startTransactionProcessing()).resolves.toBeUndefined();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalled();

    // And the next call should also run (isProcessing was reset).
    await mod.startTransactionProcessing();
    expect(mockSafeGenerateTransactionsLoop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('still completes when alarms.clear throws in the finally block', async () => {
    mockAlarmsClear.mockImplementationOnce(() => {
      throw new Error('clear denied');
    });
    const mod = await import('./transaction-processor');
    await expect(mod.startTransactionProcessing()).resolves.toBeUndefined();
    // isProcessing still got reset — next run triggers the loop again.
    await mod.startTransactionProcessing();
    expect(mockSafeGenerateTransactionsLoop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('setupTransactionProcessor', () => {
  it('registers an alarm listener on startup', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    // The listener is registered inside a lazy async IIFE that awaits
    // a dynamic import — needs several task ticks to settle.
    await flushAsync();
    expect(mockAlarmsOnAlarm.addListener).toHaveBeenCalled();
  });

  it('auto-resumes processing when hasQueuedTransactions() reports true', async () => {
    mockHasQueuedTransactions.mockResolvedValue(true);
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    // Drain the promise chain (hasQueuedTransactions → then → startTransactionProcessing).
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalled();
  });

  it('handles hasQueuedTransactions rejection gracefully', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    mockHasQueuedTransactions.mockRejectedValue(new Error('db error'));
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    expect(warnSpy).toHaveBeenCalledWith('[TransactionProcessor] Startup check error:', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('startTransactionProcessing — broadcast and retry loop', () => {
  it('broadcasts SyncCompleted after each loop iteration', async () => {
    mockGetAllUncompletedTransactions.mockResolvedValue([]);
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();
    expect(mockIntercomBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: expect.any(String) }));
  });

  it('continues loop when broadcast throws (no frontends connected)', async () => {
    mockIntercomBroadcast.mockImplementationOnce(() => {
      throw new Error('no ports');
    });
    mockGetAllUncompletedTransactions.mockResolvedValue([]);
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalled();
  });

  it('retries when uncompleted transactions remain and breaks when they clear', async () => {
    // First iteration: transactions remain. Second: they clear.
    mockGetAllUncompletedTransactions.mockResolvedValueOnce([{ id: 'tx1' }]).mockResolvedValueOnce([]);
    // Use fake timers to skip the 5s delay between retries
    jest.useFakeTimers();
    const mod = await import('./transaction-processor');
    const promise = mod.startTransactionProcessing();
    // Advance past the 5-second sleep between iterations
    await jest.advanceTimersByTimeAsync(6000);
    await promise;
    jest.useRealTimers();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
  });
});
