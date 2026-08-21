import React from 'react';

import { render, screen, act, waitFor, cleanup } from '@testing-library/react';

// Imported AFTER the mocks are registered.
import History from './History';
import { HistoryEntryType } from './IHistoryEntry';

// ---------------------------------------------------------------------------
// Mock-prefixed collaborators (so the hoisted jest.mock factories may close
// over them). History.tsx is a memo component whose only exported symbol is the
// default component; the module-internal fetch/merge helpers are exercised
// through it by mocking `useRetryableSWR` to actually run the SWR fetchers.
// ---------------------------------------------------------------------------
const mockGetCompletedTransactions = jest.fn();
const mockGetUncompletedTransactions = jest.fn();
const mockCancelTransactionById = jest.fn().mockResolvedValue(undefined);
const mockSuppressingLinkedTxIds = jest.fn();
const mockGetTokenMetadata = jest.fn();
const mockFormatAmount = jest.fn();
const mockResolveSwapHistoryFields = jest.fn();
const mockIsFaucetRequest = jest.fn();
const mockFormatTransactionStatus = jest.fn();
const mockEarnWithdrawAmountFields = jest.fn();
const mockResolveConsumeExtraAmounts = jest.fn();

// Latest props seen by the mocked HistoryView child, so tests can invoke its
// `loadMore` callback and read back the filtered/sorted `entries`.
let mockHistoryViewProps: any;

// ---------------------------------------------------------------------------
// `lib/swr` — a real hook implementation that runs the fetcher on mount (and on
// `mutate`), storing the result in state. This is what drives coverage of the
// module-internal `fetchTransactionsAsHistoryEntries` /
// `fetchPendingTransactionsAsHistoryEntries` helpers.
// ---------------------------------------------------------------------------
const mockUseRetryableSWR = jest.fn((key: unknown, fetcher: () => Promise<unknown>) => {
  const keyStr = JSON.stringify(key);
  const [state, setState] = React.useState<{ data: unknown; isLoading: boolean }>({
    data: undefined,
    isLoading: true
  });
  const [tick, setTick] = React.useState(0);
  const mutateRef = React.useRef<jest.Mock>();
  if (!mutateRef.current) mutateRef.current = jest.fn(() => setTick(t => t + 1));

  React.useEffect(() => {
    let active = true;
    Promise.resolve(fetcher()).then(data => {
      if (active) setState({ data, isLoading: false });
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyStr, tick]);

  return { data: state.data, isLoading: state.isLoading, mutate: mutateRef.current };
});

jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: [unknown, () => Promise<unknown>]) => mockUseRetryableSWR(...args)
}));

// `react-i18next` is imported (top-level) by `app/defaults`; echo keys back.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/miden/activity', () => ({
  cancelTransactionById: (...args: unknown[]) => mockCancelTransactionById(...args),
  suppressingLinkedTxIds: (...args: unknown[]) => mockSuppressingLinkedTxIds(...args),
  getCompletedTransactions: (...args: unknown[]) => mockGetCompletedTransactions(...args),
  getUncompletedTransactions: (...args: unknown[]) => mockGetUncompletedTransactions(...args),
  // Real (pure) implementations so the cancelled-row mapping is exercised
  // against the production sentinel string.
  USER_CANCELLED_TRANSACTION_REASON: 'Transaction was cancelled by user',
  isUserCancelledTransaction: (error: unknown) => error === 'Transaction was cancelled by user'
}));

jest.mock('lib/miden/db/types', () => ({
  ITransactionStatus: { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3 },
  formatTransactionStatus: (...args: unknown[]) => mockFormatTransactionStatus(...args)
}));

jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: (...args: unknown[]) => mockGetTokenMetadata(...args)
}));

jest.mock('lib/shared/format', () => ({
  formatAmount: (...args: unknown[]) => mockFormatAmount(...args)
}));

jest.mock('./transactionUtils', () => ({
  isFaucetRequest: (...args: unknown[]) => mockIsFaucetRequest(...args),
  resolveSwapHistoryFields: (...args: unknown[]) => mockResolveSwapHistoryFields(...args),
  earnWithdrawAmountFields: (...args: unknown[]) => mockEarnWithdrawAmountFields(...args),
  // Pure derivation the swap-chip assertions below depend on, so run the real
  // one rather than restating its rules in a stub.
  swapSettlementOf: jest.requireActual('./transactionUtils').swapSettlementOf,
  resolveConsumeExtraAmounts: (...args: unknown[]) => mockResolveConsumeExtraAmounts(...args)
}));

