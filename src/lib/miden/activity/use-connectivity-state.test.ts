/* eslint-disable import/first */
import { act, renderHook } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Storage module mock.
//
// The hook pulls `useStorage` (the SW->popup mirror channel), `fetchFromStorage`
// and `putToStorage` (both used by the dismissed-activations turn) from
// `../front/storage`. We stub all three so reads and writes go through one
// in-memory record that settles asynchronously, and the test drives the
// storage snapshot deterministically without the SWR/suspense + chrome.storage
// plumbing.
//
// NOTE: `connectivity-state.ts` also imports `putToStorage` from the SAME
// module (via the `lib/miden/front/storage` alias, which jest resolves to the
// same file). Mocking it here therefore also neutralises the fire-and-forget
// storage mirror inside the real state machine's `notify()`.
// ---------------------------------------------------------------------------
const mockUseStorage = jest.fn();
// One stored record per key, shared by every hook instance (every "window"), read and written on a later microtask
// like a real storage round trip.
const mockStoredValues: Record<string, unknown> = {};
const mockFetchFromStorage = jest.fn(async (key: string) => {
  await Promise.resolve();
  return key in mockStoredValues ? mockStoredValues[key] : null;
});
const putToMockStore = async (key: string, value: unknown) => {
  await Promise.resolve();
  mockStoredValues[key] = value;
};
const mockPutToStorage = jest.fn(putToMockStore);
const mockIsExtension = jest.fn(() => false);

jest.mock('../front/storage', () => ({
  // The real turn: the Web Lock a test installs, or without one the storage module's in-realm chain.
  inStorageTurn: jest.requireActual('../front/storage').inStorageTurn,
  useStorage: (...args: unknown[]) => mockUseStorage(...args),
  fetchFromStorage: (key: string) => mockFetchFromStorage(key),
  putToStorage: (key: string, value: unknown) => mockPutToStorage(key, value)
}));

jest.mock('../../platform', () => ({
  isExtension: () => mockIsExtension()
}));

import { SharedEarnLocks } from 'lib/epoch/testing/earn-locks';

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
let storedDismissedActivations: unknown;
let locks: SharedEarnLocks;
// Every write of the record goes through the hook's storage turn; a regression to the unlocked useStorage setter fails
// loudly instead of landing in the store.
const mockSetStoredDismissedActivations = jest.fn(() => {
  throw new Error('the hook must write through the dismissed-activations turn');
});

/** Build a fresh all-clear snapshot, optionally flipping some categories on. */
function makeSnapshot(active: Partial<Record<ConnectivityCategory, boolean>> = {}): ConnectivityStateSnapshot {
  const snap = {} as ConnectivityStateSnapshot;
  for (const cat of CONNECTIVITY_CATEGORIES) {
    snap[cat] = active[cat] ? { active: true, since: 123 } : { active: false, since: null };
  }
  return snap;
}

/** Let every pending storage turn run to completion. */
const settle = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)));

