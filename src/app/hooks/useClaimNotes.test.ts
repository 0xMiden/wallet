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
const mockRequestSW = jest.fn();
const mockStartBackground = jest.fn();
jest.mock('lib/miden/activity', () => ({
  getFailedTransactions: (...args: unknown[]) => mockGetFailedTransactions(...args),
  initiateConsumeNotesTransaction: (...args: unknown[]) => mockInitiateConsume(...args),
  requestSWTransactionProcessing: (...args: unknown[]) => mockRequestSW(...args),
  startBackgroundTransactionProcessing: (...args: unknown[]) => mockStartBackground(...args),
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
const mockSignTransaction = jest.fn();
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount(),
  useMidenContext: () => ({ signTransaction: mockSignTransaction })
}));

jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { kind: 'zustand' } }));

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

const mockNavigate = jest.requireMock('lib/woozie').navigate as jest.Mock;
/** Note ids passed as the 2nd arg of the n-th initiateConsumeNotesTransaction call. */
const queuedNoteIds = (call: number) => (mockInitiateConsume.mock.calls[call]![1] as { id: string }[]).map(n => n.id);

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

  // "Claim All" can span several faucets, but a completed consume row carries a
  // single (faucetId, amount) pair derived from the FIRST input note, so a
  // mixed-faucet batch recorded only the first asset and dropped the rest from
  // history entirely. One transaction per faucet keeps each row honest.
  it('claims the native-asset group first so the vault can pay the other fees', async () => {
    // The fee comes out of the account's own vault. A non-native group attempted
    // first on an empty vault fails, even though a MIDEN note is sitting right there
    // that would have funded it -- and which group ran first was decided by note
    // arrival order, so this failed intermittently rather than always.
    const notes = [note('n-usdc', 'faucet-usdc'), note('n-miden', 'faucet-miden')];
    mockUseClaimableNotes.mockReturnValue({
      data: notes,
      mutate: jest.fn().mockResolvedValue(notes)
    });
    mockInitiateConsume.mockResolvedValueOnce('tx-miden').mockResolvedValueOnce('tx-usdc');

    const { result } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll();
    });

    expect(mockInitiateConsume).toHaveBeenCalledTimes(2);
    expect(queuedNoteIds(0)).toEqual(['n-miden']);
    expect(queuedNoteIds(1)).toEqual(['n-usdc']);
  });

  it("queues one consume transaction per faucet, grouping that faucet's notes together", async () => {
    const notes = [note('n-miden', 'faucet-miden'), note('n-usdc', 'faucet-usdc'), note('n-miden-2', 'faucet-miden')];
    mockUseClaimableNotes.mockReturnValue({
      data: notes,
      mutate: jest.fn().mockResolvedValue(notes)
    });
    mockInitiateConsume.mockResolvedValueOnce('tx-miden').mockResolvedValueOnce('tx-usdc');

    const { result } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll();
    });

    expect(mockInitiateConsume).toHaveBeenCalledTimes(2);
    expect(queuedNoteIds(0)).toEqual(['n-miden', 'n-miden-2']);
    expect(queuedNoteIds(1)).toEqual(['n-usdc']);
    // Claiming no longer hijacks the screen: the user stays on Pending Notes and the row
    // reports progress in place. Off-extension the queue needs a driver, since the progress
    // page's own interval used to be the only thing turning the FIFO loop in this path.
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockStartBackground).toHaveBeenCalledWith(mockSignTransaction, false, { kind: 'zustand' });
  });

  it('still queues a SINGLE transaction when every pending note shares one faucet', async () => {
    const notes = [note('a', 'faucet-miden'), note('b', 'faucet-miden')];
    mockUseClaimableNotes.mockReturnValue({
      data: notes,
      mutate: jest.fn().mockResolvedValue(notes)
    });
    mockInitiateConsume.mockResolvedValue('tx-1');

    const { result } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll();
    });

    expect(mockInitiateConsume).toHaveBeenCalledTimes(1);
    expect(queuedNoteIds(0)).toEqual(['a', 'b']);
  });

  it('flags only the failing faucet group when one group throws at queue time', async () => {
    const notes = [note('n-miden', 'faucet-miden'), note('n-usdc', 'faucet-usdc')];
    mockUseClaimableNotes.mockReturnValue({
      data: notes,
      mutate: jest.fn().mockResolvedValue(notes)
    });
    mockInitiateConsume.mockRejectedValueOnce(new Error('queue failed')).mockResolvedValueOnce('tx-usdc');

    const { result } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll();
    });

    await waitFor(() => expect(result.current.retriableNoteIds.has('n-miden')).toBe(true));
    expect(result.current.retriableNoteIds.has('n-usdc')).toBe(false);
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

  it('re-checks for a failed consume after claiming, for a failure faster than the gate renders', async () => {
    // Offline claim: the row goes Queued -> Failed in well under the 3s claimable-notes poll, so
    // `isBeingClaimed` is never true in any sampled render and the claiming signature never moves.
    // Without a post-claim re-check the failure is invisible to a user who now stays on this list.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const notes = [note('n-miden', 'faucet-miden')];
      mockUseClaimableNotes.mockReturnValue({ data: notes, mutate: jest.fn().mockResolvedValue(notes) });
      mockInitiateConsume.mockResolvedValueOnce('tx-miden');

      const { result } = renderHook(() => useClaimNotes());
      await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

      await act(async () => {
        await result.current.handleClaimAll();
      });

      const afterClaim = mockGetFailedTransactions.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(11_000);
      });

      expect(mockGetFailedTransactions.mock.calls.length).toBeGreaterThan(afterClaim);
    } finally {
      jest.useRealTimers();
    }
  });
});
