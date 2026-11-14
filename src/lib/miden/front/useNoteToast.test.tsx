/* eslint-disable import/first */

import { renderHook, waitFor } from '@testing-library/react';

const _g = globalThis as any;
_g.__noteToastTest = {
  claimableNotes: [] as Array<{ id: string }>,
  baseFee: null as number | null,
  floorFee: undefined as number | null | undefined,
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

// `useManuallyClaimableNotes` drops native notes the wallet auto-consumes (#811).
// Default to a known native faucet with auto-consume on so the exclusion is live.
// An unset claim floor passes the raw fee through, so a null fee stays null and the note stays manual.
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => 'legacy-display'
}));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({
  __esModule: true,
  default: () => 'faucet-native'
}));
jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => (globalThis as any).__noteToastTest.baseFee,
  // An unset floor passes the raw fee through, so a null raw fee stays null.
  useClaimFloorBaseFee: () => {
    const { baseFee, floorFee } = (globalThis as any).__noteToastTest;
    return floorFee === undefined ? baseFee : floorFee;
  }
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
  _g.__noteToastTest.floorFee = undefined;
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
    // Fee-free chain and no amount: the floor is 0, so auto-consume hides the native note.
    _g.__noteToastTest.floorFee = 0;
    _g.__noteToastTest.claimableNotes = [];
    const { rerender } = renderHook(() => useNoteToastMonitor('pk-1'));
    // The address effect re-arms the first-fetch seed after mount, so the next
    // fetch is seeded silently too; burn it before the fetch under test.
    _g.__noteToastTest.claimableNotes = [{ id: 'seeded', faucetId: 'faucet-other' }];
    rerender();

    _g.__noteToastTest.claimableNotes = [
      { id: 'seeded', faucetId: 'faucet-other' },
      { id: 'auto', faucetId: 'faucet-native', standardPayment: true },
      { id: 'manual', faucetId: 'faucet-other' }
    ];
    rerender();

    // Every note reaches the store's seen set; what matters is that the
    // auto-consumed native note is never one that may raise the toast.
    await waitFor(() => {
      expect(mockCheckForNewNotes).toHaveBeenCalledWith(['seeded', 'auto', 'manual'], ['seeded', 'manual']);
    });
  });

  it('notifies for legacy display notes while actual native notes are auto-managed', () => {
    _g.__noteToastTest.baseFee = 7;
    const { rerender } = renderHook(() => useNoteToastMonitor('pk-1'));
    _g.__noteToastTest.claimableNotes = [{ id: 'seeded', faucetId: 'faucet-other' }];
    rerender();
    _g.__noteToastTest.claimableNotes = [
      { id: 'seeded', faucetId: 'faucet-other' },
      { id: 'actual', faucetId: 'faucet-native', amount: '1000000', standardPayment: true },
      { id: 'legacy', faucetId: 'legacy-display', amount: '1000000' }
    ];
    rerender();
    expect(mockCheckForNewNotes).toHaveBeenLastCalledWith(['seeded', 'actual', 'legacy'], ['seeded', 'legacy']);
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
    // A chain that charges nothing: the floor is 0, so the native dust note rides in an auto-consume batch and is
    // hidden.
    _g.__noteToastTest.floorFee = 0;
    _g.__noteToastTest.claimableNotes = [];
    const { rerender } = renderHook(() => useNoteToastMonitor('pk-1'));

    _g.__noteToastTest.claimableNotes = [
      { id: 'seeded', faucetId: 'faucet-other' },
      { id: 'dust', faucetId: 'faucet-native', amount: '1', standardPayment: true }
    ];
    rerender();
    expect(_g.__noteToastTest.setState).toHaveBeenLastCalledWith({ seenNoteIds: new Set(['seeded', 'dust']) });
    expect(mockCheckForNewNotes).not.toHaveBeenCalled();

    // Once a fee the dust cannot clear is known, the dust note is passed as notifiable; that it never toasts is
    // checked against the real store in useNoteToast.store.test.tsx.
    _g.__noteToastTest.floorFee = 10;
    rerender();
    expect(mockCheckForNewNotes).toHaveBeenLastCalledWith(['seeded', 'dust'], ['seeded', 'dust']);
  });

  it('passes a worthwhile native note as notifiable while the claim floor is unknown', async () => {
    _g.__noteToastTest.baseFee = null;
    _g.__noteToastTest.floorFee = undefined;
    _g.__noteToastTest.claimableNotes = [];
    const { rerender } = renderHook(() => useNoteToastMonitor('pk-1'));
    _g.__noteToastTest.claimableNotes = [{ id: 'seeded', faucetId: 'faucet-other' }];
    rerender();

    _g.__noteToastTest.claimableNotes = [
      { id: 'seeded', faucetId: 'faucet-other' },
      { id: 'worth', faucetId: 'faucet-native', amount: '1000000', standardPayment: true }
    ];
    rerender();

    await waitFor(() => {
      expect(mockCheckForNewNotes).toHaveBeenCalledWith(['seeded', 'worth'], ['seeded', 'worth']);
    });
  });

  it('does not hydrate on non-extension', async () => {
    _g.__noteToastTest.isExtension = false;
    renderHook(() => useNoteToastMonitor('pk-1'));
    await waitFor(() => {
      expect(mockGetPersistedSeenNoteIds).not.toHaveBeenCalled();
    });
  });
});
