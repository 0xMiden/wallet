import { act, renderHook, waitFor } from '@testing-library/react';

import { __resetClaimChecksForTest, useClaimCheckInvalidNoteIds, useClaimNotes } from './useClaimNotes';

// --- Mocked collaborators -------------------------------------------------
// useClaimNotes fans out to the claimable-notes query, the failed-transaction
// store, and the node/client note-state lookup. We mock each so we can drive
// the re-run behaviour (#456) without the SDK or IndexedDB.

const mockGetFailedTransactions = jest.fn();
const mockGetInputNoteDetails = jest.fn();
const mockLockOptions: unknown[] = [];

jest.mock('lib/miden/activity', () => ({
  getFailedTransactions: (...args: unknown[]) => mockGetFailedTransactions(...args),
  verifyStuckTransactionsFromNode: jest.fn().mockResolvedValue(0)
}));

jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: {
    getInputNoteDetails: (...args: unknown[]) => mockGetInputNoteDetails(...args)
  }
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (fn: () => unknown, options?: unknown) => {
    mockLockOptions.push(options);
    return fn();
  }
}));

const mockUseAccount = jest.fn(() => ({ publicKey: 'mtst1account' }));
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount()
}));

const mockUseClaimableNotes = jest.fn();
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: () => mockUseClaimableNotes()
}));

jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isMobile: () => false
}));

jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => false
}));

