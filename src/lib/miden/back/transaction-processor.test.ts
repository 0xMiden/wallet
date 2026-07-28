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
const mockStorageGet = jest.fn();
const mockStorageSet = jest.fn();
const mockStorageRemove = jest.fn();

// The real webextension-polyfill module shape. Tests override the
// import behavior in specific cases to force rejection.
const mockPolyfill = {
  alarms: {
    create: (...args: unknown[]) => mockAlarmsCreate(...args),
    clear: (...args: unknown[]) => mockAlarmsClear(...args),
    onAlarm: mockAlarmsOnAlarm
  },
  storage: {
    local: {
      get: (...args: unknown[]) => mockStorageGet(...args),
      set: (...args: unknown[]) => mockStorageSet(...args),
      remove: (...args: unknown[]) => mockStorageRemove(...args)
    }
  }
};

jest.mock('webextension-polyfill', () => mockPolyfill);

const mockSafeGenerateTransactionsLoop = jest.fn();
const mockGetAllUncompletedTransactions = jest.fn();
const mockCancelStuckTransactions = jest.fn();

// transaction-processor.ts imports directly from lib/miden/transaction
// (not the activity/index re-export) to avoid a circular init deadlock in the
// Vite SW bundle. Mock the same path so the real transactions.ts (which pulls
// in lib/store → real intercom) isn't loaded.
jest.mock('lib/miden/transaction', () => ({
  safeGenerateTransactionsLoop: (...args: unknown[]) => mockSafeGenerateTransactionsLoop(...args),
  getAllUncompletedTransactions: (...args: unknown[]) => mockGetAllUncompletedTransactions(...args),
  cancelStuckTransactions: (...args: unknown[]) => mockCancelStuckTransactions(...args)
}));

