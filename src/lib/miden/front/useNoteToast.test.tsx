/* eslint-disable import/first */

import { renderHook, waitFor } from '@testing-library/react';

const _g = globalThis as any;
_g.__noteToastTest = {
  claimableNotes: [] as Array<{ id: string }>,
  baseFee: null as number | null,
  isExtension: false,
  isFallback: false
};

_g.__noteToastTest.checkForNewNotes = jest.fn();
_g.__noteToastTest.setState = jest.fn();

jest.mock('lib/store', () => {
  const fn = (selector?: any) => {
    const state = {
      checkForNewNotes: (globalThis as any).__noteToastTest.checkForNewNotes,
      seenNoteIds: new Set<string>()
    };
    return selector ? selector(state) : state;
  };
  (fn as any).getState = () => ({
    seenNoteIds: new Set<string>(),
    checkForNewNotes: (globalThis as any).__noteToastTest.checkForNewNotes
  });
  (fn as any).setState = (...args: any[]) => (globalThis as any).__noteToastTest.setState(...args);
  return { useWalletStore: fn };
});

const mockCheckForNewNotes = _g.__noteToastTest.checkForNewNotes;

jest.mock('lib/platform', () => ({
  isExtension: () => (globalThis as any).__noteToastTest.isExtension
}));

jest.mock('./claimable-notes', () => ({
  useClaimableNotes: () => ({
    data: (globalThis as any).__noteToastTest.claimableNotes,
    isFallback: (globalThis as any).__noteToastTest.isFallback
  })
}));

// `useManuallyClaimableNotes` drops native notes the wallet auto-consumes (#811);
// default to a known native faucet with auto-consume ON so the exclusion is live,
// and to an unknown fee, which lets every native batch through.
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => 'faucet-native'
}));
jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => (globalThis as any).__noteToastTest.baseFee
}));
jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => true
}));

const mockGetPersistedSeenNoteIds = jest.fn();
const mockPersistSeenNoteIds = jest.fn();
jest.mock('lib/miden/back/note-checker-storage', () => ({
  getPersistedSeenNoteIds: () => mockGetPersistedSeenNoteIds(),
  persistSeenNoteIds: (...args: unknown[]) => mockPersistSeenNoteIds(...args)
}));

import { useNoteToastMonitor } from './useNoteToast';

beforeEach(() => {
  mockCheckForNewNotes.mockReset();
  _g.__noteToastTest.setState.mockReset();
  mockGetPersistedSeenNoteIds.mockReset().mockResolvedValue(new Set<string>());
  mockPersistSeenNoteIds.mockReset().mockResolvedValue(undefined);
  _g.__noteToastTest.isExtension = false;
  _g.__noteToastTest.claimableNotes = [];
  _g.__noteToastTest.baseFee = null;
  _g.__noteToastTest.isFallback = false;
});