// Thin HistoryView stub: capture props (for `loadMore`) and surface each entry
// key so tests can assert filtering/sorting/slicing outcomes.
jest.mock('./HistoryView', () => ({
  __esModule: true,
  default: (props: any) => {
    mockHistoryViewProps = props;
    return (
      <div
        data-testid="history-view"
        data-initial-loading={String(props.initialLoading)}
        data-has-more={String(props.hasMore)}
        data-full-history={String(props.fullHistory)}
        data-center-empty={String(props.centerEmptyState)}
        data-class={props.className ?? ''}
      >
        {props.entries.map((e: any) => (
          <div key={e.key} data-testid="entry" data-entry-key={e.key}>
            {`${e.key}|${e.message}|${e.token ?? ''}|${e.amount ?? ''}|${e.transactionIcon ?? ''}|` +
              `${e.type}|${e.secondaryMessage ?? ''}|${e.requestedAmount ?? ''}|${e.requestedToken ?? ''}`}
          </div>
        ))}
      </div>
    );
  }
}));

// Enum values must match the mocked `lib/miden/db/types` above.
const STATUS = { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3 };

// ---------------------------------------------------------------------------
// Fixtures — one dataset that touches every branch of both fetch helpers.
// ---------------------------------------------------------------------------
function makeCompleted() {
  return [
    // Failed → 'Transaction failed' + 'FAILED' icon; has metadata + amount.
    {
      id: 'F',
      status: STATUS.Failed,
      displayMessage: 'orig failed msg',
      displayIcon: 'SEND',
      faucetId: 'fa1',
      type: 'send',
      amount: 100n,
      completedAt: 1000,
      secondaryAccountId: '0xAAA',
      noteType: 'P2ID'
    },
    // Swap → swapFields drive amount/token/requested*; metadata present but overridden.
    {
      id: 'S',
      status: STATUS.Completed,
      displayMessage: 'swap msg',
      displayIcon: 'SWAP',
      faucetId: 'fa2',
      type: 'swap',
      amount: 5n,
      completedAt: 2000,
      secondaryAccountId: '0xBBB'
    },
    // Plain receive → no faucetId (metadata undefined), no amount, no swap.
    {
      id: 'P',
      status: STATUS.Completed,
      displayMessage: 'plain recv',
      displayIcon: 'RECEIVE',
      faucetId: undefined,
      type: 'consume',
      amount: undefined,
      completedAt: 3000,
      secondaryAccountId: undefined
    },
    // Plain send (not failed) → keeps 'SEND' icon; drives the `sent` filter.
    {
      id: 'SD',
      status: STATUS.Completed,
      displayMessage: 'sent money',
      displayIcon: 'SEND',
      faucetId: 'fa1',
      type: 'send',
      amount: 20n,
      completedAt: 2500,
      secondaryAccountId: '0xEEE'
    },
    // User-cancelled send → Failed status + the cancellation sentinel on `error`.
    {
      id: 'C',
      status: STATUS.Failed,
      displayMessage: 'Failed',
      displayIcon: 'FAILED',
      faucetId: 'fa1',
      type: 'send',
      amount: 7n,
      completedAt: 900,
      secondaryAccountId: '0xFFF',
      error: 'Transaction was cancelled by user'
    },
    // Faucet drip → isFaucetRequest true; metadata + amount; ties timestamp w/ swap.
    {
      id: 'FC',
      status: STATUS.Completed,
      displayMessage: 'faucet drip',
      displayIcon: 'RECEIVE',
      faucetId: 'NATIVE',
      type: 'consume',
      amount: 50n,
      completedAt: 2000,
      secondaryAccountId: 'NATIVE'
    }
  ];
}

function makePending() {
  return [
    // Queued → PendingTransaction; empty displayMessage → 'Generating transaction'.
    {
      id: 'PQ',
      status: STATUS.Queued,
      displayMessage: '',
      faucetId: 'fa1',
      type: 'send',
      amount: 10n,
      initiatedAt: 500,
      secondaryAccountId: '0xCCC',
      noteType: 'P2ID'
    },
    // Not Queued → ProcessingTransaction; swap → swapFields; no faucetId.
    {
      id: 'PP',
      status: STATUS.GeneratingTransaction,
      displayMessage: 'processing',
      faucetId: undefined,
      type: 'swap',
      amount: undefined,
      initiatedAt: 600,
      secondaryAccountId: '0xDDD'
    },
    // No id → txId undefined (cancel no-op branch); no faucetId, no amount.
    {
      id: undefined,
      status: STATUS.Queued,
      displayMessage: 'noid',
      faucetId: undefined,
      type: 'consume',
      amount: undefined,
      initiatedAt: 400
    }
  ];
}

const entryKeys = () => screen.queryAllByTestId('entry').map(el => el.getAttribute('data-entry-key'));

