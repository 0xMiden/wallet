/**
 * C5 regression test — the transaction-processor wedge.
 *
 * Round-1 review found that `startTransactionProcessing()` set
 * `isProcessing = true` and THEN called `await getBrowser()` OUTSIDE
 * the try/finally. If `getBrowser()` rejected (which is exactly the
 * case the lazy `webextension-polyfill` load is defending against on
 * desktop builds), the function rejected with `isProcessing`
 * stuck at true, wedging the processor permanently for the rest of
 * the app lifetime.
 *
 * The fix: move `getBrowser()` inside the try so the finally always
 * resets `isProcessing`. This file locks that behavior.
 */

import { ITransactionStatus } from 'lib/miden/db/types';

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
const mockNextQueuedWakeDelayMs = jest.fn();
const mockIsQueuedRowReady = jest.fn();
const mockGuardianCandidateRelease = jest.fn();

// Indirection so a test can simulate the Vite SW build's async-init window
// (`safeGenerateTransactionsLoop` not yet a function) by setting this to
// `undefined`, then restore it. A getter on the mock (below) reads this on
// every access, matching the live-binding property read the compiled source
// does at each `typeof safeGenerateTransactionsLoop` check.
let mockSafeGenerateTransactionsLoopFn: ((...args: unknown[]) => unknown) | undefined = (...args: unknown[]) =>
  mockSafeGenerateTransactionsLoop(...args);

// transaction-processor.ts imports directly from lib/miden/transaction
// (not the activity/index re-export) to avoid a circular init deadlock in the
// Vite SW bundle. Mock the same path so the real transactions.ts (which pulls
// in lib/store → real intercom) isn't loaded.
jest.mock('lib/miden/transaction', () => ({
  get safeGenerateTransactionsLoop() {
    return mockSafeGenerateTransactionsLoopFn;
  },
  getAllUncompletedTransactions: (...args: unknown[]) => mockGetAllUncompletedTransactions(...args),
  cancelStuckTransactions: (...args: unknown[]) => mockCancelStuckTransactions(...args),
  nextQueuedWakeDelayMs: (...args: unknown[]) => mockNextQueuedWakeDelayMs(...args),
  isQueuedRowReady: (...args: unknown[]) => mockIsQueuedRowReady(...args),
  guardianCandidateRelease: (...args: unknown[]) => mockGuardianCandidateRelease(...args)
}));

const mockReconcileUnconfirmedTransactions = jest.fn();
jest.mock('lib/miden/transaction/reconcile-unconfirmed', () => ({
  reconcileUnconfirmedTransactions: (...args: unknown[]) => mockReconcileUnconfirmedTransactions(...args)
}));

const mockDbOpen = jest.fn();
jest.mock('lib/miden/repo', () => ({
  db: { open: (...args: unknown[]) => mockDbOpen(...args) }
}));

const mockIsExtension = jest.fn();
jest.mock('lib/platform', () => ({
  isExtension: (...args: unknown[]) => mockIsExtension(...args)
}));

const mockWithUnlocked = jest.fn();
jest.mock('./store', () => ({
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn),
  accountsUpdated: jest.fn()
}));

/**
 * A `withUnlocked` mock that behaves like the real one for a LOCKED wallet:
 * `assertUnlocked` refuses to run the factory and throws a `reason: 'locked'`
 * error (see `back/store.ts`). Used instead of handing the factory `{vault: null}`
 * — that shape is unreachable in production now that the gate exists.
 */
const lockedWithUnlocked = () => {
  mockWithUnlocked.mockImplementation(() => {
    throw Object.assign(new Error('Wallet is locked'), { reason: 'locked' as const });
  });
};

