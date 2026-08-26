/**
 * useSyncTrigger — the 3s chain-sync loop. Two branches:
 *   - Extension: posts SyncRequest to the SW, then runs Guardian sync
 *     in the frontend context.
 *   - Mobile/desktop: calls client.syncState() directly under the WASM
 *     lock, then Guardian sync outside the lock.
 *
 * The hook's React surface is small — most of the logic lives in the
 * effect body. We exercise both branches, the status gating, and the
 * Guardian sync skip.
 */

import React from 'react';

import { act, render, waitFor } from '@testing-library/react';

import {
  WasmClientPoisonedError,
  type WasmClientPoisonReason,
  WASM_LOCK_SYNC_WATCHDOG_MS
} from 'lib/miden/sdk/wasm-client-poison';
import { FUSED_SYNC_PROBE_INTERVAL_MS, MAX_SYNC_BACKOFF_MS } from 'lib/miden/sync-backoff';
import { WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { __resetSyncFuseStateForTests, requestImmediateSync, useSyncTrigger } from './useSyncTrigger';

const storeState: {
  status: WalletStatus;
  accounts: Array<{ publicKey: string; type: WalletType }>;
  setSyncStatus: jest.Mock;
} = {
  status: WalletStatus.Ready,
  accounts: [],
  setSyncStatus: jest.fn()
};

const mockIntercomRequest = jest.fn(async () => ({ type: 'ok' }));
const mockGetIntercom = jest.fn((..._args: unknown[]) => ({ request: mockIntercomRequest }));

jest.mock('lib/store', () => {
  // Zustand selector mock — reads the live storeState reference so test
  // mutations are reflected inside the component.
  const hook = (selector: (s: unknown) => unknown) => selector(storeState);
  (hook as unknown as { getState: () => unknown }).getState = () => storeState;
  return {
    useWalletStore: hook,
    getIntercom: (...args: unknown[]) => mockGetIntercom(...args)
  };
});

const mockSyncState = jest.fn(async (..._args: unknown[]) => {});
const mockGetMidenClient = jest.fn(async (..._args: unknown[]) => ({ syncState: mockSyncState }));
const wasmLockOptionsSeen: Array<unknown> = [];
// When true, every lock hold is evicted the way the real watchdog evicts one:
// `withWasmClientLock` races the operation against the abort, so the CALLER sees
// a rejection while the operation itself keeps running (#775 — an evicted hold
// is abandoned, not cancelled). Reproducing that split is the only way to test
// what the loop does when an abandoned sync settles after the loop gave up.
let evictEveryLockHold = false;
// Which mechanism the simulated eviction reports. The hook treats the two
// differently, so a test that could only present one would pin half the rule.
let evictionReason: WasmClientPoisonReason = 'watchdog';
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: (...args: unknown[]) => mockGetMidenClient(...args),
  // In .tsx `<T>` parses as JSX — the trailing comma disambiguates it as a generic.
  withWasmClientLock: async <T,>(fn: () => Promise<T>, options?: unknown) => {
    wasmLockOptionsSeen.push(options);
    const running = fn();
    if (evictEveryLockHold) {
      // Mirrors the real lock parking a handler on the abandoned operation.
      running.catch(() => {});
      // The REAL error class, not a look-alike with the right message: the hook
      // narrows on the class and then reads `reason` off it, so a hand-rolled
      // Error would only test the hook against a stub of its own predicate.
      throw new WasmClientPoisonedError(evictionReason);
    }
    return running;
  }
}));

const mockIsExtension = jest.fn((..._args: unknown[]) => false);
const mockIsMobile = jest.fn((..._args: unknown[]) => false);
jest.mock('lib/platform', () => ({
  isExtension: (...args: unknown[]) => mockIsExtension(...args),
  // useSyncTrigger skips the WASM sync while the transaction modal is up on mobile.
  isMobile: (...args: unknown[]) => mockIsMobile(...args)
}));

const mockSyncGuardianAccounts = jest.fn(async (..._args: unknown[]) => {});
jest.mock('./guardian-sync', () => ({
  syncGuardianAccounts: (...args: unknown[]) => mockSyncGuardianAccounts(...args)
}));

