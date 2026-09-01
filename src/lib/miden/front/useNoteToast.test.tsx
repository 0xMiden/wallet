/* eslint-disable import/first */

import { renderHook, waitFor } from '@testing-library/react';

const _g = globalThis as any;
_g.__noteToastTest = {
  claimableNotes: [] as Array<{ id: string }>,
  isExtension: false
};

_g.__noteToastTest.checkForNewNotes = jest.fn();

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
  (fn as any).setState = jest.fn();
  return { useWalletStore: fn };
});

const mockCheckForNewNotes = _g.__noteToastTest.checkForNewNotes;

jest.mock('lib/platform', () => ({
  isExtension: () => (globalThis as any).__noteToastTest.isExtension
}));

jest.mock('./claimable-notes', () => ({
  useClaimableNotes: () => ({
    data: (globalThis as any).__noteToastTest.claimableNotes
  })
}));

// `useManuallyClaimableNotes` drops native notes the wallet auto-consumes (#811);
// default to a known native faucet with auto-consume ON so the exclusion is live.
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => 'faucet-native'
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
  mockGetPersistedSeenNoteIds.mockReset().mockResolvedValue(new Set<string>());
  mockPersistSeenNoteIds.mockReset().mockResolvedValue(undefined);
  _g.__noteToastTest.isExtension = false;
  _g.__noteToastTest.claimableNotes = [];
});

describe('useNoteToastMonitor', () => {
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

  it('never raises a toast for a native note the wallet auto-consumes (#811)', async () => {
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

    // The store diffs against seenNoteIds itself; what matters is that the
    // auto-consumed native note never reaches it.
    await waitFor(() => {
      expect(mockCheckForNewNotes).toHaveBeenCalledWith(['seeded', 'manual']);
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
