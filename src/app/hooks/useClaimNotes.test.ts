import { act, renderHook, waitFor } from '@testing-library/react';

import { useClaimNotes } from './useClaimNotes';

// --- Mocked collaborators -------------------------------------------------
// useClaimNotes fans out to the claimable-notes query, the failed-transaction
// store, and the node/client note-state lookup. We mock each so we can drive
// the re-run behaviour (#456) without the SDK or IndexedDB.

const mockGetFailedTransactions = jest.fn();
const mockGetInputNoteDetails = jest.fn();
const mockInitiateConsume = jest.fn();

jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'faucet-miden' }));
jest.mock('lib/miden/activity', () => ({
  getFailedTransactions: (...args: unknown[]) => mockGetFailedTransactions(...args),
  initiateConsumeNotesTransaction: (...args: unknown[]) => mockInitiateConsume(...args),
  requestSWTransactionProcessing: jest.fn(),
  verifyStuckTransactionsFromNode: jest.fn().mockResolvedValue(0)
}));

jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: {
    getInputNoteDetails: (...args: unknown[]) => mockGetInputNoteDetails(...args)
  }
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (fn: () => unknown) => fn()
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