const mockIntercomBroadcast = jest.fn();
jest.mock('./defaults', () => ({
  getIntercom: () => ({ broadcast: mockIntercomBroadcast })
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockWithUnlocked.mockReset();
  mockSafeGenerateTransactionsLoopFn = (...args: unknown[]) => mockSafeGenerateTransactionsLoop(...args);
  mockGetAllUncompletedTransactions.mockResolvedValue([]);
  mockSafeGenerateTransactionsLoop.mockResolvedValue({ success: true });
  mockCancelStuckTransactions.mockResolvedValue(undefined);
  mockNextQueuedWakeDelayMs.mockReturnValue(undefined);
  mockIsQueuedRowReady.mockReturnValue(false);
  // Extension-context by default: matches the pre-existing tests in this file, which assume `browser`
  // resolves non-null (the default polyfill mock doesn't throw) and drive the service worker's own behavior.
  mockIsExtension.mockReturnValue(true);
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

  it('runs one loop at a time and honours calls made during it with one more pass', async () => {
    // Make the loop wait long enough that more callers arrive
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
    // setup and reach the awaited loop before issuing the others.
    await flushAsync();
    // Calls during the run start no loop of their own; they are recorded
    // once and honoured with one more pass when the run ends (#907).
    await mod.startTransactionProcessing();
    await mod.startTransactionProcessing();
    await mod.startTransactionProcessing();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);

    release();
    await first;
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
  });
});

