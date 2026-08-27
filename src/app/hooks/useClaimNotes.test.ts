import { act, renderHook, waitFor } from '@testing-library/react';

import { useClaimNotes } from './useClaimNotes';
import type { ReportClaim } from './useReportNoteClaim';

// --- Mocked collaborators -------------------------------------------------
// useClaimNotes fans out to the claimable-notes query, the failed-transaction
// store, and the node/client note-state lookup. We mock each so we can drive
// the re-run behaviour (#456) without the SDK or IndexedDB.

const mockGetFailedTransactions = jest.fn();
const mockGetInputNoteDetails = jest.fn();
const mockInitiateConsume = jest.fn();

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

const note = (id: string) => ({ id, isBeingClaimed: false, amount: '1', faucetId: 'f', metadata: {} });

const failedConsume = (...noteIds: string[]) => ({ type: 'consume', noteIds });

function setNotes(...ids: string[]) {
  mockUseClaimableNotes.mockReturnValue({
    data: ids.map(note),
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

  it('keeps a queue-time claim failure retriable across a focus re-run — does not wipe it (#456)', async () => {
    // A batch claim that throws at queue time rolls back its Dexie transaction,
    // so NO Failed row is persisted — getFailedTransactions can never re-surface
    // it. The retriable flag lives only in memory and must survive the
    // REPLACE-based focus/visibility recheck, or the note silently reverts to a
    // neutral Claim button (the exact regression #456 must not introduce).
    mockGetFailedTransactions.mockResolvedValue([]); // no durable Failed row
    mockUseClaimableNotes.mockReturnValue({
      data: [note('a')],
      mutate: jest.fn().mockResolvedValue([note('a')]) // batch must see the note to queue it
    });
    mockInitiateConsume.mockRejectedValueOnce(new Error('queue failed'));

    const { result } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    // Queue-time throw flags 'a' retriable in memory.
    await act(async () => {
      await result.current.handleClaimAll();
    });
    await waitFor(() => expect(result.current.retriableNoteIds.has('a')).toBe(true));

    // Tab-return recheck (getFailedTransactions still empty): the flag must persist.
    const callsBefore = mockGetFailedTransactions.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(mockGetFailedTransactions.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(result.current.retriableNoteIds.has('a')).toBe(true); // NOT wiped
  });
});

describe('useClaimNotes batch-claim reporting', () => {
  // The hosting page owns the note_handle flow and passes in a reporter; the
  // hook's job is to route the queue attempt through it, outcome included. The
  // queue-time throw is caught internally, so the reporter has to wrap the
  // consume call itself rather than the whole batch — otherwise every failure
  // would look like a success.
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFailedTransactions.mockResolvedValue([]);
    mockGetInputNoteDetails.mockResolvedValue([]);
    mockUseClaimableNotes.mockReturnValue({
      data: [note('a')],
      mutate: jest.fn().mockResolvedValue([note('a')])
    });
  });

  it('routes the batch queue attempt through the reporter', async () => {
    mockInitiateConsume.mockResolvedValue('batch-tx');
    const reported = jest.fn();
    const reportClaim: ReportClaim = attempt => {
      reported();
      return attempt();
    };

    const { result } = renderHook(() => useClaimNotes(reportClaim));
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll();
    });

    expect(reported).toHaveBeenCalledTimes(1);
    expect(mockInitiateConsume).toHaveBeenCalledTimes(1);
  });

  it('lets the reporter see a queue-time failure', async () => {
    mockInitiateConsume.mockRejectedValue(new Error('queue failed'));
    const seen: unknown[] = [];
    const reportClaim: ReportClaim = async attempt => {
      try {
        return await attempt();
      } catch (err) {
        seen.push(err);
        throw err;
      }
    };

    const { result } = renderHook(() => useClaimNotes(reportClaim));
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll();
    });

    expect(seen.length).toBeGreaterThan(0);
    // The hook still absorbs it: the note stays retriable rather than throwing out.
    await waitFor(() => expect(result.current.retriableNoteIds.has('a')).toBe(true));
  });

  it('claims normally when no reporter is supplied', async () => {
    mockInitiateConsume.mockResolvedValue('batch-tx');

    const { result } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll();
    });

    expect(mockInitiateConsume).toHaveBeenCalledTimes(1);
  });
});