beforeEach(() => {
  jest.clearAllMocks();
  mockIsExtension.mockReturnValue(false);
  // A test may replace the write path; clearAllMocks keeps implementations, so restore the store-backed one.
  mockPutToStorage.mockImplementation(putToMockStore);
  storageSnapshot = null;
  storedDismissedActivations = {};
  for (const key of Object.keys(mockStoredValues)) delete mockStoredValues[key];
  // One lock manager for every hook instance, as navigator.locks is for the extension's pages.
  locks = new SharedEarnLocks();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
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

  it('dismiss hides the current failure episode without clearing the underlying machine', async () => {
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
    await settle();
    expect(mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY]).toEqual({
      network: getConnectivityState().network.since
    });
  });

  it('keeps a dismissed extension episode hidden after the hook remounts', async () => {
    mockIsExtension.mockReturnValue(true);
    storageSnapshot = makeSnapshot({ node: true });

    const first = renderHook(() => useConnectivityState());
    act(() => first.result.current.dismiss('node'));
    await settle();
    expect(first.result.current.state.node.active).toBe(false);

    expect(mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY]).toEqual({ node: 123 });
    storedDismissedActivations = { node: 123 };
    first.unmount();
    const second = renderHook(() => useConnectivityState());

    expect(second.result.current.state.node.active).toBe(false);
    expect(second.result.current.hasAnyIssue).toBe(false);
  });

  it('dismiss is a no-op when the category was already clear', async () => {
    const { result } = renderHook(() => useConnectivityState());
    const stateBefore = result.current.state;

    act(() => {
      result.current.dismiss('prover');
    });

    expect(getConnectivityState().prover.active).toBe(false);
    expect(result.current.state).toBe(stateBefore);
    await settle();
    expect(mockPutToStorage).not.toHaveBeenCalledWith(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY, expect.anything());
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

  it('settles on a fresh profile under the real useStorage contract (regression: fresh-profile render loop)', async () => {
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
    await settle();
    expect(mockPutToStorage).not.toHaveBeenCalledWith(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY, expect.anything());
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

  // #1158: every write reads the stored record in a turn that every window shares, so one window never puts back a
  // category another window just changed.
  describe('across windows', () => {
    const stored = () => mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY];
    const putCallsFor = (key: string) => mockPutToStorage.mock.calls.filter(([k]) => k === key);
    // Another window's write re-delivers the whole stored record to every window, as the change event does.
    const redeliver = (hook: { rerender: () => void }) => {
      storedDismissedActivations = Object.assign({}, stored());
      hook.rerender();
    };

    beforeEach(() => {
      mockIsExtension.mockReturnValue(true);
    });

    it('keeps both dismissals when two windows dismiss different categories at once', async () => {
      storageSnapshot = makeSnapshot({ network: true, node: true });
      const popup = renderHook(() => useConnectivityState());
      const sidePanel = renderHook(() => useConnectivityState());

      act(() => {
        popup.result.current.dismiss('network');
        sidePanel.result.current.dismiss('node');
      });
      await settle();

      expect(stored()).toEqual({ network: 123, node: 123 });
      // Every window here shares one module, so its in-realm chain would serialize them too: pin that each turn took
      // the Web Lock, which is what serializes separate extension windows.
      expect(locks.requests.filter(name => name === 'turn:miden-connectivity-dismissed-activations')).toHaveLength(2);

      // The change event delivers the record to every window, the writer included.
      storedDismissedActivations = { network: 123, node: 123 };
      popup.rerender();
      sidePanel.rerender();

      expect(popup.result.current.state.network.active).toBe(false);
      expect(popup.result.current.state.node.active).toBe(false);
      expect(sidePanel.result.current.state.network.active).toBe(false);
      expect(sidePanel.result.current.state.node.active).toBe(false);
    });

    it('hides both of two quick dismissals in one window', async () => {
      storageSnapshot = makeSnapshot({ network: true, node: true });
      const { result } = renderHook(() => useConnectivityState());
      const { dismiss } = result.current;

      act(() => {
        dismiss('network');
        dismiss('node');
      });

      expect(result.current.state.network.active).toBe(false);
      expect(result.current.state.node.active).toBe(false);
      await settle();
      expect(stored()).toEqual({ network: 123, node: 123 });
    });

    it('keeps a newer dismissal another window stored when this window sees the old activation recover', async () => {
      // This window still holds the dismissal of network's old activation (123), which has recovered; another window
      // has meanwhile stored a dismissal of a newer activation (456).
      storedDismissedActivations = { network: 123 };
      mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY] = { network: 456 };
      storageSnapshot = makeSnapshot();

      renderHook(() => useConnectivityState());
      await settle();

      expect(stored()).toEqual({ network: 456 });
      // The turn read the newer stored value and decided nothing changes for it, so it writes nothing back.
      expect(mockPutToStorage).not.toHaveBeenCalledWith(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY, expect.anything());
    });

    it('forgets a recovered dismissal that storage still holds as this window saw it', async () => {
      storedDismissedActivations = { network: 123 };
      mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY] = { network: 123, node: 789 };
      storageSnapshot = makeSnapshot({ node: true });

      renderHook(() => useConnectivityState());
      await settle();

      expect(stored()).toEqual({ node: 789 });
      expect(locks.requests).toContain('turn:miden-connectivity-dismissed-activations');
    });

    it('never replaces a newer stored dismissal with an older one', async () => {
      storageSnapshot = makeSnapshot({ network: true });
      mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY] = { network: 456 };
      const { result } = renderHook(() => useConnectivityState());

      act(() => result.current.dismiss('network'));
      await settle();

      expect(stored()).toEqual({ network: 456 });
      expect(mockPutToStorage).not.toHaveBeenCalledWith(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY, expect.anything());
    });

    it('keeps the dismissal when the write fails', async () => {
      storageSnapshot = makeSnapshot({ network: true });
      mockPutToStorage.mockRejectedValueOnce(new Error('quota'));
      const { result } = renderHook(() => useConnectivityState());

      act(() => result.current.dismiss('network'));
      await settle();

      expect(result.current.state.network.active).toBe(false);
      expect(putCallsFor(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY)).toHaveLength(1);
    });

    it('does not retry the cleanup write when it fails', async () => {
      mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY] = { network: 100 };
      storedDismissedActivations = { network: 100 };
      storageSnapshot = makeSnapshot();
      mockPutToStorage.mockRejectedValueOnce(new Error('quota'));

      renderHook(() => useConnectivityState());
      await settle();

      expect(putCallsFor(CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY)).toHaveLength(1);
    });

    it('hides the banner where the user tapped even when the record holds a later since', async () => {
      // A dismissal from before a clock step back holds a later since (999) than the current outage's (123).
      storedDismissedActivations = { network: 999 };
      mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY] = { network: 999 };
      storageSnapshot = makeSnapshot({ network: true });
      const { result } = renderHook(() => useConnectivityState());

      act(() => result.current.dismiss('network'));
      await settle();

      expect(result.current.state.network.active).toBe(false);
    });

    it('keeps a dismissal storage did not take when another write re-delivers the record', async () => {
      // This window still renders network's old activation (123) while the mirror and another window's dismissal have
      // moved on to 999, so storage keeps 999; node's dismissal is stored.
      mockStoredValues[CONNECTIVITY_STATE_KEY] = {
        ...makeSnapshot({ node: true }),
        network: { active: true, since: 999 }
      };
      storedDismissedActivations = { network: 999 };
      mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY] = { network: 999 };
      storageSnapshot = makeSnapshot({ network: true, node: true });
      const hook = renderHook(() => useConnectivityState());

      act(() => {
        hook.result.current.dismiss('network');
        hook.result.current.dismiss('node');
      });
      await settle();
      expect(stored()).toEqual({ network: 999, node: 123 });
      redeliver(hook);

      expect(hook.result.current.state.network.active).toBe(false);
      expect(hook.result.current.state.node.active).toBe(false);
    });

    it('keeps a dismissal whose write failed when another window writes', async () => {
      storageSnapshot = makeSnapshot({ network: true });
      mockPutToStorage.mockRejectedValueOnce(new Error('quota'));
      const hook = renderHook(() => useConnectivityState());

      act(() => hook.result.current.dismiss('network'));
      await settle();
      mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY] = { node: 124 };
      redeliver(hook);

      expect(hook.result.current.state.network.active).toBe(false);
    });

    it('shows a newer activation this window jumps to without rendering the recovery between', async () => {
      storageSnapshot = makeSnapshot({ network: true });
      const hook = renderHook(() => useConnectivityState());
      act(() => hook.result.current.dismiss('network'));
      await settle();

      // The mirror went from 123 through a recovery to 999, and this window's change events landed in one render.
      storageSnapshot = { ...makeSnapshot(), network: { active: true, since: 999 } };
      redeliver(hook);

      expect(hook.result.current.state.network.active).toBe(true);
    });
  });

  it('reads a malformed stored record as nothing dismissed, and stores a well-formed one on dismiss', async () => {
    // An older build or a hand-edited profile left something other than a record under the key.
    storedDismissedActivations = 'not-a-record';
    mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY] = 'not-a-record';
    const { result } = renderHook(() => useConnectivityState());

    act(() => markConnectivityIssue('network'));
    expect(result.current.state.network.active).toBe(true);
    act(() => result.current.dismiss('network'));
    await settle();

    expect(result.current.state.network.active).toBe(false);
    expect(mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY]).toEqual({
      network: getConnectivityState().network.since
    });
  });

  it('forgets its own recovered dismissal off the extension, where the stored record never re-delivers', async () => {
    const { result } = renderHook(() => useConnectivityState());
    act(() => markConnectivityIssue('network'));
    act(() => result.current.dismiss('network'));
    await settle();
    expect(mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY]).toEqual({
      network: getConnectivityState().network.since
    });

    act(() => resetConnectivityState());
    await settle();

    expect(mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY]).toEqual({});
  });

  it('renders without throwing when navigator.locks is unavailable (iOS 15.0-15.3), hides a dismissed category and stores its dismissal', async () => {
    // No Web Locks at all: the turn runs on the storage module's in-realm chain. Off-extension (the default here)
    // `merged` comes from the in-process machine, so `markConnectivityIssue` below actually makes a category active
    // for `dismiss` to act on.
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    storedDismissedActivations = { network: 123 };

    const { result } = renderHook(() => useConnectivityState());
    await settle();

    act(() => markConnectivityIssue('node'));
    act(() => result.current.dismiss('node'));

    expect(result.current.state.node.active).toBe(false);
    await settle();
    expect(mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY]).toEqual({
      node: getConnectivityState().node.since
    });
  });

  it('keeps both of two overlapping turns without Web Locks', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const { result } = renderHook(() => useConnectivityState());
    act(() => {
      markConnectivityIssue('network');
      markConnectivityIssue('node');
    });

    act(() => {
      result.current.dismiss('network');
      result.current.dismiss('node');
    });
    await settle();

    expect(mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY]).toEqual({
      network: getConnectivityState().network.since,
      node: getConnectivityState().node.since
    });
  });

  it('stores the next dismissal after a refused write without Web Locks', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const { result } = renderHook(() => useConnectivityState());
    act(() => {
      markConnectivityIssue('network');
      markConnectivityIssue('node');
    });
    // Only the dismissal record's first write is refused; the connectivity mirror writes through the same mock.
    let refused = false;
    mockPutToStorage.mockImplementation(async (key: string, value: unknown) => {
      await Promise.resolve();
      if (key === CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY && !refused) {
        refused = true;
        throw new Error('quota');
      }
      return putToMockStore(key, value);
    });

    act(() => result.current.dismiss('network'));
    await settle();
    act(() => result.current.dismiss('node'));
    await settle();

    expect(mockStoredValues[CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY]).toEqual({
      node: getConnectivityState().node.since
    });
    expect(mockPutToStorage.mock.calls.filter(([key]) => key === CONNECTIVITY_DISMISSED_ACTIVATIONS_KEY)).toHaveLength(
      2
    );
  });
});