describe('C5 regression: getBrowser / loop rejections do not wedge isProcessing', () => {
  afterEach(() => {
    mockAlarmsClear.mockReset();
  });

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

  it('still completes successfully when alarms.create throws (desktop - no alarms API)', async () => {
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
    // By name: a run also clears the queued-row wake when it starts, and that is not the clear under test.
    mockAlarmsClear.mockImplementation((name: unknown) => {
      if (name === 'miden-tx-processor') throw new Error('clear denied');
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
    // The transaction analytics sink the PR originally escalated to was removed
    // (it was dead Aleo-era code), so a persistently-wedged heal must be recorded
    // to `chrome.storage.local` — a sink that actually works in the MV3 SW and
    // survives a broken IndexedDB.
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
    // A LOCKED wallet: `inited === true` but `vault === null`. `assertUnlocked`
    // rejects that state outright — the exact situation a background Guardian
    // consume hits when the wallet auto-locks mid-run.
    lockedWithUnlocked();
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
    // `executeTransaction` invoked the sign callback. `assertUnlocked` stops the
    // factory before it can dereference the null vault; the callback must let
    // that locked-classified error through rather than wrapping it into
    // something the guardian catch cannot classify (which would Fail the tx and
    // lose the note-claim).
    lockedWithUnlocked();
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

describe('vaultGuardianProvider.swapHotKey', () => {
  const vaultSwapping = () => {
    const swapHotKey = jest.fn(async () => ({ accounts: [], currentAccount: undefined }));
    mockWithUnlocked.mockImplementation((fn: (ctx: unknown) => unknown) => fn({ vault: { swapHotKey } }));
    return swapHotKey;
  };

  it('passes the expectation to the vault (#1233)', async () => {
    const swapHotKey = vaultSwapping();
    const mod = await import('./transaction-processor');

    await mod.vaultGuardianProvider.swapHotKey?.('acc', 'new-pub', 'old-pub');

    expect(swapHotKey).toHaveBeenCalledWith('acc', 'new-pub', 'old-pub');
  });

  it('passes no expectation when the caller passes none (#1233)', async () => {
    const swapHotKey = vaultSwapping();
    const mod = await import('./transaction-processor');

    await mod.vaultGuardianProvider.swapHotKey?.('acc', 'new-pub');

    expect(swapHotKey).toHaveBeenCalledWith('acc', 'new-pub', undefined);
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

  it('runs one more pass when a kick arrives while the loop is finishing (#907)', async () => {
    const mod = await import('./transaction-processor');
    // The kick lands inside the queue check that ends the loop's only pass,
    // i.e. after the last safeGenerateTransactionsLoop call but before this
    // run clears isProcessing - exactly the window issue #907 loses.
    mockGetAllUncompletedTransactions.mockImplementationOnce(async () => {
      void mod.startTransactionProcessing();
      return [];
    });
    await mod.startTransactionProcessing();
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
    // Each of the two runs (the original pass and the kicked restart) creates
    // and clears its own keepalive alarm.
    expect(mockAlarmsCreate).toHaveBeenCalledTimes(2);
    expect(mockAlarmsClear.mock.calls.filter(([name]) => name === 'miden-tx-processor')).toHaveLength(2);
  });

  it('runs no extra pass when nothing kicks during the loop', async () => {
    mockGetAllUncompletedTransactions.mockResolvedValue([]);
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);
  });

  it('runs a third pass when a kick arrives during the restarted run too (#907)', async () => {
    const mod = await import('./transaction-processor');
    // Run 1's queue check kicks run 2 (the restart); run 2's own queue check
    // kicks run 3 - the restart pass must honour a kick just as the first run does.
    mockGetAllUncompletedTransactions
      .mockImplementationOnce(async () => {
        void mod.startTransactionProcessing();
        return [];
      })
      .mockImplementationOnce(async () => {
        void mod.startTransactionProcessing();
        return [];
      });
    await mod.startTransactionProcessing();
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(3);
  });
});

describe('startTransactionProcessing - module-init timeout honours its own kick (#907 follow-up)', () => {
  it('starts exactly one more run when a kick is recorded during a full init-timeout wait', async () => {
    // Module unavailable for the whole first wait, so this run's 60s wait
    // times out without ever finding safeGenerateTransactionsLoop.
    mockSafeGenerateTransactionsLoopFn = undefined;
    jest.useFakeTimers();

    const mod = await import('./transaction-processor');
    const firstRun = mod.startTransactionProcessing();
    // The synchronous prefix of the call above (the isProcessing check, then
    // setting it true) has already run by this point, so the kick below
    // correctly hits the "already processing" branch instead of racing it.
    const kick = mod.startTransactionProcessing();

    // Advance through exactly the 60s wait: the module never becomes
    // available, so the timeout branch fires and, seeing the recorded kick,
    // starts a fresh run instead of dropping it.
    await jest.advanceTimersByTimeAsync(60000);
    await firstRun;
    await kick;
    expect(mockSafeGenerateTransactionsLoop).not.toHaveBeenCalled();

    // The module becomes available once the restarted run's own wait begins;
    // its next 500ms check finds it and proceeds to loop, with no further kick.
    mockSafeGenerateTransactionsLoopFn = (...args: unknown[]) => mockSafeGenerateTransactionsLoop(...args);
    mockGetAllUncompletedTransactions.mockResolvedValue([]);
    await jest.advanceTimersByTimeAsync(600);
    jest.useRealTimers();
    await flushAsync();

    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);
  });
});

// #924: a run that spends its pass budget on claims queued against a locked vault ends with them still
// queued, and the unlock's kick is what brings them back. The #907 kick tests above all end through the
// empty-queue break; this one ends on the budget, the path an unlock actually meets.
describe('a kick after a run spent its budget on queued claims', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts one more full run when it lands in the run's last wait", async () => {
    mockGetAllUncompletedTransactions.mockResolvedValue([{ id: 'claim' }]);
    jest.useFakeTimers();
    const mod = await import('./transaction-processor');
    const run = mod.startTransactionProcessing();
    await jest.advanceTimersByTimeAsync(5000 * 59);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(60);
    // The budget is spent and the claim is still queued: the run is in its final wait before it stops.
    void mod.startTransactionProcessing();
    await jest.advanceTimersByTimeAsync(5000 * 200);
    await run;
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(60 + 60);
  });
});

// #1223: a run stops after 60 passes, and a row its guardian backed off can come due only after that. With the popup
// closed nothing else restarts processing, so the run's end arms a one-shot alarm for the soonest Queued row.
describe('a one-shot wake for rows still queued when a run ends (#1223)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('arms the wake at the time the helper gives when the run ends at its pass cap', async () => {
    jest.useFakeTimers();
    const start = Date.now();
    const nowSec = Math.floor(start / 1000);
    const backedOff = {
      id: 'claim',
      status: ITransactionStatus.Queued,
      initiatedAt: nowSec,
      nextEligibleAt: nowSec + 600
    };
    mockGetAllUncompletedTransactions.mockResolvedValue([backedOff]);
    mockNextQueuedWakeDelayMs.mockReturnValue(90_000);
    const mod = await import('./transaction-processor');
    const run = mod.startTransactionProcessing();
    await jest.advanceTimersByTimeAsync(5000 * 60);
    await run;
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(60);
    expect(mockNextQueuedWakeDelayMs).toHaveBeenCalledWith([backedOff]);
    expect(mockAlarmsCreate).toHaveBeenCalledWith('miden-tx-queued-wake', { when: start + 5000 * 60 + 90_000 });
  });

  it('starts processing when the wake fires', async () => {
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).not.toHaveBeenCalled();
    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];
    listener({ name: 'miden-tx-queued-wake' });
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);
  });

  it('does not start processing when the wake fires after the vault locked in the meantime', async () => {
    mockNextQueuedWakeDelayMs.mockReturnValue(90_000);
    const mod = await import('./transaction-processor');
    mod.setupTransactionProcessor();
    await flushAsync();
    const listener = mockAlarmsOnAlarm.addListener.mock.calls[0][0];

    // Arm the wake while unlocked, the way a run ending with queued rows does.
    await mod.startTransactionProcessing();
    expect(mockAlarmsCreate).toHaveBeenCalledWith('miden-tx-queued-wake', expect.anything());
    mockSafeGenerateTransactionsLoop.mockClear();

    // The vault locks before the alarm fires.
    lockedWithUnlocked();
    listener({ name: 'miden-tx-queued-wake' });
    await flushAsync();
    expect(mockSafeGenerateTransactionsLoop).not.toHaveBeenCalled();
  });

  it('arms nothing when the run ends with no uncompleted rows', async () => {
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();
    expect(mockNextQueuedWakeDelayMs).toHaveBeenCalledWith([]);
    expect(mockAlarmsCreate).not.toHaveBeenCalledWith('miden-tx-queued-wake', expect.anything());
  });

  it('clears a pending wake before a run starts its first pass', async () => {
    let clearedBeforeFirstPass = false;
    mockSafeGenerateTransactionsLoop.mockImplementationOnce(async () => {
      clearedBeforeFirstPass = mockAlarmsClear.mock.calls.some(([name]) => name === 'miden-tx-queued-wake');
      return { success: true };
    });
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();
    expect(clearedBeforeFirstPass).toBe(true);
  });

  it('arms no wake while the vault is locked, since unlocking restarts processing (#924)', async () => {
    lockedWithUnlocked();
    mockNextQueuedWakeDelayMs.mockReturnValue(90_000);
    const mod = await import('./transaction-processor');
    await mod.startTransactionProcessing();
    expect(mockAlarmsCreate).not.toHaveBeenCalledWith('miden-tx-queued-wake', expect.anything());
  });

  it('arms no wake off the extension (isExtension() false, mobile-shaped: polyfill mock still loads) (#1266)', async () => {
    jest.useFakeTimers();
    mockIsExtension.mockReturnValue(false);
    const nowSec = Math.floor(Date.now() / 1000);
    const backedOff = {
      id: 'claim',
      status: ITransactionStatus.Queued,
      initiatedAt: nowSec,
      nextEligibleAt: nowSec + 600
    };
    mockGetAllUncompletedTransactions.mockResolvedValue([backedOff]);
    mockNextQueuedWakeDelayMs.mockReturnValue(90_000);
    const mod = await import('./transaction-processor');
    const run = mod.startTransactionProcessing();
    await jest.advanceTimersByTimeAsync(5000 * 60);
    await run;
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(60);
    expect(mockNextQueuedWakeDelayMs).not.toHaveBeenCalled();
    expect(mockAlarmsCreate).not.toHaveBeenCalledWith('miden-tx-queued-wake', expect.anything());
  });
});