const mockDbOpen = jest.fn();
jest.mock('lib/miden/repo', () => ({
  db: { open: (...args: unknown[]) => mockDbOpen(...args) }
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
  mockCancelStuckTransactions.mockResolvedValue(undefined);
  mockDbOpen.mockResolvedValue(undefined);
  mockStorageGet.mockResolvedValue({});
  mockStorageSet.mockResolvedValue(undefined);
  mockStorageRemove.mockResolvedValue(undefined);
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
  it('registers an alarm listener and creates the self-heal alarm on startup', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    // The listener is registered inside a lazy async IIFE that awaits
    // a dynamic import — needs several task ticks to settle.
    await flushAsync();
    expect(mockAlarmsOnAlarm.addListener).toHaveBeenCalled();
    expect(mockAlarmsCreate).toHaveBeenCalledWith(
      'miden-tx-stuck-heal',
      expect.objectContaining({ periodInMinutes: expect.any(Number) })
    );
  });

  it('auto-resumes processing when getAllUncompletedTransactions() reports queued or generating txs', async () => {
    // Issue #216 — the previous gate was `hasQueuedTransactions()` (Queued only),
    // so an SW death mid-`sendTransaction` left the orphan in `GeneratingTransaction`
    // status invisible to startup recovery. The new gate uses
    // `getAllUncompletedTransactions` which returns both statuses, so the orphan
    // is reaped by `safeGenerateTransactionsLoop` → `cancelStuckTransactions` on
    // the next SW spawn.
    mockGetAllUncompletedTransactions.mockResolvedValue([{ id: 'orphan', status: 1 }]);
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    // Drain the promise chain (getAllUncompletedTransactions → then → startTransactionProcessing).
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalled();
  });

  it('does not auto-resume when there are no uncompleted transactions', async () => {
    mockGetAllUncompletedTransactions.mockResolvedValue([]);
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).not.toHaveBeenCalled();
  });

  it('runs an initial self-heal sweep at startup so aged-out orphans are reaped without an alarm tick', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    expect(mockCancelStuckTransactions).toHaveBeenCalled();
  });

  it('fires cancelStuckTransactions when the self-heal alarm ticks', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    // Reset to drop the startup-sweep call so we only count the alarm-driven one.
    mockCancelStuckTransactions.mockClear();
    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];
    listener({ name: 'miden-tx-stuck-heal' });
    expect(mockCancelStuckTransactions).toHaveBeenCalled();
  });

  it('re-opens Dexie and retries the heal once when it hits DatabaseClosedError (issue #254)', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    mockCancelStuckTransactions.mockClear();
    mockDbOpen.mockClear();

    // An MV3 SW respawn can leave a stale/closed Dexie handle; the first read
    // rejects with DatabaseClosedError, the retry after re-open succeeds.
    const dbClosed = new Error('database is closed');
    dbClosed.name = 'DatabaseClosedError';
    mockCancelStuckTransactions.mockRejectedValueOnce(dbClosed).mockResolvedValueOnce(undefined);

    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];
    listener({ name: 'miden-tx-stuck-heal' });
    await flushAsync();

    expect(mockDbOpen).toHaveBeenCalledTimes(1);
    expect(mockCancelStuckTransactions).toHaveBeenCalledTimes(2);
    // A recovered heal must not escalate — no diagnostic gets persisted.
    expect(mockStorageSet).not.toHaveBeenCalled();
  });

  it('persists a diagnostic to chrome.storage.local when the heal keeps failing after re-open (issue #254)', async () => {
    // The Segment escalation the PR originally used is dead in the shipped SW
    // build (`back/analytics.ts` throws without ALEO_WALLET_SEGMENT_WRITE_KEY,
    // which the background Vite build never defines), so a persistently-wedged
    // heal must be recorded to `chrome.storage.local` — a sink that actually
    // works in the MV3 SW and survives a broken IndexedDB.
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    mockCancelStuckTransactions.mockClear();
    mockStorageSet.mockClear();

    const dbClosed = new Error('database is closed');
    dbClosed.name = 'DatabaseClosedError';
    // Rejects persistently — the re-open + retry still fails.
    mockCancelStuckTransactions.mockRejectedValue(dbClosed);

    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];
    listener({ name: 'miden-tx-stuck-heal' });
    await flushAsync();

    expect(mockStorageSet).toHaveBeenCalledWith(
      expect.objectContaining({
        stuckTxHealDiagnostic: expect.objectContaining({
          message: expect.stringContaining('DatabaseClosedError'),
          consecutiveFailures: 1,
          lastFailureAt: expect.any(Number)
        })
      })
    );
  });

  it('increments the consecutiveFailures counter across repeated persistent heal failures (issue #254)', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    mockCancelStuckTransactions.mockClear();
    mockStorageSet.mockClear();

    // A prior diagnostic already exists from earlier failed ticks.
    mockStorageGet.mockResolvedValue({
      stuckTxHealDiagnostic: { lastFailureAt: 1, message: 'old failure', consecutiveFailures: 4 }
    });
    mockCancelStuckTransactions.mockRejectedValueOnce(new Error('still broken'));

    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];
    listener({ name: 'miden-tx-stuck-heal' });
    await flushAsync();

    expect(mockStorageSet).toHaveBeenCalledWith(
      expect.objectContaining({
        stuckTxHealDiagnostic: expect.objectContaining({ consecutiveFailures: 5 })
      })
    );
  });

  it('clears the persisted diagnostic on a successful heal so consecutiveFailures is truly consecutive (issue #254)', async () => {
    // Without a clear-on-success, `consecutiveFailures` is really a monotonic
    // total: a recovered DB would leave a stale record lingering forever,
    // implying a wedged heal that has actually healed. A successful heal must
    // remove the diagnostic key so the counter is truly consecutive.
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];

    // A tick fails and persists the diagnostic...
    mockCancelStuckTransactions.mockRejectedValueOnce(new Error('still broken'));
    mockStorageSet.mockClear();
    listener({ name: 'miden-tx-stuck-heal' });
    await flushAsync();
    expect(mockStorageSet).toHaveBeenCalled();

    // ...then a later tick succeeds and must clear the lingering diagnostic.
    mockStorageRemove.mockClear();
    mockCancelStuckTransactions.mockResolvedValueOnce(undefined);
    listener({ name: 'miden-tx-stuck-heal' });
    await flushAsync();

    expect(mockStorageRemove).toHaveBeenCalledWith('stuckTxHealDiagnostic');
  });

  it('clears the persisted diagnostic when the heal succeeds after a Dexie re-open (issue #254)', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    mockCancelStuckTransactions.mockClear();
    mockStorageRemove.mockClear();

    // First read rejects with DatabaseClosedError; the retry after re-open
    // succeeds — the post-reopen success path must also clear the diagnostic.
    const dbClosed = new Error('database is closed');
    dbClosed.name = 'DatabaseClosedError';
    mockCancelStuckTransactions.mockRejectedValueOnce(dbClosed).mockResolvedValueOnce(undefined);

    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];
    listener({ name: 'miden-tx-stuck-heal' });
    await flushAsync();

    expect(mockStorageRemove).toHaveBeenCalledWith('stuckTxHealDiagnostic');
  });

  it('escalates a non-DatabaseClosedError without attempting a Dexie re-open (issue #254)', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    mockCancelStuckTransactions.mockClear();
    mockDbOpen.mockClear();
    mockStorageSet.mockClear();

    mockCancelStuckTransactions.mockRejectedValueOnce(new Error('some other failure'));

    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];
    listener({ name: 'miden-tx-stuck-heal' });
    await flushAsync();

    expect(mockDbOpen).not.toHaveBeenCalled();
    expect(mockStorageSet).toHaveBeenCalledWith(expect.objectContaining({ stuckTxHealDiagnostic: expect.any(Object) }));
  });

  it('keepalive alarm tick does not invoke cancelStuckTransactions', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    mockCancelStuckTransactions.mockClear();
    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];
    listener({ name: 'miden-tx-processor' });
    expect(mockCancelStuckTransactions).not.toHaveBeenCalled();
  });

  it('handles getAllUncompletedTransactions rejection gracefully', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    mockGetAllUncompletedTransactions.mockRejectedValue(new Error('db error'));
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    expect(warnSpy).toHaveBeenCalledWith('[TransactionProcessor] Startup check error:', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('vaultGuardianProvider — locked-vault guard (#313)', () => {
  it('getAccounts throws a locked-classified error (not a raw null-deref) when the vault is locked', async () => {
    // Simulate a LOCKED wallet: `inited === true` but `vault === null`.
    // The real `withUnlocked` only asserts `inited`, so it invokes the
    // factory with a null vault — the exact state a background Guardian
    // consume hits when the wallet is locked.
    mockWithUnlocked.mockImplementation((fn: (ctx: { vault: unknown }) => unknown) => fn({ vault: null }));
    const mod = await import('./transaction-processor');

    let caught: unknown;
    try {
      await mod.vaultGuardianProvider.getAccounts();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Recognisable "locked" signal so the transaction loop DEFERS (requeues)
    // the tx for retry after unlock…
    expect(message).toMatch(/locked/i);
    expect((caught as { reason?: string }).reason).toBe('locked');
    // …instead of the opaque null-vault TypeError the unguarded path threw,
    // which the loop could not classify and so cancelled the tx.
    expect(message).not.toMatch(/Cannot read propert/i);
  });

  it('swSignCallback throws a locked-classified error (not a raw null-deref) when the vault is locked at sign time', async () => {
    // The sign step of a background Guardian consume: `getAccounts` already
    // passed (live vault) but an auto-lock nulled the vault before
    // `executeTransaction` invoked the sign callback. `withUnlocked` only
    // asserts `inited`, so it hands the factory a null vault. An unguarded
    // `vault.signTransaction(...)` would throw the opaque
    // `TypeError: Cannot read properties of null` — which the guardian catch
    // cannot classify as locked, so the tx is Failed and the note-claim lost.
    mockWithUnlocked.mockImplementation((fn: (ctx: { vault: unknown }) => unknown) => fn({ vault: null }));
    const mod = await import('./transaction-processor');

    let caught: unknown;
    try {
      await mod.swSignCallback('pubkey-hex', 'signing-inputs-hex');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Recognisable "locked" signal (matched by `isLockedError`) so the guardian
    // catch re-throws and the loop DEFERS the tx for retry after unlock…
    expect(message).toMatch(/locked/i);
    expect((caught as { reason?: string }).reason).toBe('locked');
    // …not the opaque null-vault TypeError the unguarded sign path threw.
    expect(message).not.toMatch(/Cannot read propert/i);
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