jest.mock('lib/store', () => ({
  getIntercom: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const note = (id: string, faucetId = 'f') => ({ id, isBeingClaimed: false, amount: '1', faucetId, metadata: {} });

const failedConsume = (...noteIds: string[]) => ({ type: 'consume', noteIds });

function setNotes(...ids: string[]) {
  mockUseClaimableNotes.mockReturnValue({
    data: ids.map(id => note(id)),
    mutate: jest.fn().mockResolvedValue([])
  });
}

/** A promise plus its resolver, for pausing an async check at a known point. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useClaimNotes failed-note check (#456)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFailedTransactions.mockResolvedValue([]);
    mockGetInputNoteDetails.mockResolvedValue([]);
    setNotes('a');
  });

  it('flags a note reported by getFailedTransactions as retriable (not invalid) on mount', async () => {
    mockGetFailedTransactions.mockResolvedValue([failedConsume('a')]);

    const { result } = renderHook(() => useClaimNotes());

    await waitFor(() => expect(result.current.retriableNoteIds.has('a')).toBe(true));
    expect(result.current.invalidNoteIds.has('a')).toBe(false);
  });

  it('flags a note the client reports as Invalid as invalid (not retriable), terminally', async () => {
    mockGetInputNoteDetails.mockResolvedValue([{ noteId: 'a', state: 'Invalid' }]);

    const { result } = renderHook(() => useClaimNotes());

    await waitFor(() => expect(result.current.invalidNoteIds.has('a')).toBe(true));
    expect(result.current.retriableNoteIds.has('a')).toBe(false);
  });

  it('bounds the note-state read at the sync ceiling, like every other foreground read hold', async () => {
    mockLockOptions.length = 0;
    renderHook(() => useClaimNotes());

    await waitFor(() => expect(mockGetInputNoteDetails).toHaveBeenCalled());
    expect(mockLockOptions).toContainEqual({ label: 'claim-note-state-check', watchdogMs: 120_000 });
  });

  it('re-runs the check on signature change and REPLACES the set so a recovered note clears', async () => {
    // First check reports 'a' as failed; the second (after the list changes)
    // reports nothing — 'a' has recovered and must clear.
    mockGetFailedTransactions.mockResolvedValueOnce([failedConsume('a')]).mockResolvedValue([]);
    setNotes('a', 'b');

    const { result, rerender } = renderHook(() => useClaimNotes());

    await waitFor(() => expect(result.current.retriableNoteIds.has('a')).toBe(true));
    expect(mockGetFailedTransactions).toHaveBeenCalledTimes(1);

    // 'b' leaves the list -> claimable-id signature changes -> re-run.
    setNotes('a');
    rerender();

    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.retriableNoteIds.has('a')).toBe(false));
  });

  it('re-runs the check on window focus and picks up a newly-failed note', async () => {
    const { result } = renderHook(() => useClaimNotes());

    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(1));
    expect(result.current.retriableNoteIds.has('a')).toBe(false);

    // A consume fails while the page is backgrounded; on focus the check re-runs.
    mockGetFailedTransactions.mockResolvedValue([failedConsume('a')]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(result.current.retriableNoteIds.has('a')).toBe(true));
    expect(mockGetFailedTransactions.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the checking spinner on the first mount check but NOT on a focus re-run', async () => {
    // Pause the mount check at getFailedTransactions to observe the spinner.
    const mountGate = deferred<unknown[]>();
    mockGetFailedTransactions.mockReturnValueOnce(mountGate.promise);

    const { result } = renderHook(() => useClaimNotes());

    // Mount check is in flight -> spinner is on for the claimable notes.
    await waitFor(() => expect(result.current.checkingNoteIds.has('a')).toBe(true));

    await act(async () => {
      mountGate.resolve([]);
    });
    await waitFor(() => expect(result.current.checkingNoteIds.size).toBe(0));

    // Focus re-run: pause it the same way and assert NO spinner this time.
    const focusGate = deferred<unknown[]>();
    mockGetFailedTransactions.mockReturnValueOnce(focusGate.promise);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    // The re-run is in flight (getFailedTransactions called again) yet no spinner.
    await waitFor(() => expect(mockGetFailedTransactions.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(result.current.checkingNoteIds.size).toBe(0);

    await act(async () => {
      focusGate.resolve([]);
    });
  });

  it('reports notes as fetching only while no list has loaded, not during a background refresh', async () => {
    mockUseClaimableNotes.mockReturnValue({ data: undefined, mutate: jest.fn(), isLoading: true, isValidating: true });
    const { result, rerender } = renderHook(() => useClaimNotes());
    expect(result.current.isFetchingNotes).toBe(true);

    mockUseClaimableNotes.mockReturnValue({
      data: [note('a')],
      mutate: jest.fn(),
      isLoading: false,
      isValidating: true
    });
    rerender();
    expect(result.current.isFetchingNotes).toBe(false);
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());
  });

  it('does not report fetching while the persisted list is on screen during the first live read', async () => {
    mockUseClaimableNotes.mockReturnValue({
      data: [{ ...note('a'), fromCache: true }],
      mutate: jest.fn(),
      isLoading: true,
      isValidating: true
    });
    const { result } = renderHook(() => useClaimNotes());
    expect(result.current.isFetchingNotes).toBe(false);
    await act(async () => {});
  });

  // The batch claimer that used to live here — Claim All and the per-asset group claim — went
  // with the "Pending notes" pages it belonged to. The one bulk action left is the Activity
  // Pending list's Accept All, covered by `useActivityClaims`.
});

describe('useClaimNotes publishes its invalid set per account', () => {
  const allInvalid = (request: { ids: string[] }) => request.ids.map(noteId => ({ noteId, state: 'Invalid' }));

  /** The published set for `account`, read the way the tab's unread hook reads it. */
  function readStore(account: string) {
    return renderHook(() => useClaimCheckInvalidNoteIds(account)).result;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset, not just cleared: a run a failing case never started would leave its queued gate
    // for the next case's first call.
    mockGetFailedTransactions.mockReset();
    mockGetInputNoteDetails.mockReset();
    __resetClaimChecksForTest();
    mockUseAccount.mockReturnValue({ publicKey: 'A' });
    mockGetFailedTransactions.mockResolvedValue([]);
    mockGetInputNoteDetails.mockResolvedValue([]);
    setNotes('a');
  });

  afterAll(() => {
    mockUseAccount.mockReturnValue({ publicKey: 'mtst1account' });
  });

  it('publishes a finished check under the account that started it', async () => {
    mockGetInputNoteDetails.mockImplementation(allInvalid);
    const storeA = readStore('A');
    const storeB = readStore('B');
    renderHook(() => useClaimNotes());

    await waitFor(() => expect([...storeA.current]).toEqual(['a']));
    expect(storeB.current.size).toBe(0);
  });

  it('keeps each account right when B resolves before A after a switch', async () => {
    const gateA = deferred<unknown[]>();
    const gateB = deferred<unknown[]>();
    mockGetFailedTransactions.mockReturnValueOnce(gateA.promise).mockReturnValueOnce(gateB.promise);
    mockGetInputNoteDetails.mockImplementation(allInvalid);
    const storeA = readStore('A');
    const storeB = readStore('B');
    const { rerender } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(1));

    mockUseAccount.mockReturnValue({ publicKey: 'B' });
    setNotes('b');
    rerender();
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(2));

    await act(async () => gateB.resolve([]));
    await waitFor(() => expect([...storeB.current]).toEqual(['b']));
    await act(async () => gateA.resolve([]));
    await waitFor(() => expect([...storeA.current]).toEqual(['a']));
    expect([...storeB.current]).toEqual(['b']);
  });

  it('does not let an older run of one account overwrite the newer set', async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    mockGetFailedTransactions.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    // Whichever run reaches the note-state read first (the newer one) sees the note invalid.
    mockGetInputNoteDetails.mockResolvedValueOnce([{ noteId: 'a', state: 'Invalid' }]).mockResolvedValueOnce([]);
    const storeA = readStore('A');
    renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve([]));
    await waitFor(() => expect([...storeA.current]).toEqual(['a']));
    await act(async () => first.resolve([]));
    await waitFor(() => expect(mockGetInputNoteDetails).toHaveBeenCalledTimes(2));
    expect([...storeA.current]).toEqual(['a']);
  });

  it("starts B's own run on a switch with identical claimable ids and no focus", async () => {
    const gateA = deferred<unknown[]>();
    const gateB = deferred<unknown[]>();
    mockGetFailedTransactions.mockReturnValueOnce(gateA.promise).mockReturnValueOnce(gateB.promise);
    // B resolves first and reads the note invalid; A's read afterwards finds it fine.
    mockGetInputNoteDetails.mockResolvedValueOnce([{ noteId: 'a', state: 'Invalid' }]).mockResolvedValueOnce([]);
    const storeA = readStore('A');
    const storeB = readStore('B');
    const { rerender } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(1));

    mockUseAccount.mockReturnValue({ publicKey: 'B' });
    rerender();
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(2));

    await act(async () => gateB.resolve([]));
    await waitFor(() => expect([...storeB.current]).toEqual(['a']));
    await act(async () => gateA.resolve([]));
    await waitFor(() => expect(mockGetInputNoteDetails).toHaveBeenCalledTimes(2));
    expect(storeA.current.size).toBe(0);
    expect([...storeB.current]).toEqual(['a']);
  });

  it('re-renders a reader mounted before the publish', async () => {
    const gate = deferred<unknown[]>();
    mockGetFailedTransactions.mockReturnValueOnce(gate.promise);
    mockGetInputNoteDetails.mockImplementation(allInvalid);
    const storeA = readStore('A');
    renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(1));
    expect(storeA.current.size).toBe(0);

    await act(async () => gate.resolve([]));
    await waitFor(() => expect(storeA.current.has('a')).toBe(true));
  });
});
