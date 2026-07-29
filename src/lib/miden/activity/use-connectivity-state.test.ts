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
const mockIsExtension = jest.fn(() => false);

jest.mock('../front/storage', () => ({
  useStorage: (...args: unknown[]) => mockUseStorage(...args),
  putToStorage: (...args: unknown[]) => mockPutToStorage(...args)
}));

jest.mock('../../platform', () => ({
  isExtension: () => mockIsExtension()
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
import { CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY, useConnectivityState } from './use-connectivity-state';

let storageSnapshot: ConnectivityStateSnapshot | null;
let storedDismissedActivations: Partial<Record<ConnectivityCategory, number | null>>;
const mockSetStoredDismissedActivations = jest.fn().mockResolvedValue(undefined);

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
  mockSetStoredDismissedActivations.mockResolvedValue(undefined);
  mockIsExtension.mockReturnValue(false);
  storageSnapshot = null;
  storedDismissedActivations = {};
  // Default: storage mirror is empty, so the hook falls back to the in-memory
  // machine. Individual tests override this before rendering.
  mockUseStorage.mockImplementation((key: string) =>
    key === CONNECTIVITY_STATE_KEY
      ? [storageSnapshot, jest.fn()]
      : [storedDismissedActivations, mockSetStoredDismissedActivations]
  );
  resetConnectivityState();
});

describe('useConnectivityState', () => {
  it('starts from the synchronous in-memory snapshot when storage is empty', () => {
    const { result } = renderHook(() => useConnectivityState());

    expect(mockUseStorage).toHaveBeenCalledWith(CONNECTIVITY_STATE_KEY, null);
    expect(mockUseStorage).toHaveBeenCalledWith(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY, {});
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
    mockIsExtension.mockReturnValue(true);
    const storageSnap = makeSnapshot({ prover: true });
    storageSnapshot = storageSnap;

    const { result } = renderHook(() => useConnectivityState());

    // Same object reference — merged is `storageSnapshot ?? memorySnapshot`.
    expect(result.current.state).toBe(storageSnap);
    expect(result.current.hasAnyIssue).toBe(true);
  });

  it('storage snapshot wins even while the in-memory machine reports a different state', () => {
    mockIsExtension.mockReturnValue(true);
    const storageSnap = makeSnapshot(); // all clear
    storageSnapshot = storageSnap;

    const { result } = renderHook(() => useConnectivityState());

    // Push an in-memory issue: the subscriber fires and re-renders, but storage
    // still wins so `hasAnyIssue` stays false.
    act(() => {
      markConnectivityIssue('prover');
    });

    expect(result.current.state).toBe(storageSnap);
    expect(result.current.hasAnyIssue).toBe(false);
  });

  it('uses live in-process state off-extension instead of a stale storage snapshot', () => {
    storageSnapshot = makeSnapshot({ node: true });
    const { result } = renderHook(() => useConnectivityState());

    expect(result.current.state.node.active).toBe(false);
    act(() => markConnectivityIssue('network'));
    expect(result.current.state.network.active).toBe(true);
  });

  describe('hasAnyIssue reflects each category independently', () => {
    it.each(CONNECTIVITY_CATEGORIES)('is true when only "%s" is active', category => {
      mockIsExtension.mockReturnValue(true);
      storageSnapshot = makeSnapshot({ [category]: true });

      const { result } = renderHook(() => useConnectivityState());

      expect(result.current.hasAnyIssue).toBe(true);
    });

    it('is false when every category is inactive', () => {
      storageSnapshot = makeSnapshot();

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

  it('dismiss hides the current failure episode without clearing the underlying machine', () => {
    const { result } = renderHook(() => useConnectivityState());

    act(() => {
      markConnectivityIssue('network');
    });
    expect(result.current.hasAnyIssue).toBe(true);

    act(() => {
      result.current.dismiss('network');
    });

    expect(getConnectivityState().network.active).toBe(true);
    expect(result.current.state.network.active).toBe(false);
    expect(result.current.hasAnyIssue).toBe(false);
    expect(mockSetStoredDismissedActivations).toHaveBeenCalledWith({
      network: getConnectivityState().network.since
    });
  });

  it('keeps a dismissed extension episode hidden after the hook remounts', () => {
    mockIsExtension.mockReturnValue(true);
    storageSnapshot = makeSnapshot({ node: true });

    const first = renderHook(() => useConnectivityState());
    act(() => first.result.current.dismiss('node'));
    expect(first.result.current.state.node.active).toBe(false);

    storedDismissedActivations = mockSetStoredDismissedActivations.mock.calls.at(-1)![0];
    first.unmount();
    const second = renderHook(() => useConnectivityState());

    expect(second.result.current.state.node.active).toBe(false);
    expect(second.result.current.hasAnyIssue).toBe(false);
  });

  it('dismiss is a no-op when the category was already clear', () => {
    const { result } = renderHook(() => useConnectivityState());
    const stateBefore = result.current.state;

    act(() => {
      result.current.dismiss('prover');
    });

    expect(getConnectivityState().prover.active).toBe(false);
    expect(result.current.state).toBe(stateBefore);
    expect(mockSetStoredDismissedActivations).not.toHaveBeenCalled();
  });

  it('shows a later failure after the dismissed episode has recovered', () => {
    const { result } = renderHook(() => useConnectivityState());

    act(() => markConnectivityIssue('network'));
    act(() => result.current.dismiss('network'));
    expect(result.current.state.network.active).toBe(false);

    act(() => resetConnectivityState());
    act(() => markConnectivityIssue('network'));

    expect(result.current.state.network.active).toBe(true);
  });

  it('settles on a fresh profile under the real useStorage contract (regression: fresh-profile render loop)', () => {
    // Complements the stable-fallback identity test below by simulating what
    // real useStorage returns on a profile where nothing has ever been
    // dismissed: the key is absent, so the hook receives `data ?? fallback` —
    // the fallback object itself, not a closed-over stable stub. With the old
    // inline `{}` fallback this mount loops until React throws "Maximum update
    // depth exceeded"; with the hoisted constant it settles in one pass.
    mockUseStorage.mockImplementation((key: string, fallback: unknown) =>
      key === CONNECTIVITY_STATE_KEY ? [null, jest.fn()] : [fallback, mockSetStoredDismissedActivations]
    );

    const { result, rerender } = renderHook(() => useConnectivityState());
    rerender();

    expect(result.current.hasAnyIssue).toBe(false);
    expect(mockSetStoredDismissedActivations).not.toHaveBeenCalled();
  });

  it('keeps a stable dismiss reference across re-renders', () => {
    const { result, rerender } = renderHook(() => useConnectivityState());
    const first = result.current.dismiss;
    rerender();
    expect(result.current.dismiss).toBe(first);
  });

  it('passes a stable dismissed-activations fallback across re-renders (guards the render-loop fix)', () => {
    // Regression guard for the fresh-profile render loop: the hook used to pass
    // an inline `{}` fallback to useStorage, a new object every render. Since
    // useStorage returns `data ?? fallback`, that churned identity on every
    // render while the key was absent and made the storage-sync effect setState
    // forever ("Maximum update depth exceeded"). The fix hoists the fallback to
    // a module-level constant, so every render MUST pass the same reference.
    // (Reverting to an inline `{}` makes this test fail; the deep-equality
    // `toHaveBeenCalledWith(..., {})` assertion above does not.)
    const { rerender } = renderHook(() => useConnectivityState());
    rerender();
    rerender();

    const fallbacks = mockUseStorage.mock.calls
      .filter(call => call[0] === CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY)
      .map(call => call[1]);

    expect(fallbacks.length).toBeGreaterThan(1);
    for (const fallback of fallbacks) expect(fallback).toBe(fallbacks[0]);
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
