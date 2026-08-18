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

import { WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { requestImmediateSync, useSyncTrigger } from './useSyncTrigger';

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
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: (...args: unknown[]) => mockGetMidenClient(...args),
  // In .tsx `<T>` parses as JSX — the trailing comma disambiguates it as a generic.
  withWasmClientLock: async <T,>(fn: () => Promise<T>) => fn()
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
    const prevEnv = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;
    mockIsExtension.mockReturnValue(true);

    const { unmount } = render(<HookHost />);

    await flush();
    expect(mockIntercomRequest).not.toHaveBeenCalled();

    unmount();
    delete (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__;
    process.env.MIDEN_E2E_TEST = prevEnv;
  });

  it('mobile/desktop: skips syncState while a test pauses sync via __TEST_SYNC_PAUSED__', async () => {
    const prevEnv = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;

    const { unmount } = render(<HookHost />);

    await flush();
    expect(mockSyncState).not.toHaveBeenCalled();

    unmount();
    delete (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__;
    process.env.MIDEN_E2E_TEST = prevEnv;
  });

  it('does not pause sync when __TEST_SYNC_PAUSED__ is set but MIDEN_E2E_TEST is off (production)', async () => {
    const prevEnv = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'false';
    (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;

    const { unmount } = render(<HookHost />);

    // The flag is ignored off the E2E build, so the normal mobile sync still runs.
    await waitFor(() => expect(mockSyncState).toHaveBeenCalled());

    unmount();
    delete (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__;
    process.env.MIDEN_E2E_TEST = prevEnv;
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