async function renderHistory(props: Record<string, unknown> = {}) {
  let utils: ReturnType<typeof render>;
  await act(async () => {
    utils = render(<History address="0xme" {...(props as any)} />);
  });
  // Wait until both SWR fetchers have resolved and the view has entries.
  await waitFor(() => expect(screen.getByTestId('history-view')).toBeTruthy());
  return utils!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHistoryViewProps = undefined;

  mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
    offset === undefined ? makeCompleted() : []
  );
  mockGetUncompletedTransactions.mockResolvedValue(makePending());
  mockGetTokenMetadata.mockImplementation(async (id: string | null) => {
    if (id === 'fa1') return { symbol: 'TKF', decimals: 6 };
    if (id === 'fa2') return { symbol: 'SWPMETA', decimals: 2 };
    if (id === 'NATIVE') return { symbol: 'MID', decimals: 8 };
    return undefined;
  });
  mockFormatAmount.mockImplementation((amt: bigint, dec?: number) => `fmt(${amt},${dec})`);
  mockResolveSwapHistoryFields.mockResolvedValue({
    amount: 'S-amt',
    token: 'S-tok',
    requestedAmount: 'S-req',
    requestedToken: 'S-reqtok'
  });
  mockIsFaucetRequest.mockImplementation(
    (entry: any) => entry.faucetId === 'NATIVE' && entry.transactionIcon === 'RECEIVE'
  );
  mockFormatTransactionStatus.mockImplementation((s: number) => `status-${s}`);
  mockSuppressingLinkedTxIds.mockImplementation(async (ids: string[]) => new Set(ids.filter(id => id === 'BR-KEEP')));
  mockResolveConsumeExtraAmounts.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('History', () => {
  it('threads Guardian transition metadata through completed and pending entries', async () => {
    mockGetCompletedTransactions.mockResolvedValueOnce([
      {
        id: 'switch-complete',
        accountId: '0xme',
        status: STATUS.Completed,
        displayMessage: 'Guardian switched',
        displayIcon: 'DEFAULT',
        type: 'switch-guardian',
        completedAt: 200,
        extraInputs: {
          previousGuardianEndpoint: 'https://old.example',
          newGuardianEndpoint: 'https://new.example'
        }
      }
    ]);
    mockGetUncompletedTransactions.mockResolvedValueOnce([
      {
        id: 'switch-pending',
        accountId: '0xme',
        status: STATUS.Queued,
        displayMessage: 'Switching guardian',
        displayIcon: 'DEFAULT',
        type: 'switch-guardian',
        initiatedAt: 300,
        extraInputs: { newGuardianEndpoint: 'https://legacy-new.example' }
      }
    ]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(2));

    const completed = mockHistoryViewProps.entries.find(
      (entry: { key: string }) => entry.key === 'completed-switch-complete'
    );
    expect(completed.previousGuardianEndpoint).toBe('https://old.example');
    expect(completed.newGuardianEndpoint).toBe('https://new.example');
    const pending = mockHistoryViewProps.entries.find(
      (entry: { key: string }) => entry.key === 'pending-switch-pending'
    );
    expect(pending.previousGuardianEndpoint).toBeUndefined();
    expect(pending.newGuardianEndpoint).toBe('https://legacy-new.example');
  });

  it('maps completed + pending transactions through every fetch branch and sorts completed by timestamp desc', async () => {
    await renderHistory();

    // Pending come first (unsorted, in fetch order), then completed sorted desc.
    await waitFor(() =>
      expect(entryKeys()).toEqual([
        'pending-PQ',
        'pending-PP',
        'pending-undefined',
        'completed-P', // ts 3000
        'completed-SD', // ts 2500
        'completed-S', // ts 2000 (tie w/ FC, order by type diff → 0)
        'completed-FC', // ts 2000
        'completed-F', // ts 1000
        'completed-C' // ts 900
      ])
    );

    const rowText = (key: string) =>
      screen.getAllByTestId('entry').find(el => el.getAttribute('data-entry-key') === key)!.textContent!;

    // Completed: Failed → message/icon override, metadata symbol + formatAmount.
    expect(rowText('completed-F')).toContain('completed-F|Transaction failed|TKF|fmt(100,6)|FAILED|');
    // Completed: user-cancelled → 'Cancelled' message + isCancelled/errorMessage on the entry.
    expect(rowText('completed-C')).toContain('completed-C|Cancelled|TKF|fmt(7,6)|FAILED|');
    const cancelledEntry = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-C');
    expect(cancelledEntry.isCancelled).toBe(true);
    expect(cancelledEntry.errorMessage).toBe('Transaction was cancelled by user');
    const failedEntry = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-F');
    expect(failedEntry.isCancelled).toBe(false);

    // Failed rows are fetched at all: the completed fetch runs with includeFailed=true.
    expect(mockGetCompletedTransactions).toHaveBeenCalledWith('0xme', undefined, undefined, true, undefined);
    // Completed: Swap → swapFields drive amount/token/requested*, icon from displayIcon.
    expect(rowText('completed-S')).toContain('completed-S|swap msg|S-tok|S-amt|SWAP|');
    expect(rowText('completed-S')).toContain('|S-req|S-reqtok');
    // Completed: plain receive → no metadata, no amount → empty token/amount.
    expect(rowText('completed-P')).toContain('completed-P|plain recv|||RECEIVE|');
    // Completed: faucet drip → metadata + formatAmount.
    expect(rowText('completed-FC')).toContain('completed-FC|faucet drip|MID|fmt(50,8)|RECEIVE|');

    // Pending: Queued w/ empty message → default text; secondaryMessage from status.
    expect(rowText('pending-PQ')).toContain('pending-PQ|Generating transaction|TKF|fmt(10,6)|');
    expect(rowText('pending-PQ')).toContain(`|${HistoryEntryType.PendingTransaction}|status-${STATUS.Queued}|`);
    // Pending: processing swap → swapFields amount/token, processing type.
    expect(rowText('pending-PP')).toContain('pending-PP|processing|S-tok|S-amt|');
    expect(rowText('pending-PP')).toContain(`|${HistoryEntryType.ProcessingTransaction}|`);
    // Pending: no id → no metadata / no amount.
    expect(rowText('pending-undefined')).toContain('pending-undefined|noid|||');

    // resolveSwapHistoryFields only for swap txs (1 completed + 1 pending).
    expect(mockResolveSwapHistoryFields).toHaveBeenCalledTimes(2);
    // getTokenMetadata skipped for entries without faucetId.
    expect(mockGetTokenMetadata).toHaveBeenCalledWith('fa1');
    expect(mockGetTokenMetadata).not.toHaveBeenCalledWith(undefined);
  });

  it('forwards passthrough props and initial-loading flag to HistoryView', async () => {
    const scrollParentRef = React.createRef<HTMLDivElement>();
    await renderHistory({
      className: 'my-class',
      fullHistory: true,
      centerEmptyState: true,
      scrollParentRef
    });

    const view = screen.getByTestId('history-view');
    expect(view.getAttribute('data-class')).toBe('my-class');
    expect(view.getAttribute('data-full-history')).toBe('true');
    expect(view.getAttribute('data-center-empty')).toBe('true');
    expect(mockHistoryViewProps.scrollParentRef).toBe(scrollParentRef);
    // After both fetches resolve, initial loading is false.
    await waitFor(() => expect(view.getAttribute('data-initial-loading')).toBe('false'));
  });

  it('filters by searchQuery across message, token and secondaryAddress (case-insensitive), skipping blank queries', async () => {
    const { rerender } = await renderHistory();
    const doRerender = async (props: Record<string, unknown>) => {
      await act(async () => {
        rerender(<History address="0xme" {...(props as any)} />);
      });
    };

    // Match on message.
    await doRerender({ searchQuery: 'FAUCET DRIP' });
    expect(entryKeys()).toEqual(['completed-FC']);

    // Match on token symbol.
    await doRerender({ searchQuery: 's-tok' });
    expect(entryKeys().sort()).toEqual(['completed-S', 'pending-PP'].sort());

    // Match on secondaryAddress.
    await doRerender({ searchQuery: '0xbbb' });
    expect(entryKeys()).toEqual(['completed-S']);

    // No match → empty.
    await doRerender({ searchQuery: 'zzzz-nothing' });
    expect(entryKeys()).toEqual([]);

    // Whitespace-only query → filter skipped (all entries retained).
    await doRerender({ searchQuery: '   ' });
    expect(entryKeys().length).toBe(9);
  });

  it('filters by sent / received / faucet / all and tolerates an unknown filter value', async () => {
    const { rerender } = await renderHistory();
    const doRerender = async (props: Record<string, unknown>) => {
      await act(async () => {
        rerender(<History address="0xme" {...(props as any)} />);
      });
    };

    // sent → SEND icon, plus failed/cancelled sends (their icon becomes
    // 'FAILED', so the filter falls back to the underlying tx type).
    await doRerender({ filter: 'sent' });
    expect(entryKeys()).toEqual(['completed-SD', 'completed-F', 'completed-C']);

    // received → RECEIVE and not a faucet request.
    await doRerender({ filter: 'received' });
    expect(entryKeys()).toEqual(['completed-P']);

    // faucet → isFaucetRequest true.
    await doRerender({ filter: 'faucet' });
    expect(entryKeys()).toEqual(['completed-FC']);

    // all → filter block skipped, everything retained.
    await doRerender({ filter: 'all' });
    expect(entryKeys().length).toBe(9);

    // unknown filter → inner default `return true`, everything retained.
    await doRerender({ filter: 'weird' });
    expect(entryKeys().length).toBe(9);
  });

  it('limits the number of rendered entries with numItems (and ignores falsy 0)', async () => {
    const { rerender } = await renderHistory();

    await act(async () => {
      rerender(<History address="0xme" numItems={2} />);
    });
    expect(entryKeys()).toEqual(['pending-PQ', 'pending-PP']);

    // numItems larger than the list → Math.min keeps them all.
    await act(async () => {
      rerender(<History address="0xme" numItems={999} />);
    });
    expect(entryKeys().length).toBe(9);

    // numItems 0 is falsy → slicing skipped.
    await act(async () => {
      rerender(<History address="0xme" numItems={0} />);
    });
    expect(entryKeys().length).toBe(9);
  });

  it('loadMore appends de-duplicated older transactions and keeps hasMore true', async () => {
    await renderHistory();

    // Older page: one duplicate of an existing completed key + one new entry.
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) => {
      if (offset === undefined) return makeCompleted();
      return [
        {
          id: 'P',
          status: STATUS.Completed,
          displayMessage: 'plain recv',
          displayIcon: 'RECEIVE',
          faucetId: undefined,
          type: 'consume',
          amount: undefined,
          completedAt: 3000
        },
        {
          id: 'OLD',
          status: STATUS.Completed,
          displayMessage: 'older tx',
          displayIcon: 'RECEIVE',
          faucetId: undefined,
          type: 'consume',
          amount: undefined,
          completedAt: 10
        }
      ];
    });

    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });

    // Called with the paged offset/limit (page 0 → offset 0, limit HISTORY_PAGE_SIZE).
    expect(mockGetCompletedTransactions).toHaveBeenCalledWith('0xme', 0, 1000, true, undefined);
    await waitFor(() => expect(entryKeys()).toContain('completed-OLD'));
    // Duplicate `completed-P` appears exactly once.
    expect(entryKeys().filter(k => k === 'completed-P')).toHaveLength(1);
    expect(mockHistoryViewProps.hasMore).toBe(true);
  });

  it('loadMore sets hasMore false when no older transactions remain', async () => {
    mockGetCompletedTransactions.mockResolvedValue([]);
    mockGetUncompletedTransactions.mockResolvedValue([]);
    await renderHistory();

    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });
    await waitFor(() => expect(mockHistoryViewProps.hasMore).toBe(false));
  });

  it('loadMore is re-entrancy guarded while a previous page is in flight', async () => {
    let releaseInFlight: (v: unknown[]) => void = () => {};
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) => {
      if (offset === undefined) return [];
      return new Promise(res => {
        releaseInFlight = res;
      });
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);
    await renderHistory();

    // First call flips internal isLoading true and hangs on the deferred promise.
    await act(async () => {
      mockHistoryViewProps.loadMore(0);
    });

    mockGetCompletedTransactions.mockClear();

    // Second call (now that isLoading is true) hits the early return.
    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });
    expect(mockGetCompletedTransactions).not.toHaveBeenCalled();

    // Release the in-flight promise so no work is left pending.
    await act(async () => {
      releaseInFlight([]);
    });
  });

  it('stops paging after a failed page rather than wedging or spinning', async () => {
    // Two failure modes to avoid at once. Leaking `isLoading` wedges pagination
    // for the session (the guard at the top returns early while it is set);
    // clearing it while leaving `hasMore` true makes the infinite scroller retry
    // a persistently failing page on every re-render. So: clear the flag, and
    // stop offering more.
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) => {
      if (offset === undefined) return [];
      throw new Error('dexie-down');
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);
    await renderHistory();

    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load history page 0'),
      expect.any(Error)
    );
    await waitFor(() => expect(mockHistoryViewProps.hasMore).toBe(false));

    // `isLoading` is internal, so it is proven cleared by the next call getting
    // past the early-return guard at all — a leaked flag would silently no-op.
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined
        ? []
        : [
            {
              id: 'OLD',
              status: STATUS.Completed,
              displayMessage: 'older tx',
              displayIcon: 'RECEIVE',
              type: 'consume',
              completedAt: 10
            }
          ]
    );
    await act(async () => {
      await mockHistoryViewProps.loadMore(1);
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-OLD'));

    consoleErrorSpy.mockRestore();
  });

  it('cancels a pending transaction by id and no-ops when the entry has no txId', async () => {
    await renderHistory();

    const withId = mockHistoryViewProps.entries.find((e: any) => e.key === 'pending-PQ');
    const withoutId = mockHistoryViewProps.entries.find((e: any) => e.key === 'pending-undefined');

    await act(async () => {
      await withId.cancel();
    });
    expect(mockCancelTransactionById).toHaveBeenCalledWith('PQ', 'Transaction was cancelled by user');

    mockCancelTransactionById.mockClear();
    await act(async () => {
      await withoutId.cancel();
    });
    expect(mockCancelTransactionById).not.toHaveBeenCalled();
  });

  it('threads tokenId into the SWR keys and both fetchers', async () => {
    await renderHistory({ tokenId: 'tok-9' });

    expect(mockGetCompletedTransactions).toHaveBeenCalledWith('0xme', undefined, undefined, true, 'tok-9');
    expect(mockGetUncompletedTransactions).toHaveBeenCalledWith('0xme', 'tok-9');
    const keys = mockUseRetryableSWR.mock.calls.map(c => c[0]);
    expect(keys).toContainEqual(['latest-transactions', '0xme', 'tok-9']);
    expect(keys).toContainEqual(['latest-pending-transactions', '0xme', 'tok-9']);
  });

  it('maps bridge rows, suppresses lifecycle-tail consumes, and derives swap settlement chips', async () => {
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined
        ? [
            {
              id: 'BOUT',
              status: STATUS.Completed,
              displayMessage: 'Bridged to EVM',
              displayIcon: 'SEND',
              faucetId: 'fa1',
              type: 'bridged-send',
              amount: 9n,
              completedAt: 5000,
              extraInputs: {
                provider: 'epoch',
                destinationAddress: '0xdest',
                destinationNetwork: 8453,
                claimStatus: 'not-applicable',
                outputAmount: '8.99',
                outputSymbol: 'USDC',
                intentNonce: 'n1',
                fillTxHash: '0xfill',
                fillChainId: 8453,
                epochStatus: 'confirmed'
              }
            },
            {
              id: 'BR-KEEP',
              status: STATUS.Completed,
              displayMessage: 'Bridging from EVM',
              displayIcon: 'RECEIVE',
              faucetId: 'fa1',
              type: 'bridged-receive',
              amount: 4n,
              completedAt: 4000,
              extraInputs: {
                provider: 'agglayer',
                sourceAddress: '0xsrc',
                sourceAmount: '4',
                sourceSymbol: 'ETH',
                evmTxHash: '0xhash',
                phase: 'delivering',
                outputAmount: '4',
                outputSymbol: 'ETH',
                midenNoteId: '0xnote'
              }
            },
            // Delivery consume linked to the still-existing tracking row above → suppressed.
            {
              id: 'CONS-LINKED',
              status: STATUS.Completed,
              displayMessage: 'Received',
              displayIcon: 'RECEIVE',
              faucetId: 'fa1',
              type: 'consume',
              amount: 4n,
              completedAt: 4100,
              extraInputs: { bridgeIn: { provider: 'agglayer', bridgeReceiveTxId: 'BR-KEEP' } }
            },
            // Dangling tracking reference → shown, with bridgeIn display fallbacks.
            {
              id: 'CONS-DANGLING',
              status: STATUS.Completed,
              displayMessage: 'Bridged from EVM',
              displayIcon: 'RECEIVE',
              faucetId: 'fa1',
              type: 'consume',
              amount: 3n,
              completedAt: 3900,
              extraInputs: {
                bridgeIn: {
                  provider: 'epoch',
                  sourceAmount: '3',
                  sourceSymbol: 'USDC',
                  evmTxHash: '0xebd',
                  bridgeReceiveTxId: 'BR-GONE'
                }
              }
            },
            // Settlement consume for a swap row that no longer exists → shown as receive.
            {
              id: 'CONS-SWAP-GONE',
              status: STATUS.Completed,
              displayMessage: 'Received',
              displayIcon: 'RECEIVE',
              faucetId: 'fa1',
              type: 'consume',
              amount: 2n,
              completedAt: 3800,
              extraInputs: { swapOrderTxId: 'SW-GONE' }
            },
            {
              id: 'SWAP-RECLAIMED',
              status: STATUS.Completed,
              displayMessage: 'swap',
              displayIcon: 'SWAP',
              faucetId: 'fa2',
              type: 'swap',
              amount: 5n,
              completedAt: 3700,
              extraInputs: { orderId: 7n, expiresAt: 1, reclaimedAt: 99 }
            },
            {
              id: 'SWAP-PENDING',
              status: STATUS.Completed,
              displayMessage: 'swap',
              displayIcon: 'SWAP',
              faucetId: 'fa2',
              type: 'swap',
              amount: 5n,
              completedAt: 3600,
              extraInputs: { orderId: 8n, expiresAt: 1 }
            }
          ]
        : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([
      {
        id: 'PB',
        status: STATUS.GeneratingTransaction,
        displayMessage: 'Bridging',
        faucetId: 'fa1',
        type: 'bridged-send',
        amount: 6n,
        initiatedAt: 700,
        extraInputs: {
          provider: 'agglayer',
          destinationAddress: '0xpend',
          destinationNetwork: 1,
          claimStatus: 'pending',
          outputAmount: '5.5',
          outputSymbol: 'ETH',
          intentNonce: 'n2',
          fillTxHash: '0xf2',
          fillChainId: 1,
          epochStatus: 'pending'
        }
      }
    ]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries.length).toBeGreaterThan(0));

    const byKey = (key: string) => mockHistoryViewProps.entries.find((e: any) => e.key === key);

    expect(byKey('completed-CONS-LINKED')).toBeUndefined();

    const out = byKey('completed-BOUT');
    expect(out).toMatchObject({
      bridgeProvider: 'epoch',
      bridgeDestinationAddress: '0xdest',
      bridgeClaimStatus: 'not-applicable',
      bridgeOutputAmount: '8.99',
      bridgeFillTxHash: '0xfill',
      bridgeEpochStatus: 'confirmed',
      secondaryAddress: '0xdest'
    });

    const receive = byKey('completed-BR-KEEP');
    expect(receive).toMatchObject({
      txType: 'bridged-receive',
      bridgeInProvider: 'agglayer',
      bridgeInSourceAddress: '0xsrc',
      bridgeInSourceAmount: '4',
      bridgeInEvmTxHash: '0xhash',
      bridgeInPhase: 'delivering',
      bridgeInOutputAmount: '4',
      bridgeInMidenNoteId: '0xnote'
    });

    const dangling = byKey('completed-CONS-DANGLING');
    expect(dangling).toMatchObject({
      txType: 'consume',
      bridgeInProvider: 'epoch',
      bridgeInSourceAmount: '3',
      bridgeInSourceSymbol: 'USDC',
      bridgeInEvmTxHash: '0xebd'
    });
    expect(byKey('completed-CONS-SWAP-GONE')).toBeDefined();

    expect(byKey('completed-SWAP-RECLAIMED')).toMatchObject({ swapSettlement: 'reclaimed' });
    expect(byKey('completed-SWAP-PENDING')).toMatchObject({ swapSettlement: 'pending' });

    const pendingBridge = byKey('pending-PB');
    expect(pendingBridge).toMatchObject({
      bridgeProvider: 'agglayer',
      bridgeDestinationAddress: '0xpend',
      bridgeClaimStatus: 'pending',
      bridgeOutputAmount: '5.5',
      bridgeIntentNonce: 'n2',
      secondaryAddress: '0xpend'
    });
  });
});

