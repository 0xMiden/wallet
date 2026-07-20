/* eslint-disable import/first */
import { act, renderHook } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Storage module mock.
//
// The hook pulls `useStorage` (the SW->popup mirror channel) and `putToStorage`
// (used by `dismiss`) from `../front/storage`. We stub both so the test drives
// the storage snapshot deterministically and avoids the SWR/suspense +
// chrome.storage plumbing entirely.
//
// NOTE: `connectivity-state.ts` also imports `putToStorage` from the SAME
// module (via the `lib/miden/front/storage` alias, which jest resolves to the
// same file). Mocking it here therefore also neutralises the fire-and-forget
// storage mirror inside the real state machine's `notify()`.
// ---------------------------------------------------------------------------
const mockUseStorage = jest.fn();
const mockPutToStorage = jest.fn().mockResolvedValue(undefined);

jest.mock('../front/storage', () => ({
  useStorage: (...args: unknown[]) => mockUseStorage(...args),
  putToStorage: (...args: unknown[]) => mockPutToStorage(...args)
}));

import {
  CONNECTIVITY_CATEGORIES,
  CONNECTIVITY_STATE_KEY,
  ConnectivityCategory,
  ConnectivityStateSnapshot,
  getConnectivityState,
  markConnectivityIssue,
  resetConnectivityState
} from './connectivity-state';
import { useConnectivityState } from './use-connectivity-state';

/** Build a fresh all-clear snapshot, optionally flipping some categories on. */
function makeSnapshot(active: Partial<Record<ConnectivityCategory, boolean>> = {}): ConnectivityStateSnapshot {
  const snap = {} as ConnectivityStateSnapshot;
  for (const cat of CONNECTIVITY_CATEGORIES) {
    snap[cat] = active[cat] ? { active: true, since: 123 } : { active: false, since: null };
  }
  return snap;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPutToStorage.mockResolvedValue(undefined);
  // Default: storage mirror is empty, so the hook falls back to the in-memory
  // machine. Individual tests override this before rendering.
  mockUseStorage.mockReturnValue([null, jest.fn()]);
  resetConnectivityState();
});

describe('useConnectivityState', () => {
  it('starts from the synchronous in-memory snapshot when storage is empty', () => {
    const { result } = renderHook(() => useConnectivityState());

    expect(mockUseStorage).toHaveBeenCalledWith(CONNECTIVITY_STATE_KEY, null);
    expect(result.current.state).toEqual(getConnectivityState());
    expect(result.current.hasAnyIssue).toBe(false);
    expect(typeof result.current.dismiss).toBe('function');
  });

  it('starts from a non-empty in-memory snapshot (useState initializer runs getConnectivityState)', () => {
    // Prime the real machine BEFORE mounting so the lazy initializer sees it.
    markConnectivityIssue('node');

    const { result } = renderHook(() => useConnectivityState());

    expect(result.current.state.node.active).toBe(true);
    expect(result.current.hasAnyIssue).toBe(true);
  });

  it('prefers the storage snapshot over the in-memory one when present (storage wins)', () => {
    const storageSnap = makeSnapshot({ prover: true });
    mockUseStorage.mockReturnValue([storageSnap, jest.fn()]);

    const { result } = renderHook(() => useConnectivityState());

    // Same object reference — merged is `storageSnapshot ?? memorySnapshot`.
    expect(result.current.state).toBe(storageSnap);
    expect(result.current.hasAnyIssue).toBe(true);
  });

  it('storage snapshot wins even while the in-memory machine reports a different state', () => {
    const storageSnap = makeSnapshot(); // all clear
    mockUseStorage.mockReturnValue([storageSnap, jest.fn()]);

    const { result } = renderHook(() => useConnectivityState());

    // Push an in-memory issue: the subscriber fires and re-renders, but storage
    // still wins so `hasAnyIssue` stays false.
    act(() => {
      markConnectivityIssue('prover');
    });

    expect(result.current.state).toBe(storageSnap);
    expect(result.current.hasAnyIssue).toBe(false);
  });

  describe('hasAnyIssue reflects each category independently', () => {
    it.each(CONNECTIVITY_CATEGORIES)('is true when only "%s" is active', category => {
      mockUseStorage.mockReturnValue([makeSnapshot({ [category]: true }), jest.fn()]);

      const { result } = renderHook(() => useConnectivityState());

      expect(result.current.hasAnyIssue).toBe(true);
    });

    it('is false when every category is inactive', () => {
      mockUseStorage.mockReturnValue([makeSnapshot(), jest.fn()]);

      const { result } = renderHook(() => useConnectivityState());

      expect(result.current.hasAnyIssue).toBe(false);
    });
  });

  it('updates from the same-process subscriber when storage is empty', () => {
    const { result } = renderHook(() => useConnectivityState());
    expect(result.current.hasAnyIssue).toBe(false);

    act(() => {
      markConnectivityIssue('network');
    });

    expect(result.current.state.network.active).toBe(true);
    expect(result.current.hasAnyIssue).toBe(true);
  });

  it('dismiss clears the category in the machine and mirrors the fresh snapshot to storage', () => {
    const { result } = renderHook(() => useConnectivityState());

    act(() => {
      markConnectivityIssue('network');
    });
    expect(result.current.hasAnyIssue).toBe(true);
    mockPutToStorage.mockClear();

    act(() => {
      result.current.dismiss('network');
    });

    // In-process machine was cleared…
    expect(getConnectivityState().network.active).toBe(false);
    // …the hook re-rendered to reflect it…
    expect(result.current.state.network.active).toBe(false);
    expect(result.current.hasAnyIssue).toBe(false);
    // …and the mirror write went out with the post-clear snapshot.
    expect(mockPutToStorage).toHaveBeenCalledWith(CONNECTIVITY_STATE_KEY, getConnectivityState());
    const [, mirrored] = mockPutToStorage.mock.calls.at(-1)!;
    expect((mirrored as ConnectivityStateSnapshot).network.active).toBe(false);
  });

  it('dismiss is a no-op mirror when the category was already clear', () => {
    const { result } = renderHook(() => useConnectivityState());
    mockPutToStorage.mockClear();

    act(() => {
      result.current.dismiss('prover');
    });

    // clearConnectivityIssue no-ops (already clear) but dismiss still writes
    // the current snapshot to storage unconditionally.
    expect(getConnectivityState().prover.active).toBe(false);
    expect(mockPutToStorage).toHaveBeenCalledWith(CONNECTIVITY_STATE_KEY, getConnectivityState());
  });

  it('keeps a stable dismiss reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useConnectivityState());
    const first = result.current.dismiss;
    rerender();
    expect(result.current.dismiss).toBe(first);
  });

  it('unsubscribes on unmount so later transitions do not update the hook', () => {
    const { result, unmount } = renderHook(() => useConnectivityState());
    const lastState = result.current.state;

    unmount();

    // No act() / no throw about updating an unmounted component: the effect
    // cleanup removed the subscriber.
    expect(() => markConnectivityIssue('node')).not.toThrow();
    // The captured snapshot from before unmount is untouched.
    expect(lastState.node.active).toBe(false);
  });
});