// #1266: a pass that ran a row goes straight on to the next ready row; any other pass waits 5 s.
describe('the wait between passes (#1266)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  const queuedRow = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    status: ITransactionStatus.Queued,
    initiatedAt: Math.floor(Date.now() / 1000),
    ...extra
  });

  const startRun = async () => {
    const mod = await import('./transaction-processor');
    let settled = false;
    const run = mod.startTransactionProcessing().then(() => {
      settled = true;
    });
    return { run, isSettled: () => settled };
  };

  it('starts the next pass at once after a processed pass while a queued row is ready', async () => {
    jest.useFakeTimers();
    const startSec = Math.floor(Date.now() / 1000);
    const ready = queuedRow('ready');
    mockSafeGenerateTransactionsLoop.mockResolvedValue('processed');
    mockGetAllUncompletedTransactions.mockResolvedValueOnce([ready]).mockResolvedValueOnce([]);
    mockIsQueuedRowReady.mockReturnValue(true);
    const { run, isSettled } = await startRun();
    // 0 ms: microtasks only, so a wait put back before the next pass fails this.
    await jest.advanceTimersByTimeAsync(0);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
    expect(mockIsQueuedRowReady).toHaveBeenCalledWith(ready, startSec);
    expect(isSettled()).toBe(true);
    await run;
  });

  it('waits 5 s after a processed pass when no queued row is ready', async () => {
    jest.useFakeTimers();
    const startSec = Math.floor(Date.now() / 1000);
    const cooling = queuedRow('cooling', { nextEligibleAt: startSec + 600 });
    mockSafeGenerateTransactionsLoop.mockResolvedValue('processed');
    mockGetAllUncompletedTransactions.mockResolvedValueOnce([cooling]).mockResolvedValueOnce([]);
    const { run } = await startRun();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);
    expect(mockIsQueuedRowReady).toHaveBeenCalledWith(cooling, startSec);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
    await run;
  });

  it.each(['idle', 'failed', 'requeued'])(
    'waits 5 s after a pass that returned %s, even while a queued row is ready',
    async outcome => {
      jest.useFakeTimers();
      mockSafeGenerateTransactionsLoop.mockResolvedValue(outcome);
      mockGetAllUncompletedTransactions.mockResolvedValueOnce([queuedRow('ready')]).mockResolvedValueOnce([]);
      mockIsQueuedRowReady.mockReturnValue(true);
      const { run } = await startRun();
      await jest.advanceTimersByTimeAsync(4_999);
      expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
      await run;
    }
  );

  it('spends its 60 passes 5 s apart while the loop lock is held elsewhere and a row is ready', async () => {
    jest.useFakeTimers();
    mockSafeGenerateTransactionsLoop.mockResolvedValue('idle');
    mockGetAllUncompletedTransactions.mockResolvedValue([queuedRow('ready')]);
    mockIsQueuedRowReady.mockReturnValue(true);
    const { run } = await startRun();
    await jest.advanceTimersByTimeAsync(5000 * 59 - 1);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(59);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(60);
    await jest.advanceTimersByTimeAsync(5000);
    await run;
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(60);
  });

  it('mobile: still waits 5 s after a processed pass with a ready row (polyfill mock loads, isExtension() false)', async () => {
    jest.useFakeTimers();
    mockIsExtension.mockReturnValue(false);
    const ready = queuedRow('ready');
    mockSafeGenerateTransactionsLoop.mockResolvedValue('processed');
    mockGetAllUncompletedTransactions.mockResolvedValueOnce([ready]).mockResolvedValueOnce([]);
    mockIsQueuedRowReady.mockReturnValue(true);
    const { run } = await startRun();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
    await run;
  });

  it('desktop: still waits 5 s after a processed pass with a ready row (alarms.create throws, isExtension() false)', async () => {
    jest.useFakeTimers();
    mockIsExtension.mockReturnValue(false);
    mockAlarmsCreate.mockImplementationOnce(() => {
      throw new Error('no alarms API');
    });
    const ready = queuedRow('ready');
    mockSafeGenerateTransactionsLoop.mockResolvedValue('processed');
    mockGetAllUncompletedTransactions.mockResolvedValueOnce([ready]).mockResolvedValueOnce([]);
    mockIsQueuedRowReady.mockReturnValue(true);
    const { run } = await startRun();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSafeGenerateTransactionsLoop).toHaveBeenCalledTimes(2);
    await run;
  });
});

describe('reconcileUnconfirmedInWorker (#1081)', () => {
  it("runs the reconciler pass with a release built on the service worker's vault provider", async () => {
    const release = { abandon: jest.fn() };
    mockGuardianCandidateRelease.mockReturnValue(release);
    mockReconcileUnconfirmedTransactions.mockResolvedValue(undefined);
    const mod = await import('./transaction-processor');

    await mod.reconcileUnconfirmedInWorker();

    expect(mockGuardianCandidateRelease).toHaveBeenCalledWith(mod.vaultGuardianProvider);
    expect(mockReconcileUnconfirmedTransactions).toHaveBeenCalledTimes(1);
    expect(mockReconcileUnconfirmedTransactions).toHaveBeenCalledWith({ release });
  });
});