describe('useNoteToastMonitor', () => {
  it('waits for a live list before seeding, so notes received while the app was closed do not notify', () => {
    // Nothing is published at mount; the persisted list arrives on a later render, as it does at launch.
    _g.__noteToastTest.claimableNotes = undefined;
    const { rerender } = renderHook(() => useNoteToastMonitor('pk'));

    _g.__noteToastTest.claimableNotes = [];
    _g.__noteToastTest.isFallback = true;
    rerender();

    _g.__noteToastTest.claimableNotes = [{ id: 'arrived-while-closed' }];
    _g.__noteToastTest.isFallback = false;
    rerender();
    expect(mockCheckForNewNotes).not.toHaveBeenCalled();

    _g.__noteToastTest.claimableNotes = [{ id: 'arrived-while-closed' }, { id: 'new' }];
    rerender();
    expect(mockCheckForNewNotes).toHaveBeenCalledWith(['arrived-while-closed', 'new'], ['arrived-while-closed', 'new']);
  });

  it('does nothing on first fetch (seeds seen notes silently)', async () => {
    _g.__noteToastTest.claimableNotes = [{ id: 'n1' }];
    renderHook(() => useNoteToastMonitor('pk-1'));
    await waitFor(() => {
      expect(mockCheckForNewNotes).not.toHaveBeenCalled();
    });
  });

  it('skips when enabled is false', async () => {
    _g.__noteToastTest.claimableNotes = [{ id: 'n1' }];
    renderHook(() => useNoteToastMonitor('pk-1', false));
    await waitFor(() => {
      expect(mockCheckForNewNotes).not.toHaveBeenCalled();
    });
  });

  it('hydrates from persisted IDs in extension mode', async () => {
    _g.__noteToastTest.isExtension = true;
    mockGetPersistedSeenNoteIds.mockResolvedValueOnce(new Set(['old-1']));
    renderHook(() => useNoteToastMonitor('pk-1'));
    await waitFor(() => {
      expect(mockGetPersistedSeenNoteIds).toHaveBeenCalled();
    });
  });

  it('passes an auto-consumed native note as seen but never as notifiable (#811)', async () => {
    _g.__noteToastTest.claimableNotes = [];
    const { rerender } = renderHook(() => useNoteToastMonitor('pk-1'));
    // The address effect re-arms the first-fetch seed after mount, so the next
    // fetch is seeded silently too; burn it before the fetch under test.
    _g.__noteToastTest.claimableNotes = [{ id: 'seeded', faucetId: 'faucet-other' }];
    rerender();

    _g.__noteToastTest.claimableNotes = [
      { id: 'seeded', faucetId: 'faucet-other' },
      { id: 'auto', faucetId: 'faucet-native' },
      { id: 'manual', faucetId: 'faucet-other' }
    ];
    rerender();

    // Every note reaches the store's seen set; what matters is that the
    // auto-consumed native note is never one that may raise the toast.
    await waitFor(() => {
      expect(mockCheckForNewNotes).toHaveBeenCalledWith(['seeded', 'auto', 'manual'], ['seeded', 'manual']);
    });
  });

  it('still raises a toast for a native note worth too little to auto-consume', async () => {
    _g.__noteToastTest.baseFee = 10;
    _g.__noteToastTest.claimableNotes = [];
    const { rerender } = renderHook(() => useNoteToastMonitor('pk-1'));
    _g.__noteToastTest.claimableNotes = [{ id: 'seeded', faucetId: 'faucet-other' }];
    rerender();

    _g.__noteToastTest.claimableNotes = [
      { id: 'seeded', faucetId: 'faucet-other' },
      { id: 'dust', faucetId: 'faucet-native', amount: '1' }
    ];
    rerender();

    await waitFor(() => {
      expect(mockCheckForNewNotes).toHaveBeenCalledWith(['seeded', 'dust'], ['seeded', 'dust']);
    });
  });

  it('seeds every listed note as seen, including one the filter hides', () => {
    _g.__noteToastTest.claimableNotes = [];
    const { rerender } = renderHook(() => useNoteToastMonitor('pk-1'));

    // With the fee still unknown, the native dust note rides in an auto-consume batch and is hidden.
    _g.__noteToastTest.claimableNotes = [
      { id: 'seeded', faucetId: 'faucet-other' },
      { id: 'dust', faucetId: 'faucet-native', amount: '1' }
    ];
    rerender();
    expect(_g.__noteToastTest.setState).toHaveBeenLastCalledWith({ seenNoteIds: new Set(['seeded', 'dust']) });
    expect(mockCheckForNewNotes).not.toHaveBeenCalled();

    // Once the fee is known the dust note is passed as notifiable; that it never toasts is checked against the real
    // store in useNoteToast.store.test.tsx.
    _g.__noteToastTest.baseFee = 10;
    rerender();
    expect(mockCheckForNewNotes).toHaveBeenLastCalledWith(['seeded', 'dust'], ['seeded', 'dust']);
  });

  it('does not hydrate on non-extension', async () => {
    _g.__noteToastTest.isExtension = false;
    renderHook(() => useNoteToastMonitor('pk-1'));
    await waitFor(() => {
      expect(mockGetPersistedSeenNoteIds).not.toHaveBeenCalled();
    });
  });
});