// A batch claim's secondary assets are rendered on the row, so they have to
// reach the entry and be reachable by search — otherwise typing a symbol the
// user can see hides the very row showing it.
describe('History batch-claim extra assets', () => {
  const claimRow = {
    id: 'CLAIM',
    status: STATUS.Completed,
    displayMessage: 'Claimed',
    displayIcon: 'RECEIVE',
    faucetId: 'fa1',
    type: 'consume',
    amount: 20n,
    completedAt: 9000,
    assetTotals: [
      { faucetId: 'fa1', amount: 20n },
      { faucetId: 'fa2', amount: 10n }
    ]
  };
  const extras = [{ faucetId: 'fa2', amount: '10', token: 'BBB' }];

  beforeEach(() => {
    mockResolveConsumeExtraAmounts.mockImplementation(async (tx: { id?: string }) =>
      tx.id === 'CLAIM' || tx.id === 'PCLAIM' ? extras : []
    );
  });

  it('threads the resolved secondary assets onto completed and pending entries', async () => {
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined ? [claimRow] : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([
      { ...claimRow, id: 'PCLAIM', status: STATUS.Queued, initiatedAt: 100 }
    ]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(2));

    expect(mockResolveConsumeExtraAmounts).toHaveBeenCalledWith(expect.objectContaining({ id: 'CLAIM' }));
    expect(mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-CLAIM').extraAmounts).toEqual(extras);
    expect(mockHistoryViewProps.entries.find((e: any) => e.key === 'pending-PCLAIM').extraAmounts).toEqual(extras);
  });

  // `0n` is falsy, so a truthiness gate turns a real zero total into "no amount"
  // — and `buildRowProps` then drops every secondary asset along with it.
  it('keeps a zero primary total as an amount on both the completed and pending paths', async () => {
    const zeroRow = { ...claimRow, amount: 0n };
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined ? [zeroRow] : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([
      { ...zeroRow, id: 'PCLAIM', status: STATUS.Queued, initiatedAt: 100 }
    ]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(2));

    const completed = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-CLAIM');
    const pending = mockHistoryViewProps.entries.find((e: any) => e.key === 'pending-PCLAIM');
    expect(completed.amount).toBeDefined();
    expect(completed.extraAmounts).toEqual(extras);
    expect(pending.amount).toBeDefined();
  });

  it('leaves extraAmounts unset for a single-asset row rather than an empty array', async () => {
    // An empty array is truthy, so the row would take the batch-claim rendering
    // path (and the search predicate would scan it) for every ordinary row.
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined ? [{ ...claimRow, id: 'SINGLE' }] : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(1));
    expect(mockHistoryViewProps.entries[0].extraAmounts).toBeUndefined();
  });

  it('finds a claim by a secondary asset symbol that appears nowhere else on the entry', async () => {
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined
        ? [
            claimRow,
            {
              id: 'OTHER',
              status: STATUS.Completed,
              displayMessage: 'unrelated',
              displayIcon: 'SEND',
              faucetId: 'fa1',
              type: 'send',
              amount: 1n,
              completedAt: 8000
            }
          ]
        : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([]);

    const { rerender } = await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(2));

    // 'BBB' is only on `extraAmounts` — not the message, token or address.
    await act(async () => {
      rerender(<History address="0xme" searchQuery="bbb" />);
    });
    expect(entryKeys()).toEqual(['completed-CLAIM']);
  });
});

