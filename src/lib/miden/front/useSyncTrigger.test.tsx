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

import { useSyncTrigger } from './useSyncTrigger';

const storeState: {
  status: WalletStatus;
  accounts: Array<{ publicKey: string; type: WalletType }>;
  isTransactionModalOpen: boolean;
  setSyncStatus: jest.Mock;
} = {
  status: WalletStatus.Ready,
  accounts: [],
  isTransactionModalOpen: false,
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
  isMobile: (...args: unknown[]) => mockIsMobile(...args)
}));

const mockSyncGuardianAccounts = jest.fn(async (..._args: unknown[]) => {});
jest.mock('./guardian-sync', () => ({
  syncGuardianAccounts: (...args: unknown[]) => mockSyncGuardianAccounts(...args)
}));

const HookHost: React.FC = () => {
  useSyncTrigger();
  return null;
};

const flush = () => new Promise(res => setTimeout(res, 0));

describe('useSyncTrigger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState.status = WalletStatus.Ready;
    storeState.accounts = [];
    storeState.isTransactionModalOpen = false;
    mockIsExtension.mockReturnValue(false);
    mockIsMobile.mockReturnValue(false);
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

  it('mobile/desktop: runs Guardian sync after chain sync when Guardian accounts exist', async () => {
    storeState.accounts = [{ publicKey: 'g1', type: WalletType.Guardian }];

    const { unmount } = render(<HookHost />);

    await waitFor(() => expect(mockSyncGuardianAccounts).toHaveBeenCalled());
    unmount();
  });

  it('mobile/desktop: skips sync while the mobile transaction modal is open', async () => {
    mockIsMobile.mockReturnValue(true);
    storeState.isTransactionModalOpen = true;

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
