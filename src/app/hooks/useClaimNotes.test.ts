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

  it('surfaces a consume that fails faster than the gate can render it', async () => {
    // The failure this exists for: an offline claim goes Queued -> Failed well under the poll, so
    // `isBeingClaimed` is never true in a sampled render and the claiming signature never moves.
    // Asserting only that the check RAN would pass without any failure existing at all -- the
    // assertion has to be that Retry actually surfaces on the note.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const notes = [note('n-miden', 'faucet-miden')];
      mockUseClaimableNotes.mockReturnValue({ data: notes, mutate: jest.fn().mockResolvedValue(notes) });
      mockInitiateConsume.mockResolvedValueOnce('tx-miden');
      mockGetFailedTransactions.mockResolvedValue([]);

      const { result } = renderHook(() => useClaimNotes());
      await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

      await act(async () => {
        await result.current.handleClaimAll();
      });
      expect(result.current.retriableNoteIds.has('n-miden')).toBe(false);

      // The consume fails immediately, without ever rendering as claiming.
      mockGetFailedTransactions.mockResolvedValue([failedConsume('n-miden')]);
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });

      await waitFor(() => expect(result.current.retriableNoteIds.has('n-miden')).toBe(true));
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not flag a note as retriable while a fresh consume for it is live', async () => {
    // `getFailedTransactions` is unscoped by time and liveness, and a manual retry ADDS a row
    // rather than replacing the failed one. So a note that failed once and is being claimed again
    // would be re-flagged from its OLD row, bringing the red "unresolved" badge back over a running
    // claim. Only reachable now that claiming keeps the user on this list.
    //
    // 'b' is the positive control: same failed-row treatment, no live claim. It must still flag, or
    // this test would pass simply because the check never ran.
    mockGetFailedTransactions.mockResolvedValue([failedConsume('a', 'b')]);
    const notes = [{ ...note('a'), isBeingClaimed: true }, note('b')];
    mockUseClaimableNotes.mockReturnValue({ data: notes, mutate: jest.fn().mockResolvedValue(notes) });

    const { result } = renderHook(() => useClaimNotes());

    await waitFor(() => expect(result.current.retriableNoteIds.has('b')).toBe(true));
    expect(result.current.retriableNoteIds.has('a')).toBe(false);
  });

  it('keeps watching a MIXED batch until every claimed note settles', async () => {
    // Claim All queues one consume PER FAUCET, so a batch settles mixed: one faucet consumed while
    // another is still running. The exit has been wrong in both directions here -- `.some` tore the
    // watch down at the first resolution, a later prune made `.every` unreachable -- and a
    // single-note fixture cannot tell those apart, because with one id `some` and `every` agree.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const both = [note('n-a', 'faucet-a'), note('n-b', 'faucet-b')];
      mockUseClaimableNotes.mockReturnValue({ data: both, mutate: jest.fn().mockResolvedValue(both) });
      mockInitiateConsume.mockResolvedValueOnce('tx-a').mockResolvedValueOnce('tx-b');

      const { result, rerender } = renderHook(() => useClaimNotes());
      await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());
      await act(async () => {
        await result.current.handleClaimAll();
      });
      await act(async () => {
        jest.advanceTimersByTime(2_500);
      });
      // Positive control: the watch must actually be RUNNING here. Without this, "the count did
      // not change" is satisfied just as well by a watch that never started.
      const whileBothRun = jest.getTimerCount();
      const callsWhileWatching = mockGetFailedTransactions.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(2_500);
      });
      expect(mockGetFailedTransactions.mock.calls.length).toBeGreaterThan(callsWhileWatching);

      // Faucet A lands; faucet B is still in flight. The watch must NOT stop here.
      const onlyB = [note('n-b', 'faucet-b')];
      mockUseClaimableNotes.mockReturnValue({ data: onlyB, mutate: jest.fn().mockResolvedValue(onlyB) });
      rerender();
      await act(async () => {
        jest.advanceTimersByTime(2_500);
      });

      expect(jest.getTimerCount()).toBe(whileBothRun);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops the post-claim watch once the claimed notes settle, instead of running to the ceiling', async () => {
    // The exit has been wrong twice with nothing to catch it: first `.some` (one resolved note
    // ended the watch for a whole multi-faucet batch), then a prune that removed done ids and made
    // `settled` unreachable so every watch ran the full 120s. Each tick is a WASM-lock-bound read.
    //
    // Counting `getFailedTransactions` cannot see this: once the list empties the check
    // early-returns before that call, so a running interval and a stopped one look identical.
    // The timer itself is the observable.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const notes = [note('a')];
      mockUseClaimableNotes.mockReturnValue({ data: notes, mutate: jest.fn().mockResolvedValue(notes) });
      mockInitiateConsume.mockResolvedValueOnce('tx-a');

      const { result, rerender } = renderHook(() => useClaimNotes());
      await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

      await act(async () => {
        await result.current.handleClaimAll();
      });
      await act(async () => {
        jest.advanceTimersByTime(2_500);
      });
      const whileWatching = jest.getTimerCount();

      // The claim lands: the note leaves the list, so the watch has nothing left to watch.
      mockUseClaimableNotes.mockReturnValue({ data: [], mutate: jest.fn().mockResolvedValue([]) });
      rerender();
      await act(async () => {
        jest.advanceTimersByTime(2_500);
      });

      expect(jest.getTimerCount()).toBeLessThan(whileWatching);
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-checks when a note stops being claimed, even though its id never left the list', async () => {
    // `claimingSignature` exists for exactly this: a consume that WAS observed as claiming and then
    // fails leaves the note claimable with the same id, so `claimableSignature` does not move and
    // the check would never re-run. The row would revert from "Claiming…" to "Claim" with no error
    // -- the #456 silent failure, reachable now that claiming keeps the user on this list.
    mockGetFailedTransactions.mockResolvedValue([]);
    const claiming = [{ ...note('a'), isBeingClaimed: true }];
    mockUseClaimableNotes.mockReturnValue({ data: claiming, mutate: jest.fn().mockResolvedValue(claiming) });

    const { result, rerender } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());
    expect(result.current.retriableNoteIds.has('a')).toBe(false);

    // The consume fails: the row leaves Queued so `isBeingClaimed` drops, the id stays listed.
    mockGetFailedTransactions.mockResolvedValue([failedConsume('a')]);
    const notClaiming = [note('a')];
    mockUseClaimableNotes.mockReturnValue({ data: notClaiming, mutate: jest.fn().mockResolvedValue(notClaiming) });
    rerender();

    await waitFor(() => expect(result.current.retriableNoteIds.has('a')).toBe(true));
  });

  it('keeps an in-flight batch gated when a DIFFERENT batch finishes settling', async () => {
    // Removing the navigation made two batches concurrently reachable (Claim All from the summary,
    // Claim Group from a detail row). Clearing the gate wholesale let the finishing batch's cleanup
    // drop the OTHER batch's ids -- an enabled Claim All over rows that were already queued.
    const notes = [note('n-a', 'faucet-a'), note('n-b', 'faucet-b')];
    mockUseClaimableNotes.mockReturnValue({ data: notes, mutate: jest.fn().mockResolvedValue(notes) });

    // B parks mid-queue so it is still in flight; A runs to completion behind it.
    const bQueued = deferred<string>();
    mockInitiateConsume.mockReturnValueOnce(bQueued.promise).mockResolvedValueOnce('tx-a');

    const { result, rerender } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    let bDone!: Promise<void>;
    await act(async () => {
      bDone = result.current.handleClaimGroup('faucet-b');
      await Promise.resolve();
    });
    expect(result.current.claimingNoteIds.has('n-b')).toBe(true);

    // A completes, and its live consume row takes over -- which is what releases A's optimistic
    // id. That release is the synchronisation point: it means A's handover has demonstrably run,
    // which is exactly the moment B's gate is at risk of going with it.
    await act(async () => {
      await result.current.handleClaimGroup('faucet-a');
    });
    const aClaiming = [{ ...note('n-a', 'faucet-a'), isBeingClaimed: true }, note('n-b', 'faucet-b')];
    mockUseClaimableNotes.mockReturnValue({
      data: aClaiming,
      mutate: jest.fn().mockResolvedValue(aClaiming)
    });
    rerender();
    await waitFor(() => expect(result.current.claimingNoteIds.has('n-a')).toBe(false));

    expect(result.current.claimingNoteIds.has('n-b')).toBe(true);

    await act(async () => {
      bQueued.resolve('tx-b');
      await bDone;
    });
  });

  it('does not start the queue driver when nothing was queued', async () => {
    const notes = [note('n-a', 'faucet-a')];
    mockUseClaimableNotes.mockReturnValue({ data: notes, mutate: jest.fn().mockResolvedValue(notes) });
    mockInitiateConsume.mockRejectedValue(new Error('queue failed'));

    const { result } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll();
    });

    // The queue path must have RUN and failed -- otherwise "no driver" is satisfied by a claim
    // that never got as far as trying.
    expect(mockInitiateConsume).toHaveBeenCalled();
    expect(mockStartBackground).not.toHaveBeenCalled();
  });

  it('holds the claim gate when the post-claim refresh never delivers live state', async () => {
    // The handoff releases the optimistic ids to `isBeingClaimed`. If the refresh REJECTS -- or is
    // discarded as belonging to a previous account -- that live state never arrives, so releasing
    // anyway leaves a queued consume with no gate at all and an enabled Claim All over it.
    const notes = [note('n-a', 'faucet-a')];
    // Only the POST-claim refresh fails. `claimNotesBatch` also refreshes before queueing, and a
    // mock that rejects on every call aborts the batch before any id is ever gated.
    const mutate = jest.fn().mockResolvedValueOnce(notes).mockRejectedValue(new Error('refresh failed'));
    mockUseClaimableNotes.mockReturnValue({ data: notes, mutate });
    mockInitiateConsume.mockResolvedValueOnce('tx-a');

    const { result, rerender } = renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleClaimAll().catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // A FRESH array, not just a re-render: the release effect is keyed on `safeClaimableNotes`,
    // and a mock returning the same object each call leaves its identity stable so the effect never
    // re-evaluates. Without this the gate survives merely because nothing re-checked it, and the
    // assertion would hold even if the release were unconditional. The note still reports
    // isBeingClaimed false, so nothing has taken over and the gate must be kept.
    mockUseClaimableNotes.mockReturnValue({
      data: [note('n-a', 'faucet-a')],
      mutate: jest.fn().mockRejectedValue(new Error('refresh failed'))
    });
    rerender();

    // The consume is queued and nothing has reported it as claiming: the optimistic gate is the
    // only thing standing between the user and a second Claim All over the same note.
    expect(result.current.claimingNoteIds.has('n-a')).toBe(true);
  });

  it('coalesces concurrent failure checks onto one pass, then runs exactly one follow-up', async () => {
    // Two round-3 P1s live here and neither had a test. The check has THREE triggers (the
    // signature effect, the post-claim watch, focus/visibility) and off-extension each pass takes
    // the WASM mutex the consume pipeline needs -- so overlapping runs are contention, not
    // parallelism. But simply joining the live promise DROPS the joining trigger's update, because
    // the running pass has already read past it. One follow-up, collapsing any number of joiners.
    const parked = deferred<never[]>();
    mockGetFailedTransactions.mockReturnValueOnce(parked.promise as never);
    setNotes('a');

    renderHook(() => useClaimNotes());
    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(1));

    // Three more triggers while the first pass is parked. All must join it, not start passes.
    mockGetFailedTransactions.mockResolvedValue([]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(mockGetFailedTransactions).toHaveBeenCalledTimes(1);

    // Releasing the parked pass runs ONE follow-up against the newest state, not three.
    await act(async () => {
      parked.resolve([]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockGetFailedTransactions).toHaveBeenCalledTimes(2));
    expect(mockGetFailedTransactions).toHaveBeenCalledTimes(2);
  });
});