// Earn rows: the row and its detail hero must agree on which side of a Smart
// Withdraw is shown, and a Smart Deposit's Sepolia lending leg must reach the
// entry so the status chip can track it.
describe('History earn entries', () => {
  beforeEach(() => {
    mockEarnWithdrawAmountFields.mockReturnValue({ amount: 'EARN-AMT', token: 'EARN-TOK' });
  });

  const withRows = (rows: unknown[]) => {
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined ? rows : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([]);
  };

  it('routes an earn-withdraw row through earnWithdrawAmountFields with the row amount + metadata', async () => {
    const extraInputs = { phase: 'received', sourceAmount: '10', sourceSymbol: 'USDC' };
    withRows([
      {
        id: 'EW',
        type: 'earn-withdraw',
        status: 2,
        completedAt: 5000,
        faucetId: 'fa1',
        amount: 250n,
        extraInputs,
        displayMessage: 'Withdrawing',
        displayIcon: 'DEFAULT'
      }
    ]);

    await renderHistory();

    // The helper decides the side; History just forwards its output.
    expect(mockEarnWithdrawAmountFields).toHaveBeenCalledWith(extraInputs, 250n, { symbol: 'TKF', decimals: 6 });
    const entry = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-EW');
    expect(entry.amount).toBe('EARN-AMT');
    expect(entry.token).toBe('EARN-TOK');
    expect(entry.earnWithdrawPhase).toBe('received');
  });

  it('surfaces the Sepolia lending-leg status on a completed earn-deposit row', async () => {
    withRows([
      {
        id: 'ED',
        type: 'earn-deposit',
        status: 2,
        completedAt: 5000,
        faucetId: 'fa1',
        amount: 5n,
        extraInputs: { epochStatus: 'pending', evmRecipient: '0xowner' },
        displayMessage: 'Depositing',
        displayIcon: 'DEFAULT'
      }
    ]);

    await renderHistory();

    const entry = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-ED');
    expect(entry.earnDepositStatus).toBe('pending');
    // Not an earn-withdraw, so the withdraw helper is never consulted.
    expect(mockEarnWithdrawAmountFields).not.toHaveBeenCalled();
  });

  it('surfaces the lending-leg status on a still-pending earn-deposit row too', async () => {
    mockGetCompletedTransactions.mockResolvedValue([]);
    mockGetUncompletedTransactions.mockResolvedValue([
      {
        id: 'EDP',
        type: 'earn-deposit',
        status: 1,
        initiatedAt: 100,
        faucetId: 'fa1',
        amount: 5n,
        extraInputs: { epochStatus: 'failed', evmRecipient: '0xowner' },
        displayMessage: 'Depositing'
      }
    ]);

    await renderHistory();

    const entry = mockHistoryViewProps.entries.find((e: any) => e.key === 'pending-EDP');
    expect(entry.earnDepositStatus).toBe('failed');
  });
});
