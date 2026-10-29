import { act, renderHook } from '@testing-library/react';

import type { BackupRefreshOutcome, BackupRefreshReason } from 'lib/shared/types';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

import { useBackupForegroundRefresh } from './useBackupForegroundRefresh';

const mockRefreshBackup = jest.fn<Promise<BackupRefreshOutcome>, [BackupRefreshReason]>();

let visibility: DocumentVisibilityState = 'visible';
const visibilitySpy = jest.spyOn(document, 'visibilityState', 'get');

const raiseVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

let nowMs = 1_000_000;
let nowSpy: jest.SpyInstance<number, []>;

beforeEach(() => {
  mockRefreshBackup.mockReset();
  mockRefreshBackup.mockResolvedValue('unchanged');
  visibility = 'visible';
  visibilitySpy.mockImplementation(() => visibility);
  nowMs = 1_000_000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  useWalletStore.setState({ status: WalletStatus.Ready, refreshBackup: mockRefreshBackup });
});

afterEach(() => {
  nowSpy.mockRestore();
});

afterAll(() => {
  visibilitySpy.mockRestore();
});

describe('useBackupForegroundRefresh', () => {
  it('asks for a foreground refresh when the document turns visible while the wallet is Ready', () => {
    const { unmount } = renderHook(() => useBackupForegroundRefresh());

    raiseVisibility('visible');

    expect(mockRefreshBackup).toHaveBeenCalledTimes(1);
    expect(mockRefreshBackup).toHaveBeenCalledWith('foreground');
    unmount();
  });

  it('does not refresh on mount, only on a foreground event', () => {
    const { unmount } = renderHook(() => useBackupForegroundRefresh());

    expect(mockRefreshBackup).not.toHaveBeenCalled();
    unmount();
  });

  it('does not refresh when the document turns hidden', () => {
    const { unmount } = renderHook(() => useBackupForegroundRefresh());

    raiseVisibility('hidden');

    expect(mockRefreshBackup).not.toHaveBeenCalled();
    unmount();
  });

  it.each([WalletStatus.Locked, WalletStatus.Idle])('does not refresh while the wallet is %s', status => {
    useWalletStore.setState({ status });
    const { unmount } = renderHook(() => useBackupForegroundRefresh());

    raiseVisibility('visible');

    expect(mockRefreshBackup).not.toHaveBeenCalled();
    unmount();
  });

  it('starts to refresh when the wallet turns Ready, and stops when it locks', () => {
    useWalletStore.setState({ status: WalletStatus.Locked });
    const { unmount } = renderHook(() => useBackupForegroundRefresh());

    raiseVisibility('visible');
    expect(mockRefreshBackup).not.toHaveBeenCalled();

    act(() => {
      useWalletStore.setState({ status: WalletStatus.Ready });
    });
    raiseVisibility('visible');
    expect(mockRefreshBackup).toHaveBeenCalledTimes(1);

    act(() => {
      useWalletStore.setState({ status: WalletStatus.Locked });
    });
    nowMs += 10_000;
    raiseVisibility('visible');
    expect(mockRefreshBackup).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('coalesces two foreground events closer than 500 ms into one refresh', () => {
    const { unmount } = renderHook(() => useBackupForegroundRefresh());

    raiseVisibility('visible');
    nowMs += 499;
    raiseVisibility('visible');
    expect(mockRefreshBackup).toHaveBeenCalledTimes(1);

    nowMs += 501;
    raiseVisibility('visible');
    expect(mockRefreshBackup).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('a hidden event between two visible ones does not reset the coalesce window', () => {
    const { unmount } = renderHook(() => useBackupForegroundRefresh());

    raiseVisibility('visible');
    nowMs += 100;
    raiseVisibility('hidden');
    nowMs += 100;
    raiseVisibility('visible');

    expect(mockRefreshBackup).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useBackupForegroundRefresh());
    unmount();

    raiseVisibility('visible');

    expect(mockRefreshBackup).not.toHaveBeenCalled();
  });

  it('logs a failed refresh and does not throw', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('offline');
    mockRefreshBackup.mockRejectedValueOnce(failure);
    const { unmount } = renderHook(() => useBackupForegroundRefresh());

    raiseVisibility('visible');
    await act(async () => {
      await Promise.resolve();
    });

    expect(warn).toHaveBeenCalledWith('[useBackupForegroundRefresh] the backup refresh failed:', failure);
    warn.mockRestore();
    unmount();
  });
});