const mockMarkConnectivityIssue = jest.fn();
const mockClearReachabilityIssues = jest.fn();
jest.mock('lib/miden/activity/connectivity-state', () => ({
  markConnectivityIssue: (...args: unknown[]) => mockMarkConnectivityIssue(...args),
  clearReachabilityIssues: (...args: unknown[]) => mockClearReachabilityIssues(...args)
}));

const mockIsLikelyNetworkError = jest.fn((..._args: unknown[]) => true);
const mockClassifySyncError = jest.fn((..._args: unknown[]) => 'node');
jest.mock('lib/miden/activity/connectivity-classify', () => ({
  isLikelyNetworkError: (...args: unknown[]) => mockIsLikelyNetworkError(...args),
  classifySyncError: (...args: unknown[]) => mockClassifySyncError(...args)
}));

const mockRequestNotesRefresh = jest.fn();
jest.mock('./note-refresh', () => ({
  requestNotesRefresh: () => mockRequestNotesRefresh()
}));

const HookHost: React.FC = () => {
  useSyncTrigger();
  return null;
};

const flush = () => new Promise(res => setTimeout(res, 0));

describe('useSyncTrigger', () => {
  let envBeforeTest: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    window.location.hash = '';
    storeState.status = WalletStatus.Ready;
    storeState.accounts = [];
    mockIsExtension.mockReturnValue(false);
    // Restore a succeeding sync default (tests below install persistent
    // rejections that would otherwise leak into later tests).
    mockSyncState.mockReset();
    mockSyncState.mockResolvedValue(undefined);
    mockIsLikelyNetworkError.mockReturnValue(true);
    mockClassifySyncError.mockReturnValue('node');
    evictEveryLockHold = false;
    evictionReason = 'watchdog';
    // Every mobile/desktop test pushes here; reset centrally so the tests that
    // read it can assert on position rather than depending on being the only
    // writer since the last manual reset.
    wasmLockOptionsSeen.length = 0;
    // The fuse's evidence is module-scoped on purpose (it describes the realm's
    // parked sync, not one effect), so it survives an unmount — which means it
    // also survives a test unless reset here.
    __resetSyncFuseStateForTests();
    envBeforeTest = process.env.MIDEN_E2E_TEST;
  });

  // The breaker tests install fake timers and stub `Math.random`. Tearing those
  // down in the test body means one failed assertion leaks both into every later
  // test in the file, turning a single real failure into a cascade — and a
  // pinned `Math.random` is global, so the damage is not limited to timing.
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    // Restored centrally, not at the end of each test body: several tests set
    // these to reach a guarded branch, and a failed assertion before their own
    // restore line left `MIDEN_E2E_TEST` (or the pause flag) set for every later
    // test in the worker — which is the same cascade this hook was added to stop
    // for timers and mocks.
    if (envBeforeTest === undefined) delete process.env.MIDEN_E2E_TEST;
    else process.env.MIDEN_E2E_TEST = envBeforeTest;
    delete (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__;
  });

  it('does nothing when wallet status is not Ready', () => {
    storeState.status = WalletStatus.Locked;
    render(<HookHost />);
    expect(mockIntercomRequest).not.toHaveBeenCalled();
    expect(mockSyncState).not.toHaveBeenCalled();
  });

  it('extension: requests SyncRequest from the SW and skips Guardian sync when no Guardian accounts', async () => {
    mockIsExtension.mockReturnValue(true);

    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockIntercomRequest).toHaveBeenCalled());
    await flush();
    expect(mockSyncGuardianAccounts).not.toHaveBeenCalled();
    unmount();
  });

  it('extension: runs Guardian sync after chain sync when Guardian accounts exist', async () => {
    mockIsExtension.mockReturnValue(true);
    storeState.accounts = [{ publicKey: 'g1', type: WalletType.Guardian }];

    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockSyncGuardianAccounts).toHaveBeenCalledTimes(1));
    unmount();
  });

  it('extension: swallows Guardian sync errors so the chain-sync loop keeps running', async () => {
    mockIsExtension.mockReturnValue(true);
    storeState.accounts = [{ publicKey: 'g1', type: WalletType.Guardian }];
    mockSyncGuardianAccounts.mockRejectedValueOnce(new Error('guardian unreachable'));

    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockSyncGuardianAccounts).toHaveBeenCalled());
    unmount();
  });

  it('mobile/desktop: drives syncState directly and flips the store sync flag', async () => {
    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockSyncState).toHaveBeenCalled());
    // Flips sync status on and off around the call.
    expect(storeState.setSyncStatus).toHaveBeenCalledWith(true);
    await waitFor(() => expect(storeState.setSyncStatus).toHaveBeenCalledWith(false));
    unmount();
  });

  it('mobile/desktop: refreshes claimable notes after a successful sync (#462)', async () => {
    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockSyncState).toHaveBeenCalled());
    // A completed sync surfaces just-imported notes immediately, without waiting
    // out the claimable-notes SWR interval.
    await waitFor(() => expect(mockRequestNotesRefresh).toHaveBeenCalled());
    unmount();
  });

  it('mobile/desktop: runs immediately when the banner requests a retry', async () => {
    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(1));
    act(() => requestImmediateSync());

    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(2));
    unmount();
  });

  it('mobile/desktop: runs Guardian sync after chain sync when Guardian accounts exist', async () => {
    storeState.accounts = [{ publicKey: 'g1', type: WalletType.Guardian }];

    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockSyncGuardianAccounts).toHaveBeenCalled());
    unmount();
  });

  it('mobile/desktop: skips sync while the generating transaction page is active', async () => {
    window.location.hash = '#/generating-transaction-full';

    const { unmount } = render(<HookHost />);

    await flush();
    expect(mockSyncState).not.toHaveBeenCalled();
    unmount();
  });

  it('mobile/desktop: warns and recovers when syncState throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSyncState.mockRejectedValueOnce(new Error('offline'));

    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(warn).toHaveBeenCalled());
    // setSyncStatus(false) still runs in finally so the header spinner clears.
    await waitFor(() => expect(storeState.setSyncStatus).toHaveBeenCalledWith(false));
    warn.mockRestore();
    unmount();
  });

  it('mobile/desktop: bails out of runAndSchedule when unmount fires before the first tick', async () => {
    // Make the WASM lock wait until we explicitly resolve it, so we can
    // unmount between runAndSchedule starting and completing. The `cancelled`
    // flag then short-circuits the inner `if (!client || cancelled) return` branch.
    let releaseLock!: () => void;
    const lockGate = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    mockGetMidenClient.mockImplementationOnce(async () => {
      await lockGate;
      return { syncState: mockSyncState };
    });

    const { unmount } = render(<HookHost />);
    // Unmount before the lock releases, flipping `cancelled = true`.
    unmount();
    releaseLock();

    // Let any pending microtasks drain — syncState must not run because the
    // inner cancel guard short-circuits.
    await flush();
    expect(mockSyncState).not.toHaveBeenCalled();
  });

  it('extension: skips SyncRequest while a test pauses sync via __TEST_SYNC_PAUSED__', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;
    mockIsExtension.mockReturnValue(true);

    const { unmount } = render(<HookHost />);

    await flush();
    expect(mockIntercomRequest).not.toHaveBeenCalled();

    unmount();
  });

  it('mobile/desktop: skips syncState while a test pauses sync via __TEST_SYNC_PAUSED__', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;

    const { unmount } = render(<HookHost />);

    await flush();
    expect(mockSyncState).not.toHaveBeenCalled();

    unmount();
  });

  it('does not pause sync when __TEST_SYNC_PAUSED__ is set but MIDEN_E2E_TEST is off (production)', async () => {
    process.env.MIDEN_E2E_TEST = 'false';
    (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;

    const { unmount } = render(<HookHost />);

    // The flag is ignored off the E2E build, so the normal mobile sync still runs.
    await waitFor(() => expect(mockSyncState).toHaveBeenCalled());

    unmount();
  });

  // #596 — the mobile/desktop sync path used to fire the "cannot reach the Miden
  // node" banner on the very FIRST sync failure, while the service-worker path
  // (#273, sync-manager.ts) gates it behind a 3-consecutive-failure streak. A
  // lone testnet sync blip must not flap the banner while the node is healthy.
  it('mobile/desktop: only banners a connectivity issue after 3 consecutive sync failures (#596)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSyncState.mockRejectedValue(new Error('cannot reach node'));

    const { unmount } = render(<HookHost />);

    // 1st failure — no banner yet
    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(1));
    expect(mockMarkConnectivityIssue).not.toHaveBeenCalled();

    // 2nd failure — still no banner
    act(() => requestImmediateSync());
    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(2));
    expect(mockMarkConnectivityIssue).not.toHaveBeenCalled();

    // 3rd consecutive failure — NOW the banner fires, once, with the classified category
    act(() => requestImmediateSync());
    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(mockMarkConnectivityIssue).toHaveBeenCalledWith('node'));
    expect(mockMarkConnectivityIssue).toHaveBeenCalledTimes(1);

    warn.mockRestore();
    unmount();
  });

  it('mobile/desktop: a successful sync resets the failure streak so a later lone failure does not banner (#596)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // fail, fail, succeed (resets streak + clears banner), fail (streak now 1)
    mockSyncState
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('x'));

    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(1)); // fail 1
    act(() => requestImmediateSync());
    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(2)); // fail 2
    act(() => requestImmediateSync());
    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(3)); // success -> reset
    await waitFor(() => expect(mockClearReachabilityIssues).toHaveBeenCalled());
    act(() => requestImmediateSync());
    await waitFor(() => expect(mockSyncState).toHaveBeenCalledTimes(4)); // fail (streak only 1)

    expect(mockMarkConnectivityIssue).not.toHaveBeenCalled();

    warn.mockRestore();
    unmount();
  });

  // #777 — the mobile idle sync froze the app permanently: a parked syncState
  // held the WASM lock with no bound of its own, and the flat 3s retry kept
  // hammering a rate-limiting node. The lock hold gets the sync-specific
  // watchdog ceiling, and the retry cadence gets the SW path's exponential
  // circuit breaker (sync-manager.ts, gap 14).
  it('mobile/desktop: takes the WASM lock with the sync watchdog ceiling (#777)', async () => {
    jest.useFakeTimers();
    const { unmount } = render(<HookHost />);

    // Drive THREE ticks, not one. The ceiling is per-hold, so a loop that passed
    // it on the first hold and dropped it afterwards would still leave the
    // wallet's whole WASM access parked behind an unbounded sync on the very
    // next tick — and a single-tick assertion cannot tell the two apart, because
    // at that point the array it iterates has exactly one entry.
    for (const step of [0, 3_000, 3_000]) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(step);
      });
    }
    expect(wasmLockOptionsSeen.length).toBe(3);
    for (const options of wasmLockOptionsSeen) {
      expect(options).toEqual({ watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS });
    }
    unmount();
  });

  it('mobile/desktop: backs off exponentially once the breaker trips, instead of retrying flat every 3s (#777)', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Pin the jitter to zero so the windows are exactly 30s / 60s.
    const rand = jest.spyOn(Math, 'random').mockReturnValue(0);
    mockSyncState.mockRejectedValue(new Error('HTTP 429'));

    const { unmount } = render(<HookHost />);

    // Failures 1-3 run on the normal 3s cadence.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(2);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // Third consecutive failure trips the breaker: the next probe waits out the
    // first backoff window (30s), not the flat 3s.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    // Still failing: the window doubles.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(59_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    rand.mockRestore();
    warn.mockRestore();
    unmount();
    jest.useRealTimers();
  });

  it('mobile/desktop: a successful probe resets the breaker back to the 3s cadence AND rewinds the schedule (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    mockSyncState
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);

    // Three failures on the 3s cadence trip the breaker.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // The probe at the end of the window SUCCEEDS…
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    // …so the next tick is back on the normal 3s interval.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    // And the ESCALATION is rewound too, not just the cadence. Failing three
    // more times must reopen at the BASE window (30s), which is only true if the
    // success cleared the trip count — clearing the failure streak alone
    // restores the 3s cadence identically, so a test that stops above would
    // pass with the trip-count reset deleted and the next outage would open at
    // 60s, having silently inherited the previous one's escalation.
    mockSyncState.mockRejectedValue(new Error('x'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(8);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(8);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(9);

    unmount();
  });

  it('mobile/desktop: a user Retry can re-arm the breaker window but never escalates it (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    mockSyncState.mockRejectedValue(new Error('x'));

    const { unmount } = render(<HookHost />);

    // Three failures on the 3s cadence open the base 30s window.
    for (const step of [0, 3_000, 3_000]) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(step);
      });
    }
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // The user taps Retry three times against a node that is still down. Each
    // punches through the open window and fails. The escalation must not follow:
    // it measures how long the NODE has been failing, not how many times the
    // user asked, and three taps otherwise walked the wallet from 30s to the
    // 300s cap — the user's own attempt to fix it making it four times worse.
    for (let tap = 0; tap < 3; tap++) {
      await act(async () => {
        requestImmediateSync();
        await jest.advanceTimersByTimeAsync(0);
      });
    }
    expect(mockSyncState).toHaveBeenCalledTimes(6);

    // Still the BASE window, measured from the last forced failure.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(6);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(7);

    // That 7th probe was the TIMER's, so it escalates: 60s, not another 30. This
    // half is what makes the exemption an exemption rather than an off switch —
    // without it, a grant that leaked past the run it was meant for (or a `!forced`
    // guard widened to everything) reads identically to the intended behaviour.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(59_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(7);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(8);

    unmount();
  });

  it('mobile/desktop: a guard-skipped tick serves out the fused window instead of restarting it (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    process.env.MIDEN_E2E_TEST = 'true';
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);
    await driveToBlownFuse();

    // Most of the fused window elapses…
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FUSED_SYNC_PROBE_INTERVAL_MS - 60_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    // …and then a run happens that the guards skip — the user opened the send
    // flow, or foregrounded the app while on the generating-transaction page.
    // As a per-run delay rather than a deadline, the fuse re-armed its FULL
    // cadence here, so every such tick pushed the next probe out by another half
    // hour and a user who kept touching the wallet was never probed again.
    (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;
    await act(async () => {
      requestImmediateSync();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);
    delete (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__;

    // The remainder is what is left of the window, not a fresh one.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    unmount();
  });

  it('mobile/desktop: clamps an over-large window remainder so a clock anomaly cannot stop syncing (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    process.env.MIDEN_E2E_TEST = 'true';
    mockSyncState.mockRejectedValue(new Error('x'));

    const { unmount } = render(<HookHost />);

    // Three failures open a 30s window.
    for (const step of [0, 3_000, 3_000]) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(step);
      });
    }
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // Now make the loop READ a clock far behind the one the deadline was written
    // against, without letting a probe rewrite the deadline in between — which
    // is why the tick that follows has to be a skipped one. The remainder the
    // scheduler then computes is an hour, and this timer is the loop's only
    // driver, so unclamped that is an hour of not syncing at all.
    (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;
    const steppedBack = jest.spyOn(performance, 'now').mockReturnValue(performance.now() - 60 * 60_000);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // Un-pause so the next tick is observable, then let the clamp's ceiling
    // elapse. A probe here means the wait was capped at the curve's own maximum;
    // silence means the raw remainder won.
    steppedBack.mockRestore();
    delete (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MAX_SYNC_BACKOFF_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    unmount();
  });

  it('mobile/desktop: requestImmediateSync probes right through an open backoff window (#777)', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const rand = jest.spyOn(Math, 'random').mockReturnValue(0);
    mockSyncState.mockRejectedValue(new Error('HTTP 429'));

    const { unmount } = render(<HookHost />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // Inside the 30s window the banner's Retry (or a foreground return) must
    // not be made to wait it out.
    await act(async () => {
      requestImmediateSync();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    rand.mockRestore();
    warn.mockRestore();
    unmount();
    jest.useRealTimers();
  });

  it('mobile/desktop: an evicted sync that settles late cannot reset the breaker (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    // The sync itself SUCCEEDS; the hold is what gets evicted for overrunning
    // the ceiling. So the abandoned callback runs to completion a microtask
    // after the loop has already counted the eviction as a failure. Assigning
    // the breaker resets inside that callback let a node slow enough to be
    // evicted on every tick zero the streak from a hold the loop had given up
    // on — the breaker could then never trip, and the 3s cadence this backoff
    // exists to stop would continue indefinitely.
    evictEveryLockHold = true;
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // Three evictions must have opened a window, despite three late successes.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    unmount();
  });

  it('mobile/desktop: a guard-skipped tick keeps an open backoff window instead of resetting to 3s (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    mockSyncState.mockRejectedValue(new Error('HTTP 429'));

    const { unmount } = render(<HookHost />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // A 30s window is open as of t=6000. Enter the send flow and force a tick
    // STRICTLY INSIDE it: the guard skips the probe, and the reschedule that
    // follows is where a per-run delay and a deadline diverge. A skipped tick at
    // the window's own expiry would NOT discriminate — both shapes compute 3s
    // there — which is why this drives the tick mid-window instead.
    window.location.hash = '#/send';
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_000);
    });
    await act(async () => {
      requestImmediateSync();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // Leave the flow. The loop must still be waiting out the REMAINDER of the
    // original window (to t=36000), not the 3s the skipped tick would have
    // reset it to — with a per-run delay it probed at t=13000, handing the node
    // back the 3s cadence it had just been backed off from.
    window.location.hash = '';
    await act(async () => {
      await jest.advanceTimersByTimeAsync(25_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    unmount();
  });

  it('mobile/desktop: a success mid-window clears it instead of serving out the remainder (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    mockSyncState.mockRejectedValue(new Error('HTTP 429'));

    const { unmount } = render(<HookHost />);

    // Three failures on the 3s cadence open a 30s window at t=6000.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    // The node comes back and the user hits Retry mid-window, which probes
    // straight through. Clearing the streak alone is not enough: the DEADLINE
    // has to go too, or the loop reschedules onto what is left of a window it
    // opened against a node that has since answered.
    mockSyncState.mockResolvedValue(undefined);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_000);
    });
    await act(async () => {
      requestImmediateSync();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    // Back on the flat cadence immediately, not at the old t=36000 deadline.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    unmount();
  });

  it('mobile/desktop: a watchdog eviction raises the connectivity banner, so Retry stays reachable (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    // A poison error's message is closed wallet-authored text, so the transport
    // heuristic cannot match it. Without the explicit poison check the #777 hang
    // is the one failure that backs off SILENTLY — and the banner's Retry is the
    // only affordance that probes through an open window, so a silent backoff
    // leaves the user no way out of it.
    mockIsLikelyNetworkError.mockReturnValue(false);
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    // Below the streak threshold nothing is surfaced yet (#596 — a lone blip
    // must not flap the banner).
    expect(mockMarkConnectivityIssue).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockMarkConnectivityIssue).toHaveBeenCalledWith('node');

    unmount();
  });

  it('mobile/desktop: a realm-error eviction does NOT claim the node is unreachable (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    // The other poison reason is a WASM trap in this realm, not an unreachable
    // node — and `classifySyncError` has only the one verdict, so folding it in
    // with the watchdog would tell the user something false about their network.
    // It also needs no banner: the client is replaced in milliseconds and the
    // next tick syncs on a fresh one, which is the one case Retry cannot help.
    mockIsLikelyNetworkError.mockReturnValue(false);
    evictEveryLockHold = true;
    evictionReason = 'realm-error';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);

    // Well past the streak threshold that would surface a watchdog eviction.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockMarkConnectivityIssue).not.toHaveBeenCalled();

    // The breaker still counts it: whatever the reason, the sync did not happen,
    // and an eviction on every tick is exactly the cycle the backoff exists for.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    // What it must NOT do is blow the fuse. Four evictions is the fuse
    // threshold, so stopping here would pass whether the fuse is reason-blind or
    // not; the discriminating observation is the cadence AFTER the fourth. The
    // breaker's second window is 60s, well inside the fused cadence, so a
    // reason-blind fuse would leave this probe unfired.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    unmount();
  });

  // The fuse (#777). Once the realm's sync is parked, the SDK hands every later
  // `syncState()` the SAME dead promise — its in-flight map is module-level and
  // the wallet cannot reach it — so each further probe is GUARANTEED to park for
  // the full ceiling and be evicted: two minutes of the whole app's WASM access
  // plus a client rebuild, per cycle. The breaker spaces that cycle out but its
  // ceiling keeps paying that price every few minutes indefinitely.
  //
  // The fuse is a CADENCE, not a stop, and these tests are written to fail
  // against the stop it replaced. A stop needed a user gesture to recover, and
  // there is no gesture that is always available: the foreground kick is
  // mobile-only while this loop also drives desktop, and the banner Retry can be
  // dismissed for the life of an active issue. A stretch recovers on its own.
  //
  // Drives the loop to exactly the fuse threshold. Four evictions, not three:
  // the fuse needs strictly more evidence than the breaker, so the third
  // eviction only opens the first 30s window and the FOURTH — the probe that
  // waited that window out — is what concludes.
  const driveToBlownFuse = async () => {
    for (const step of [0, 3_000, 3_000, 30_000]) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(step);
      });
    }
    expect(mockSyncState).toHaveBeenCalledTimes(4);
  };

  it('mobile/desktop: drops to the fused cadence after repeated watchdog evictions (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);
    await driveToBlownFuse();

    // Past the largest window the breaker's curve can produce, so anything that
    // fires from here is the fuse's cadence and not a backoff — this is what
    // separates giving up on the cycle from merely spacing it out.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MAX_SYNC_BACKOFF_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    // But it is a stretch, not a stop: the loop comes back on its own, with no
    // user gesture and no platform-specific hook involved.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FUSED_SYNC_PROBE_INTERVAL_MS - MAX_SYNC_BACKOFF_MS - 1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    unmount();
  });

  it('mobile/desktop: user Retries cannot blow the fuse, however many are tapped (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(1);

    // Four taps of a Retry that keeps being evicted — enough evidence to fuse, if
    // taps counted as evidence. They must not: the fuse governs how often the
    // loop probes ON ITS OWN, and a user tap is neither part of that cadence nor
    // throttled by it, so counting it lets the user talk the wallet into a
    // half-hour of silence by trying to fix it. Same argument that keeps a tap
    // from escalating the breaker.
    for (let tap = 0; tap < 4; tap++) {
      await act(async () => {
        requestImmediateSync();
        await jest.advanceTimersByTimeAsync(0);
      });
    }
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    // The automatic cadence is still the breaker's base window, not the fuse's.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(6);

    unmount();
  });

  it('mobile/desktop: an ordinary failure while fused does not shorten the fused wait (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);
    await driveToBlownFuse();

    // The device drops offline during the fused period, so the next probe fails
    // fast instead of parking. While the fuse and the breaker shared one deadline
    // field, this failure re-entered the breaker's arm and overwrote the fused
    // deadline with a window at most a fifth as long — and the eviction streak
    // was zeroed alongside it, so re-earning the cadence cost four more
    // two-minute evictions, eight further minutes of the whole app's WASM access,
    // for a conclusion nothing had contradicted. One offline blip, and the fuse
    // was gone.
    evictEveryLockHold = false;
    mockSyncState.mockRejectedValue(new Error('Failed to fetch'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FUSED_SYNC_PROBE_INTERVAL_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    // Still the fused cadence: nothing before the next 30 minutes are up.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MAX_SYNC_BACKOFF_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FUSED_SYNC_PROBE_INTERVAL_MS - MAX_SYNC_BACKOFF_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(6);

    unmount();
  });

  it('mobile/desktop: the fuse survives a remount, since what it knows is about the realm (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const first = render(<HookHost />);
    await driveToBlownFuse();
    // An idle auto-lock and an unlock: the effect keys on wallet status, so this
    // is a remount. The parked in-flight sync it concluded about lives in the
    // SDK's module scope and is entirely untouched by it — so throwing the
    // conclusion away handed a provably parked realm back the 3s cadence, and
    // charged the user four fresh two-minute evictions per unlock to reach it
    // again.
    first.unmount();
    const second = render(<HookHost />);

    // A remount does probe once immediately — that much is the right bias, the
    // user just came back. What it must not do is resume the fast cadence.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MAX_SYNC_BACKOFF_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    // And it must not be a stop, either: silence for one breaker window is what an
    // inherited fuse and a hook that simply died look identical from. The remount's
    // own probe was evicted too, so the deadline it re-armed is one fused interval
    // from there — and reaching it, the realm gets tried again.
    evictEveryLockHold = false;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FUSED_SYNC_PROBE_INTERVAL_MS - MAX_SYNC_BACKOFF_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(6);

    // That probe succeeded, which clears the fuse — and clearing it has to mean
    // discarding the EVIDENCE, not just the deadline. Evict again from here: a
    // single eviction must no longer be enough to re-fuse, or a realm that
    // recovers for one probe and parks again is charged a fresh half hour on the
    // strength of the four evictions it already served.
    evictEveryLockHold = true;
    for (let tick = 0; tick < 2; tick++) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3_000);
      });
    }
    expect(mockSyncState).toHaveBeenCalledTimes(8);

    second.unmount();
  });

  it('mobile/desktop: the breaker still serves its first window before the fuse blows (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);

    // Three evictions on the 3s cadence open a window but must NOT fuse: giving
    // up here would mean never testing whether waiting helps, which is the only
    // hypothesis that separates a parked sync from a node having a bad minute.
    for (const step of [0, 3_000, 3_000]) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(step);
      });
    }
    expect(mockSyncState).toHaveBeenCalledTimes(3);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(4);

    unmount();
  });

  it('mobile/desktop: a Retry after the fuse blows probes now, then returns to the fused cadence (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);
    await driveToBlownFuse();

    // A Retry still punches straight through, exactly as it does through an
    // ordinary backoff window — the fuse needs no separate grant to allow it,
    // because it never gated the probe in the first place.
    await act(async () => {
      requestImmediateSync();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    // And it does not reset the fuse: that probe was evicted too, so the loop
    // goes back to the slow cadence rather than to 3s. Resetting here would buy
    // a whole fresh streak of two-minute evictions per Retry.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(MAX_SYNC_BACKOFF_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FUSED_SYNC_PROBE_INTERVAL_MS - MAX_SYNC_BACKOFF_MS);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(6);

    unmount();
  });

  it('mobile/desktop: a successful sync un-fuses the loop and restores the 3s cadence (#777)', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(Math, 'random').mockReturnValue(0);
    evictEveryLockHold = true;
    evictionReason = 'watchdog';
    mockSyncState.mockResolvedValue(undefined);

    const { unmount } = render(<HookHost />);
    await driveToBlownFuse();

    // The node comes back before the user's Retry, so the granted probe
    // succeeds. The fuse must not survive that — otherwise a wallet that has
    // recovered still needs a Retry for every single sync from then on.
    evictEveryLockHold = false;
    await act(async () => {
      requestImmediateSync();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(5);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(mockSyncState).toHaveBeenCalledTimes(6);

    unmount();
  });

  it('extension: clears the interval on unmount', async () => {
    jest.useFakeTimers();
    mockIsExtension.mockReturnValue(true);

    const { unmount } = render(<HookHost />);
    // initial tick
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    // Advance past the interval — no new requests after unmount.
    const callsBefore = mockIntercomRequest.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(mockIntercomRequest.mock.calls.length).toBe(callsBefore);
    jest.useRealTimers();
  });
});
