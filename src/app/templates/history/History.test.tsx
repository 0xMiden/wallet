import React from 'react';

import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { SWRConfig } from 'swr';

import { HISTORY_PAGE_SIZE } from 'app/defaults';
import { PageActiveContext } from 'app/layouts/page-active';
import {
  publishMockBridgeSnapshot,
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_MIDEN_USDC_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
// The real strings, not mocked (this module is not replaced by any `jest.mock` in this file) -
// used to plant a bridge-in consume and a rotation shortfall the builder's `isUnconfirmedFailure`
// call reads (#1250).
import * as Repo from 'lib/miden/repo';
import {
  TRANSACTION_INTERRUPTED_ERROR,
  TRANSACTION_NEVER_COMMITTED_ERROR,
  TRANSACTION_VAULT_SHORTFALL_ERROR
} from 'lib/miden/transaction/constants';
import type { CompletedHistoryCursor, CompletedTransactionsPageRequest } from 'lib/miden/transaction/get';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

// Imported AFTER the mocks are registered.

import { groupActivityEntries } from './activityGroups';
import History from './History';
import { HistoryEntryType } from './IHistoryEntry';
import type { PendingActivityItem } from './PendingActivityCard';
import { resolveSwapHistoryProgress } from './resolveSwapHistoryProgress';

// ---------------------------------------------------------------------------
// Mock-prefixed collaborators (so the hoisted jest.mock factories may close
// over them). History.tsx is a memo component whose only exported symbol is the
// default component; the module-internal fetch/merge helpers are exercised
// through it by mocking `useRetryableSWR` to actually run the SWR fetchers.
// ---------------------------------------------------------------------------
const mockGetCompletedTransactions = jest.fn();
const mockGetCompletedTransactionsPage = jest.fn();
const mockGetUncompletedTransactions = jest.fn();
const mockCancelTransactionById = jest.fn().mockResolvedValue(undefined);
const mockSuppressedLinkedConsumeIds = jest.fn();
const mockSupersededFailedConsumeIds = jest.fn();
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
// Every props call in order, so a test can see a single committed render that later ones replace.
let mockHistoryViewCalls: any[] = [];
// Each SWR read's mutate, by the first element of its key, so a test can see which reads a Retry re-runs.
const mockSwrMutates: Record<string, jest.Mock> = {};
// Each SWR read's config, by the first element of its key.
const mockSwrConfigs: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// `lib/swr` — a real hook implementation that runs the fetcher on mount (and on
// `mutate`), storing the result in state. This is what drives coverage of the
// module-internal `fetchTransactionsAsHistoryEntries` /
// `fetchPendingTransactionsAsHistoryEntries` helpers.
// ---------------------------------------------------------------------------
// Hands the real `lib/swr` to the tests that switch it on, for behaviour that lives in SWR's shared cache.
let mockRealSwr = false;
const mockUseRetryableSWR = jest.fn(
  (key: unknown, fetcher: () => Promise<unknown>, config?: Record<string, unknown>) => {
    // A null key is a read that is not running: no fetch, no data, not loading. Every hook still runs.
    if (key !== null) mockSwrConfigs[String((key as unknown[])[0])] = config;
    const keyStr = JSON.stringify(key);
    const [state, setState] = React.useState<{ data: unknown; isLoading: boolean; error?: unknown }>({
      data: undefined,
      isLoading: true
    });
    const [tick, setTick] = React.useState(0);
    const mutateRef = React.useRef<jest.Mock>();
    if (!mutateRef.current) mutateRef.current = jest.fn(() => setTick(t => t + 1));
    if (key !== null) mockSwrMutates[String((key as unknown[])[0])] = mutateRef.current;

    React.useEffect(() => {
      if (key === null) return undefined;
      let active = true;
      Promise.resolve(fetcher()).then(
        data => {
          if (active) {
            setState({ data, isLoading: false });
            const onSuccess = config?.onSuccess;
            if (typeof onSuccess === 'function') {
              (onSuccess as (...args: unknown[]) => void)(data, key, config);
            }
          }
        },
        error => {
          if (active) setState({ data: undefined, isLoading: false, error });
        }
      );
      return () => {
        active = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keyStr, tick]);

    if (key === null) return { data: undefined, isLoading: false, error: undefined, mutate: mutateRef.current };
    return { data: state.data, isLoading: state.isLoading, error: state.error, mutate: mutateRef.current };
  }
);

jest.mock('./resolveSwapHistoryProgress', () => ({
  resolveSwapHistoryProgress: jest.fn(async (txOrTxs: unknown) => (Array.isArray(txOrTxs) ? new Map() : {}))
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: [unknown, () => Promise<unknown>, Record<string, unknown>?]) =>
    mockRealSwr ? jest.requireActual('lib/swr').useRetryableSWR(...args) : mockUseRetryableSWR(...args)
}));

// `react-i18next` is imported (top-level) by `app/defaults`; echo keys back.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/miden/activity', () => ({
  cancelTransactionById: (...args: unknown[]) => mockCancelTransactionById(...args),
  suppressedLinkedConsumeIds: (...args: unknown[]) => mockSuppressedLinkedConsumeIds(...args),
  supersededFailedConsumeIds: (...args: unknown[]) => mockSupersededFailedConsumeIds(...args),
  getCompletedTransactions: (...args: unknown[]) => mockGetCompletedTransactions(...args),
  getUncompletedTransactions: (...args: unknown[]) => mockGetUncompletedTransactions(...args),
  // The REAL predicate: which rows may be cancelled is exactly what these
  // tests assert, so a reimplementation here would assert the mock instead.
  isCancellableTransaction: jest.requireActual('lib/miden/transaction/retry').isCancellableTransaction,
  // Real (pure) implementations so the cancelled-row mapping is exercised
  // against the production sentinel string.
  USER_CANCELLED_TRANSACTION_REASON: 'Transaction was cancelled by user',
  isUserCancelledTransaction: (error: unknown) => error === 'Transaction was cancelled by user',
  // The REAL predicate, same reasoning as isCancellableTransaction above: which rows the
  // builder marks not-confirmed (#1250) is exactly what the isUnconfirmed tests assert.
  isUnconfirmedFailure: jest.requireActual('lib/miden/transaction/constants').isUnconfirmedFailure,
  isOutcomeUnconfirmed: jest.requireActual('lib/miden/transaction/constants').isOutcomeUnconfirmed,
  notConfirmedHintKey: jest.requireActual('lib/miden/transaction/verdict-rules').notConfirmedHintKey
}));

jest.mock('lib/miden/transaction/get', () => ({
  ...jest.requireActual('lib/miden/transaction/get'),
  getCompletedTransactionsPage: (request: unknown) => mockGetCompletedTransactionsPage(request)
}));

jest.mock('lib/miden/db/types', () => ({
  ITransactionStatus: { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3, Unconfirmed: 4 },
  STRUCTURAL_GUARDIAN_TYPES: jest.requireActual('lib/miden/db/types').STRUCTURAL_GUARDIAN_TYPES,
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
  // The real naming, so a label assertion runs the rule the list renders with.
  labelHistoryEntry: jest.requireActual('./transactionUtils').labelHistoryEntry,
  resolveConsumeExtraAmounts: (...args: unknown[]) => mockResolveConsumeExtraAmounts(...args)
}));

// The chain's native asset, which the Groups view reads to recognise a faucet claim. A case can
// start with it unknown and resolve its lookup later.
let mockNativeAssetId: string | null = 'NATIVE';
let mockNativeAssetLookup: Promise<string> | undefined;
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual<typeof import('lib/miden-chain/native-asset')>('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: () => mockNativeAssetId,
  getNativeAssetId: () => mockNativeAssetLookup ?? Promise.resolve('NATIVE')
}));
afterEach(() => {
  mockNativeAssetId = 'NATIVE';
  mockNativeAssetLookup = undefined;
});

// The effective network: Testnet unless a case puts the wallet on another.
let mockWalletNetwork: MIDEN_NETWORK_NAME = MIDEN_NETWORK_NAME.TESTNET;
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockWalletNetwork
}));
afterEach(() => {
  mockWalletNetwork = MIDEN_NETWORK_NAME.TESTNET;
});

// This realm's bridge config: the real, unloaded one, or the loaded testnet one a case sets.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = undefined;
});

// Thin HistoryView stub: capture props (for `loadMore`) and surface each entry
// key so tests can assert filtering/sorting/slicing outcomes.
jest.mock('./HistoryView', () => ({
  __esModule: true,
  default: (props: any) => {
    mockHistoryViewProps = props;
    mockHistoryViewCalls.push(props);
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
const STATUS = { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3, Unconfirmed: 4 };

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
  mockRealSwr = false;
  mockHistoryViewProps = undefined;
  mockHistoryViewCalls = [];

  mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
    offset === undefined ? makeCompleted() : []
  );
  const offsetsByCursor = new Map<string, number>();
  const cursorKey = (cursor: CompletedHistoryCursor | null | undefined) =>
    cursor ? `${cursor.effectiveTimestamp}:${cursor.transactionId}` : 'null';
  mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
    const offset = request.fromEnd ? undefined : (offsetsByCursor.get(cursorKey(request.cursor)) ?? 0);
    const rows: Array<{ id?: string; completedAt?: number; initiatedAt?: number }> = await (request.fromEnd
      ? mockGetCompletedTransactions(
          request.accountId,
          undefined,
          request.limit,
          request.includeFailed === true,
          request.tokenId,
          true
        )
      : mockGetCompletedTransactions(
          request.accountId,
          offset,
          request.limit,
          request.includeFailed === true,
          request.tokenId
        ));
    const ordered = [...rows].sort((a, b) => {
      const timestampDiff = (a.completedAt || a.initiatedAt || 0) - (b.completedAt || b.initiatedAt || 0);
      return timestampDiff || (a.id ?? '').localeCompare(b.id ?? '');
    });
    const pageRows = request.fromEnd
      ? ordered.slice(-request.limit).reverse()
      : ordered.slice(offset, (offset ?? 0) + request.limit).reverse();
    const oldest = pageRows[pageRows.length - 1];
    const nextCursor =
      oldest?.id !== undefined
        ? { effectiveTimestamp: oldest.completedAt || oldest.initiatedAt || 0, transactionId: oldest.id }
        : null;
    if (nextCursor) {
      offsetsByCursor.set(cursorKey(nextCursor), request.fromEnd ? 0 : (offset ?? 0) + pageRows.length);
    }
    return {
      transactions: pageRows,
      rawCount: pageRows.length,
      hasMore: request.fromEnd ? pageRows.length > 0 : pageRows.length === request.limit,
      nextCursor
    };
  });
  mockGetUncompletedTransactions.mockResolvedValue(makePending());
  mockGetTokenMetadata.mockImplementation(async (id: string | null) => {
    if (id === 'fa1') return { symbol: 'TKF', decimals: 6 };
    if (id === 'fa2') return { symbol: 'SWPMETA', decimals: 2 };
    if (id === 'NATIVE') return { symbol: 'MID', decimals: 8 };
    // The unknown-token placeholder: a symbol, and 6 decimals that are a guess.
    if (id === 'unresolved') return { symbol: 'Unknown', decimals: 6, scaleIsUnknown: true };
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
  mockSuppressedLinkedConsumeIds.mockImplementation(
    async (transactions: Array<{ id: string; extraInputs?: { bridgeIn?: { bridgeReceiveTxId?: string } } }>) =>
      new Set(transactions.filter(tx => tx.extraInputs?.bridgeIn?.bridgeReceiveTxId === 'BR-KEEP').map(tx => tx.id))
  );
  mockSupersededFailedConsumeIds.mockResolvedValue(new Set());
  mockResolveConsumeExtraAmounts.mockResolvedValue([]);
});

afterEach(() => cleanup());

// The activity screen measures "time until the user can see their activity",
// so it needs to know when the first load settles — this list owns that state.
describe('History initial-load signal', () => {
  it('reports the initial load once the reads it needs have answered', async () => {
    const onInitialLoad = jest.fn();

    await renderHistory({ onInitialLoad });

    await waitFor(() => expect(onInitialLoad.mock.calls.length).toBeGreaterThan(0));
  });

  it('does not report a load that is still in flight', async () => {
    let release: (value: unknown[]) => void = () => {};
    mockGetCompletedTransactions.mockImplementation((_addr: string, offset?: number) =>
      offset === undefined ? new Promise(resolve => (release = resolve)) : Promise.resolve([])
    );
    const onInitialLoad = jest.fn();

    await renderHistory({ onInitialLoad });

    expect(onInitialLoad).not.toHaveBeenCalled();

    await act(async () => {
      release([]);
    });

    await waitFor(() => expect(onInitialLoad.mock.calls.length).toBeGreaterThan(0));
  });

  it('reports the load under Pending once the in-flight read answers, though the settled read never runs', async () => {
    mockGetCompletedTransactions.mockImplementation(() => new Promise(() => {}));
    const onInitialLoad = jest.fn();

    await renderHistory({ filter: 'pending', pendingItems: [], onInitialLoad });

    await waitFor(() => expect(onInitialLoad.mock.calls.length).toBeGreaterThan(0));
  });

  it('does not report the load while the in-flight read has not answered', async () => {
    mockGetUncompletedTransactions.mockImplementation(() => new Promise(() => {}));
    const onInitialLoad = jest.fn();

    await renderHistory({ onInitialLoad });
    await waitFor(() => expect(mockGetCompletedTransactions).toHaveBeenCalled());
    await act(async () => undefined);

    expect(onInitialLoad).not.toHaveBeenCalled();
  });

  it('does not report the initial load while the host still defers it', async () => {
    const onInitialLoad = jest.fn();
    const view = await renderHistory({ onInitialLoad, deferInitialLoad: true });
    expect(onInitialLoad).not.toHaveBeenCalled();

    await act(async () => {
      view.rerender(<History address="0xme" onInitialLoad={onInitialLoad} deferInitialLoad={false} />);
    });
    expect(onInitialLoad).toHaveBeenCalledTimes(1);

    view.unmount();
    const onInitialLoadWhileExternal = jest.fn();
    await renderHistory({ onInitialLoad: onInitialLoadWhileExternal, externalLoading: true });
    expect(onInitialLoadWhileExternal).toHaveBeenCalledTimes(1);
  });

  it('does not report the initial load when the hold clears while the page is off screen', async () => {
    const onInitialLoad = jest.fn();
    const view = (onScreen: boolean, deferInitialLoad: boolean) => (
      <PageActiveContext.Provider value={onScreen}>
        <History address="0xme" onInitialLoad={onInitialLoad} deferInitialLoad={deferInitialLoad} />
      </PageActiveContext.Provider>
    );
    let utils: ReturnType<typeof render> | undefined;
    await act(async () => {
      utils = render(view(true, true));
    });
    await waitFor(() => expect(mockGetUncompletedTransactions).toHaveBeenCalled());
    await act(async () => undefined);
    await act(async () => {
      utils?.rerender(view(false, true));
    });
    await act(async () => {
      utils?.rerender(view(false, false));
    });
    expect(onInitialLoad).not.toHaveBeenCalled();
  });
});

describe('History', () => {
  it('filters Arcade by recorded dApp origins on both completed and pending entries, never by token name', async () => {
    const base = { accountId: '0xme', displayMessage: 'GC transfer', displayIcon: 'DEFAULT', type: 'send' };
    mockGetCompletedTransactions.mockResolvedValueOnce([
      {
        ...base,
        id: 'game-complete',
        status: STATUS.Completed,
        completedAt: 200,
        dappOrigins: ['https://game.example']
      },
      { ...base, id: 'unrelated', status: STATUS.Completed, completedAt: 100 }
    ]);
    mockGetUncompletedTransactions.mockResolvedValueOnce([
      { ...base, id: 'game-pending', status: STATUS.Queued, initiatedAt: 300, dappOrigins: ['https://game.example'] }
    ]);
    await renderHistory({
      filter: 'arcade',
      predicate: (entry: { dappOrigins?: string[] }) =>
        entry.dappOrigins?.some(origin => origin === 'https://game.example') ?? false
    });
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(2));
    expect(mockHistoryViewProps.entries.map((entry: { key: string }) => entry.key)).toEqual([
      'pending-game-pending',
      'completed-game-complete'
    ]);
    expect(
      mockHistoryViewProps.entries.every((entry: { dappOrigins?: string[] }) =>
        entry.dappOrigins?.some(origin => origin === 'https://game.example')
      )
    ).toBe(true);
  });

  it('fails closed when Arcade is requested without its origin predicate', async () => {
    await renderHistory({ filter: 'arcade' });
    await waitFor(() => expect(mockGetCompletedTransactions).toHaveBeenCalled());
    expect(mockHistoryViewProps.entries).toEqual([]);
  });
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

  // The Activity title tells an added device from a replaced one by the row's recorded mode.
  it('marks only a hot-key rotation recorded in add mode as a device addition', async () => {
    const rotation = { accountId: '0xme', displayIcon: 'DEFAULT', status: STATUS.Completed };
    mockGetCompletedTransactions.mockResolvedValueOnce([
      { ...rotation, id: 'added', type: 'replace-hot-key', completedAt: 400, extraInputs: { mode: 'add' } },
      { ...rotation, id: 'replaced', type: 'replace-hot-key', completedAt: 300, extraInputs: { mode: 'replace' } },
      { ...rotation, id: 'legacy', type: 'replace-hot-key', completedAt: 200, extraInputs: {} },
      { ...rotation, id: 'other', type: 'execute', completedAt: 100, extraInputs: { mode: 'add' } }
    ]);
    mockGetUncompletedTransactions.mockResolvedValueOnce([]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(4));

    const hotKeyAdded = (id: string) =>
      mockHistoryViewProps.entries.find((entry: { key: string }) => entry.key === `completed-${id}`).hotKeyAdded;
    expect(hotKeyAdded('added')).toBe(true);
    expect(hotKeyAdded('replaced')).toBe(false);
    expect(hotKeyAdded('legacy')).toBe(false);
    expect(hotKeyAdded('other')).toBe(false);
  });

  it('projects each rotation row verdict for the Activity title and chip', async () => {
    const rotation = { accountId: '0xme', displayIcon: 'DEFAULT', type: 'switch-guardian' };
    mockGetCompletedTransactions.mockResolvedValueOnce([
      {
        ...rotation,
        id: 'unconfirmed',
        status: STATUS.Completed,
        displayMessage: 'Guardian switch submitted',
        completedAt: 300,
        extraInputs: { newGuardianEndpoint: 'https://new.example', commitUnconfirmed: true }
      },
      {
        ...rotation,
        id: 'confirmed',
        status: STATUS.Completed,
        displayMessage: 'Guardian switched',
        completedAt: 200,
        extraInputs: { newGuardianEndpoint: 'https://new.example' }
      }
    ]);
    mockGetUncompletedTransactions.mockResolvedValueOnce([
      {
        ...rotation,
        id: 'queued',
        status: STATUS.Queued,
        displayMessage: 'Switching guardian',
        initiatedAt: 400,
        extraInputs: { newGuardianEndpoint: 'https://new.example' }
      }
    ]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(3));

    const verdictOf = (key: string) =>
      mockHistoryViewProps.entries.find((entry: { key: string }) => entry.key === key).guardianSwitchVerdict;
    expect(verdictOf('completed-unconfirmed')).toBe('submitted-unconfirmed');
    expect(verdictOf('completed-confirmed')).toBe('confirmed');
    expect(verdictOf('pending-queued')).toBe('in-flight');
  });

  it('sets isUnconfirmed (and keeps isCancelled) for a stamped user cancel, and for a failed bridge-in consume', async () => {
    mockGetCompletedTransactions.mockResolvedValueOnce([
      // A user cancel the pipeline had already picked up (processingStartedAt set): the row is
      // both isCancelled (Retry stays hidden) and isUnconfirmed (its pipeline may still land).
      {
        id: 'stamped-cancel',
        accountId: '0xme',
        status: STATUS.Failed,
        displayMessage: 'Failed',
        displayIcon: 'FAILED',
        type: 'send',
        completedAt: 500,
        error: 'Transaction was cancelled by user',
        processingStartedAt: 1_600_000_000
      },
      // A bridge-in consume the cold-start sweep failed: unconfirmed, not cancelled.
      {
        id: 'bridge-in-failed',
        accountId: '0xme',
        status: STATUS.Failed,
        displayMessage: 'Failed',
        displayIcon: 'FAILED',
        type: 'consume',
        completedAt: 600,
        error: TRANSACTION_INTERRUPTED_ERROR,
        extraInputs: { bridgeIn: { provider: 'agglayer' } }
      },
      // A rotation the vault shortfall gate names even though it may have submitted: a
      // definite failure, not an unknown outcome (#1250).
      {
        id: 'rotation-shortfall',
        accountId: '0xme',
        status: STATUS.Failed,
        displayMessage: 'Failed',
        displayIcon: 'FAILED',
        type: 'replace-hot-key',
        completedAt: 700,
        error: TRANSACTION_VAULT_SHORTFALL_ERROR,
        mayHaveSubmitted: true
      },
      // A bridged-send `markBridgedSendFailed` demoted after the allocator rejected the intent: its
      // own route evidence proves it failed, so it stays a definite failure too (#1250).
      {
        id: 'bridge-route-failed',
        accountId: '0xme',
        status: STATUS.Failed,
        displayMessage: 'Failed',
        displayIcon: 'FAILED',
        type: 'bridged-send',
        completedAt: 800,
        mayHaveSubmitted: true,
        extraInputs: { provider: 'epoch', claimStatus: 'failed', epochStatus: 'failed' }
      },
      // Siblings whose fill has not (yet) reported failed keep reading not-confirmed.
      {
        id: 'bridge-fill-pending',
        accountId: '0xme',
        status: STATUS.Failed,
        displayMessage: 'Failed',
        displayIcon: 'FAILED',
        type: 'bridged-send',
        completedAt: 900,
        mayHaveSubmitted: true,
        extraInputs: { provider: 'epoch', claimStatus: 'not-applicable', epochStatus: 'pending' }
      },
      {
        id: 'bridge-fill-confirmed',
        accountId: '0xme',
        status: STATUS.Failed,
        displayMessage: 'Failed',
        displayIcon: 'FAILED',
        type: 'bridged-send',
        completedAt: 1000,
        mayHaveSubmitted: true,
        extraInputs: { provider: 'epoch', claimStatus: 'not-applicable', epochStatus: 'confirmed' }
      }
    ]);
    mockGetUncompletedTransactions.mockResolvedValueOnce([]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(6));

    const stampedCancel = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-stamped-cancel');
    expect(stampedCancel.isCancelled).toBe(true);
    expect(stampedCancel.isUnconfirmed).toBe(true);

    const bridgeIn = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-bridge-in-failed');
    expect(bridgeIn.isCancelled).toBe(false);
    expect(bridgeIn.isUnconfirmed).toBe(true);

    const rotationShortfall = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-rotation-shortfall');
    expect(rotationShortfall.isUnconfirmed).toBe(false);

    const bridgeRouteFailed = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-bridge-route-failed');
    expect(bridgeRouteFailed.isUnconfirmed).toBe(false);

    const bridgeFillPending = mockHistoryViewProps.entries.find((e: any) => e.key === 'completed-bridge-fill-pending');
    expect(bridgeFillPending.isUnconfirmed).toBe(true);

    const bridgeFillConfirmed = mockHistoryViewProps.entries.find(
      (e: any) => e.key === 'completed-bridge-fill-confirmed'
    );
    expect(bridgeFillConfirmed.isUnconfirmed).toBe(true);
  });

  it('reads an Unconfirmed row and a Failed row with an open entry as not confirmed, a retired one as failed (#1081)', async () => {
    const send = { accountId: '0xme', displayIcon: 'SEND', type: 'send', displayMessage: 'Sending' };
    const openEntry = { attemptId: 'a', capturedAt: 1, source: 'stage' };
    mockGetCompletedTransactions.mockResolvedValueOnce([
      { ...send, id: 'unconfirmed', status: STATUS.Unconfirmed, completedAt: 500 },
      { ...send, id: 'failed-open', status: STATUS.Failed, completedAt: 600, submitEvidence: [openEntry] },
      {
        ...send,
        id: 'failed-retired',
        status: STATUS.Failed,
        completedAt: 700,
        submitEvidence: [{ ...openEntry, preSubmitEnd: true }]
      }
    ]);
    mockGetUncompletedTransactions.mockResolvedValueOnce([]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(3));

    const byKey = (key: string) => mockHistoryViewProps.entries.find((e: { key: string }) => e.key === key);
    expect(byKey('completed-unconfirmed').isUnconfirmed).toBe(true);
    expect(byKey('completed-failed-open').isUnconfirmed).toBe(true);
    expect(byKey('completed-failed-retired').isUnconfirmed).toBe(false);
    expect(byKey('completed-failed-retired').message).toBe('Transaction failed');
  });

  it('reads settlement once for a history batch of two completed swaps', async () => {
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined
        ? [
            ...makeCompleted(),
            {
              id: 'S2',
              status: STATUS.Completed,
              displayMessage: 'swap msg 2',
              displayIcon: 'SWAP',
              faucetId: 'fa2',
              type: 'swap',
              amount: 6n,
              completedAt: 2100,
              secondaryAccountId: '0xBBC'
            }
          ]
        : []
    );
    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps?.entries?.some((e: any) => e.key === 'completed-S2')).toBe(true));

    expect(resolveSwapHistoryProgress).toHaveBeenCalledTimes(1);
  });

  it('reads linked swap rows once across fill-progress and payback enrichment', async () => {
    mockGetUncompletedTransactions.mockResolvedValueOnce([]);
    mockGetCompletedTransactions.mockResolvedValue([
      {
        id: 'SWAP-A',
        status: STATUS.Completed,
        displayMessage: 'swap A',
        displayIcon: 'SWAP',
        faucetId: 'fa2',
        type: 'swap',
        amount: 6n,
        completedAt: 2200,
        extraInputs: { requestedAmount: 10n, requestedFaucetId: 'fa2' }
      },
      {
        id: 'SWAP-B',
        status: STATUS.Completed,
        displayMessage: 'swap B',
        displayIcon: 'SWAP',
        faucetId: 'fa2',
        type: 'swap',
        amount: 6n,
        completedAt: 2100,
        extraInputs: { requestedAmount: 10n, requestedFaucetId: 'fa2' }
      }
    ]);

    const linkedRows = [
      {
        id: 'FILL-A',
        type: 'consume',
        status: STATUS.Completed,
        accountId: '0xme',
        initiatedAt: 2300,
        completedAt: 2300,
        transactionId: 'fill-a',
        noteIds: ['fill-a-note'],
        amount: 4n,
        faucetId: 'fa2',
        extraInputs: { swapOrderTxId: 'SWAP-A', swapSettleKind: 'settle' }
      },
      {
        id: 'FAILED-B',
        type: 'consume',
        status: STATUS.Failed,
        accountId: '0xme',
        initiatedAt: 2400,
        noteIds: ['failed-b-note'],
        error: 'Transaction failed',
        extraInputs: { swapOrderTxId: 'SWAP-B', swapSettleKind: 'settle' }
      }
    ];

    let swapOrderReads = 0;
    const requestedSwapIds: string[][] = [];
    const originalWhere = Repo.transactions.where.bind(Repo.transactions);
    const where = jest.spyOn(Repo.transactions, 'where');
    where.mockImplementation(((index: string) => {
      if (index === 'noteId' || index === 'noteIds') {
        return { anyOf: () => ({ toArray: async () => [] }) } as unknown as ReturnType<typeof Repo.transactions.where>;
      }
      if (index !== 'extraInputs.swapOrderTxId') return originalWhere(index as never);
      return {
        anyOf: (ids: string[]) => {
          swapOrderReads += 1;
          requestedSwapIds.push([...ids]);
          const query: { filter: () => typeof query; toArray: () => Promise<never[]> } = {
            filter: () => query,
            toArray: async () => linkedRows.filter(row => ids.includes(row.extraInputs.swapOrderTxId)) as never[]
          };
          return query;
        }
      } as unknown as ReturnType<typeof Repo.transactions.where>;
    }) as typeof Repo.transactions.where);

    const actualResolveSwapHistoryProgress =
      jest.requireActual<typeof import('./resolveSwapHistoryProgress')>(
        './resolveSwapHistoryProgress'
      ).resolveSwapHistoryProgress;
    jest.mocked(resolveSwapHistoryProgress).mockImplementation(actualResolveSwapHistoryProgress);

    try {
      await renderHistory();
      await waitFor(() => expect(mockHistoryViewProps?.entries).toHaveLength(2));

      expect(swapOrderReads).toBe(1);
      expect(requestedSwapIds).toHaveLength(1);
      expect(requestedSwapIds.flat().sort()).toEqual(['SWAP-A', 'SWAP-B']);
      expect(mockHistoryViewProps.entries.find((entry: any) => entry.key === 'completed-SWAP-A').swapFillProgress).toBe(
        '40'
      );
      expect(
        mockHistoryViewProps.entries.find((entry: any) => entry.key === 'completed-SWAP-B').paybackClaimStuck
      ).toEqual({ failedClaimId: 'FAILED-B', reason: 'other' });
    } finally {
      where.mockRestore();
      jest.mocked(resolveSwapHistoryProgress).mockImplementation(async () => new Map());
    }
  });

  it('keeps the completed page when the shared linked swap row read fails', async () => {
    mockGetUncompletedTransactions.mockResolvedValueOnce([]);
    mockGetCompletedTransactions.mockResolvedValue([
      {
        id: 'SWAP-READ-FAIL',
        status: STATUS.Completed,
        displayMessage: 'swap',
        displayIcon: 'SWAP',
        faucetId: 'fa2',
        type: 'swap',
        amount: 6n,
        completedAt: 2200,
        extraInputs: { requestedAmount: 10n }
      }
    ]);

    let swapOrderReads = 0;
    const originalWhere = Repo.transactions.where.bind(Repo.transactions);
    const where = jest.spyOn(Repo.transactions, 'where');
    where.mockImplementation(((index: string) => {
      if (index !== 'extraInputs.swapOrderTxId') return originalWhere(index as never);
      const query: { filter: () => typeof query; toArray: () => Promise<never[]> } = {
        filter: () => query,
        toArray: async () => {
          swapOrderReads += 1;
          throw new Error('linked swap row read failed');
        }
      };
      return {
        anyOf: () => query
      } as unknown as ReturnType<typeof Repo.transactions.where>;
    }) as typeof Repo.transactions.where);

    const actualResolveSwapHistoryProgress =
      jest.requireActual<typeof import('./resolveSwapHistoryProgress')>(
        './resolveSwapHistoryProgress'
      ).resolveSwapHistoryProgress;
    jest.mocked(resolveSwapHistoryProgress).mockImplementation(actualResolveSwapHistoryProgress);

    try {
      await renderHistory();
      await waitFor(() =>
        expect(mockHistoryViewProps?.entries.some((entry: any) => entry.key === 'completed-SWAP-READ-FAIL')).toBe(true)
      );

      const entry = mockHistoryViewProps.entries.find((item: any) => item.key === 'completed-SWAP-READ-FAIL');
      expect(entry.swapFillProgress).toBeUndefined();
      expect(entry.paybackClaimStuck).toBeUndefined();
      expect(swapOrderReads).toBe(1);
    } finally {
      where.mockRestore();
      jest.mocked(resolveSwapHistoryProgress).mockImplementation(async () => new Map());
    }
  });

  it('does not read linked swap rows when the completed page has no swaps', async () => {
    mockGetCompletedTransactions.mockResolvedValue([]);
    mockGetUncompletedTransactions.mockResolvedValue([]);

    let swapOrderReads = 0;
    const originalWhere = Repo.transactions.where.bind(Repo.transactions);
    const where = jest.spyOn(Repo.transactions, 'where');
    where.mockImplementation(((index: string) => {
      if (index === 'extraInputs.swapOrderTxId') swapOrderReads += 1;
      return originalWhere(index as never);
    }) as typeof Repo.transactions.where);

    try {
      await renderHistory();
      await waitFor(() => expect(mockHistoryViewProps?.entries).toEqual([]));

      expect(swapOrderReads).toBe(0);
    } finally {
      where.mockRestore();
    }
  });

  it('refreshes settlement fields on an older loaded swap from its current stored row', async () => {
    await Repo.transactions.clear();

    const latest: ITransaction = {
      id: 'LATEST-HEAD',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'consume',
      initiatedAt: 5000,
      completedAt: 5000,
      displayIcon: 'RECEIVE'
    };
    const olderSwap: ITransaction = {
      id: 'OLDER-SWAP',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'swap',
      initiatedAt: 1000,
      completedAt: 1000,
      displayIcon: 'SWAP',
      faucetId: 'fa1',
      amount: 5n,
      outputNoteIds: ['order-note'],
      extraInputs: {
        orderId: 'order-1',
        autoConsume: true,
        expiresAt: 4_000_000_000,
        requestedAmount: 10n,
        requestedFaucetId: 'fa2'
      }
    };
    const fill: ITransaction = {
      id: 'OLDER-FILL',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'consume',
      initiatedAt: 1100,
      completedAt: 1100,
      displayIcon: 'RECEIVE',
      noteIds: ['fill-note'],
      amount: 4n,
      faucetId: 'fa2',
      extraInputs: { swapOrderTxId: olderSwap.id, swapSettleKind: 'settle' }
    };
    await Repo.transactions.bulkPut([latest, olderSwap, fill]);

    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) {
        return {
          transactions: [latest],
          rawCount: 1,
          hasMore: true,
          nextCursor: { effectiveTimestamp: 5000, transactionId: latest.id }
        };
      }
      return {
        transactions: [olderSwap],
        rawCount: 1,
        hasMore: false,
        nextCursor: { effectiveTimestamp: 1000, transactionId: olderSwap.id }
      };
    });

    const actualResolveSwapHistoryProgress =
      jest.requireActual<typeof import('./resolveSwapHistoryProgress')>(
        './resolveSwapHistoryProgress'
      ).resolveSwapHistoryProgress;
    jest.mocked(resolveSwapHistoryProgress).mockImplementation(actualResolveSwapHistoryProgress);
    mockGetUncompletedTransactions.mockResolvedValueOnce([]);

    try {
      await renderHistory();
      await waitFor(() => expect(mockHistoryViewProps?.entries).toHaveLength(1));
      await act(async () => {
        await mockHistoryViewProps.loadMore(0);
      });
      await waitFor(() =>
        expect(
          mockHistoryViewProps?.entries.find((entry: any) => entry.key === 'completed-OLDER-SWAP')?.swapFillProgress
        ).toBe('40')
      );
      expect(
        mockHistoryViewProps.entries.find((entry: any) => entry.key === 'completed-OLDER-SWAP')?.swapSettlement
      ).toBe('pending');

      await Repo.transactions.put({
        ...olderSwap,
        extraInputs: { ...olderSwap.extraInputs, reclaimedAt: 1200 }
      });
      await Repo.transactions.put({ ...fill, amount: 10n });

      await act(async () => {
        mockSwrMutates['latest-transactions']?.();
      });
      await waitFor(() =>
        expect(
          mockHistoryViewProps?.entries.find((entry: any) => entry.key === 'completed-OLDER-SWAP')?.swapFillProgress
        ).toBe('100')
      );
      expect(
        mockHistoryViewProps.entries.find((entry: any) => entry.key === 'completed-OLDER-SWAP')?.swapSettlement
      ).toBe('reclaimed');
    } finally {
      await Repo.transactions.clear();
      jest.mocked(resolveSwapHistoryProgress).mockImplementation(async () => new Map());
    }
  });

  it('enriches only the newest refresh page and only the older loadMore page', async () => {
    const newest = {
      id: 'REFRESH',
      status: STATUS.Completed,
      displayMessage: 'latest swap',
      displayIcon: 'SWAP',
      faucetId: 'fa2',
      type: 'swap',
      amount: 6n,
      completedAt: 5000,
      secondaryAccountId: '0xBBB'
    };
    const older = { ...newest, id: 'OLDER', displayMessage: 'older swap', completedAt: 1000 };
    mockGetCompletedTransactions.mockImplementation(
      async (
        _addr: string,
        _offset?: number,
        _limit?: number,
        _includeFailed?: boolean,
        _tokenId?: string,
        fromEnd?: boolean
      ) => (fromEnd ? [newest] : [older])
    );

    await renderHistory();
    await waitFor(() => expect(resolveSwapHistoryProgress).toHaveBeenCalledTimes(1));

    expect(mockGetCompletedTransactions).toHaveBeenNthCalledWith(1, '0xme', undefined, 1000, true, undefined, true);
    expect(resolveSwapHistoryProgress).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ id: 'REFRESH' })],
      expect.any(Array)
    );

    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });

    expect(mockGetCompletedTransactions).toHaveBeenNthCalledWith(2, '0xme', 0, 1000, true, undefined);
    expect(resolveSwapHistoryProgress).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ id: 'OLDER' })],
      expect.any(Array)
    );
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
    expect(mockGetCompletedTransactions).toHaveBeenCalledWith('0xme', undefined, 1000, true, undefined, true);
    expect(mockGetCompletedTransactionsPage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: '0xme', includeFailed: true, fromEnd: true })
    );
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

  // Converting by the placeholder's guessed 6 decimals renders an 18-decimal
  // token a trillion times too large, so the row names the asset and prints no
  // number. It must still be NAMED — dropping the symbol too would leave a row
  // that says nothing about what moved.
  it.each(['completed', 'pending'])('names a %s row of the testnet bridge faucet by its label', async kind => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    mockGetTokenMetadata.mockResolvedValue({ symbol: 'USDC', decimals: 6 });
    const row = {
      id: 'USDC',
      status: kind === 'completed' ? STATUS.Completed : STATUS.Queued,
      displayMessage: 'Received',
      displayIcon: 'RECEIVE',
      faucetId: TEST_MIDEN_USDC_FAUCET,
      type: 'consume',
      amount: 5000000n,
      completedAt: 4000
    };
    if (kind === 'completed') {
      mockGetCompletedTransactions.mockImplementation(async (_a: string, offset?: number) =>
        offset === undefined ? [row] : []
      );
      mockGetUncompletedTransactions.mockResolvedValue([]);
    } else {
      mockGetCompletedTransactions.mockImplementation(async () => []);
      mockGetUncompletedTransactions.mockResolvedValue([row]);
    }

    await renderHistory();

    const key = kind === 'completed' ? 'completed-USDC' : 'pending-USDC';
    await waitFor(() => expect(entryKeys()).toContain(key));
    expect(mockHistoryViewProps.entries.find((e: any) => e.key === key).token).toBe('Test Epoch USDC');
  });

  it('names a first-page row and a paged row by the testnet label once the bridge config publishes', async () => {
    mockGetTokenMetadata.mockResolvedValue({ symbol: 'USDC', decimals: 6 });
    const usdcRow = (id: string, completedAt: number) => ({
      id,
      status: STATUS.Completed,
      displayMessage: 'Received',
      displayIcon: 'RECEIVE',
      faucetId: TEST_MIDEN_USDC_FAUCET,
      type: 'consume',
      amount: 5000000n,
      completedAt
    });
    mockGetCompletedTransactions.mockImplementation(async (_a: string, offset?: number) =>
      offset === undefined ? [usdcRow('FIRST', 4000)] : [usdcRow('PAGED', 10)]
    );
    mockGetUncompletedTransactions.mockResolvedValue([]);
    const { rerender } = await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain('completed-FIRST'));
    await act(async () => {
      await mockHistoryViewProps.loadMore(1);
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-PAGED'));
    const tokenOf = (key: string) => mockHistoryViewProps.entries.find((e: any) => e.key === key).token;
    expect([tokenOf('completed-FIRST'), tokenOf('completed-PAGED')]).toEqual(['USDC', 'USDC']);

    act(() => {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
      publishMockBridgeSnapshot();
    });

    expect([tokenOf('completed-FIRST'), tokenOf('completed-PAGED')]).toEqual(['Test Epoch USDC', 'Test Epoch USDC']);
    await act(async () => {
      rerender(<History address="0xme" searchQuery="test epoch" />);
    });
    expect(entryKeys()).toEqual(['completed-FIRST', 'completed-PAGED']);
  });

  it.each([
    ['completed', 'mockGetCompletedTransactions'],
    ['pending', 'mockGetUncompletedTransactions']
  ])('names but does not quantify a %s row whose faucet has no known scale', async (kind, _mock) => {
    const row = {
      id: 'UNK',
      status: kind === 'completed' ? STATUS.Completed : STATUS.Queued,
      displayMessage: 'unresolved token',
      displayIcon: 'RECEIVE',
      faucetId: 'unresolved',
      type: 'consume',
      amount: 1000000000000000000n,
      completedAt: 4000
    };
    if (kind === 'completed') {
      mockGetCompletedTransactions.mockImplementation(async (_a: string, offset?: number) =>
        offset === undefined ? [row] : []
      );
      mockGetUncompletedTransactions.mockResolvedValue([]);
    } else {
      mockGetCompletedTransactions.mockImplementation(async () => []);
      mockGetUncompletedTransactions.mockResolvedValue([row]);
    }

    await renderHistory();

    const key = kind === 'completed' ? 'completed-UNK' : 'pending-UNK';
    await waitFor(() => expect(entryKeys()).toContain(key));
    const entry = mockHistoryViewProps.entries.find((e: any) => e.key === key);
    expect(entry.amount).toBeUndefined();
    expect(entry.token).toBe('Unknown');
    expect(mockFormatAmount).not.toHaveBeenCalledWith(1000000000000000000n, 6);
  });

  describe('a failed read', () => {
    it('forwards a load error when the transactions read fails', async () => {
      mockGetCompletedTransactions.mockRejectedValue(new Error('db down'));
      await renderHistory();

      await waitFor(() => expect(mockHistoryViewProps.loadError).toBe(true));
    });

    it('forwards a load error when only the pending read fails, beside an empty transactions read', async () => {
      mockGetCompletedTransactions.mockResolvedValue([]);
      mockGetUncompletedTransactions.mockRejectedValue(new Error('db down'));
      await renderHistory();

      await waitFor(() => expect(mockHistoryViewProps.loadError).toBe(true));
    });

    it('re-runs both reads on Retry', async () => {
      mockGetCompletedTransactions.mockRejectedValue(new Error('db down'));
      await renderHistory();
      await waitFor(() => expect(mockHistoryViewProps.loadError).toBe(true));

      await act(async () => mockHistoryViewProps.onRetry());
      expect(mockSwrMutates['latest-transactions']).toHaveBeenCalled();
      expect(mockSwrMutates['latest-pending-transactions']).toHaveBeenCalled();
    });

    it('never runs the settled read under Pending, so its failure cannot surface there', async () => {
      mockGetCompletedTransactions.mockRejectedValue(new Error('db down'));
      await renderHistory({ filter: 'pending' });

      await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
      expect(mockGetCompletedTransactions).not.toHaveBeenCalled();
      expect(mockHistoryViewProps.loadError).toBe(false);
    });

    it("never carries another account's rows across a switch: neither read keeps the previous key's data", async () => {
      await renderHistory();

      for (const read of ['latest-transactions', 'latest-pending-transactions']) {
        expect(mockSwrConfigs[read]).toBeDefined();
        expect(mockSwrConfigs[read]).not.toHaveProperty('keepPreviousData');
      }
    });

    it('keeps loading while the pending read is still in flight after the transactions read resolved', async () => {
      mockGetCompletedTransactions.mockResolvedValue([]);
      mockGetUncompletedTransactions.mockReturnValue(new Promise(() => undefined));
      await act(async () => {
        render(<History address="0xme" />);
      });

      await waitFor(() => expect(mockHistoryViewProps).toBeDefined());
      expect(mockHistoryViewProps.initialLoading).toBe(true);
    });

    it('forwards no load error when both reads succeed', async () => {
      await renderHistory();

      await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
      expect(mockHistoryViewProps.loadError).toBe(false);
    });
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

  it('hides the list spinner only when asked, not because a loading callback is attached', async () => {
    const view = await renderHistory({ onLoadingChange: jest.fn() });
    expect(mockHistoryViewProps.hideLoadingSpinner).toBeFalsy();
    view.unmount();

    await renderHistory({ onLoadingChange: jest.fn(), hideLoadingSpinner: true });
    expect(mockHistoryViewProps.hideLoadingSpinner).toBe(true);
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

  it('finds a swap by the asset it asks for, which only its requestedToken names', async () => {
    const { rerender } = await renderHistory();
    await act(async () => {
      rerender(<History address="0xme" searchQuery="S-REQTOK" />);
    });
    expect(entryKeys().sort()).toEqual(['completed-S', 'pending-PP'].sort());
  });

  it('filters by transfer / swap / earn / others / all, by the tx type of each row', async () => {
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined
        ? [
            ...makeCompleted(),
            { id: 'ED', status: STATUS.Completed, displayIcon: 'SEND', type: 'earn-deposit', completedAt: 1500 },
            { id: 'EW', status: STATUS.Failed, displayIcon: 'RECEIVE', type: 'earn-withdraw', completedAt: 1400 },
            { id: 'EX', status: STATUS.Completed, displayIcon: 'SEND', type: 'execute', completedAt: 1300 },
            { id: 'RH', status: STATUS.Completed, type: 'replace-hot-key', completedAt: 1200 },
            { id: 'BS', status: STATUS.Failed, displayIcon: 'SEND', type: 'bridged-send', completedAt: 1100 }
          ]
        : []
    );
    const { rerender } = await renderHistory();
    const doRerender = async (props: Record<string, unknown>) => {
      await act(async () => {
        rerender(<History address="0xme" {...(props as any)} />);
      });
    };
    const shown = () => [...entryKeys()].sort();

    // transfer → sends, receives and bridges, failed and cancelled ones included (their icon is
    // FAILED, so the filter reads the tx type), and the faucet claim off Mainnet.
    await doRerender({ filter: 'transfer' });
    expect(shown()).toEqual(
      [
        'pending-PQ',
        'pending-undefined',
        'completed-P',
        'completed-SD',
        'completed-FC',
        'completed-F',
        'completed-C',
        'completed-BS'
      ].sort()
    );

    await doRerender({ filter: 'swap' });
    expect(shown()).toEqual(['completed-S', 'pending-PP'].sort());

    // A failed withdraw stays under Earn.
    await doRerender({ filter: 'earn' });
    expect(shown()).toEqual(['completed-ED', 'completed-EW']);

    await doRerender({ filter: 'others' });
    expect(shown()).toEqual(['completed-EX', 'completed-RH']);

    // all → filter block skipped, everything retained.
    await doRerender({ filter: 'all' });
    expect(entryKeys().length).toBe(14);
  });

  describe('faucet rows by network', () => {
    beforeEach(() => {
      // A faucet claim still in flight, which only the Pending chip lists. Its row has no icon yet.
      mockGetUncompletedTransactions.mockResolvedValue([
        ...makePending(),
        {
          id: 'PF',
          status: STATUS.Queued,
          displayMessage: 'faucet claim',
          faucetId: 'NATIVE',
          type: 'consume',
          initiatedAt: 450,
          secondaryAccountId: 'NATIVE'
        }
      ]);
      // A faucet claim that failed: its icon is FAILED, so only a test of the row itself can recognise it.
      mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
        offset === undefined
          ? [
              ...makeCompleted(),
              {
                id: 'FF',
                status: STATUS.Failed,
                displayMessage: 'faucet claim failed',
                displayIcon: 'FAILED',
                faucetId: 'NATIVE',
                type: 'consume',
                completedAt: 1990,
                secondaryAccountId: 'NATIVE'
              }
            ]
          : []
      );
      // As the real `isFaucetRequest` reads a row: a receive (a consume with no icon yet counts) of the native asset.
      mockIsFaucetRequest.mockImplementation(
        (entry: any) =>
          entry.faucetId === 'NATIVE' &&
          (entry.transactionIcon === 'RECEIVE' || (entry.transactionIcon === undefined && entry.txType === 'consume'))
      );
    });

    const viewsOf = async (rerender: (ui: React.ReactElement) => void) => {
      const keysFor = async (props: Record<string, unknown>) => {
        await act(async () => {
          rerender(<History address="0xme" {...(props as any)} />);
        });
        return entryKeys();
      };
      return {
        all: await keysFor({ filter: 'all' }),
        pending: await keysFor({ filter: 'pending' }),
        transfer: await keysFor({ filter: 'transfer' }),
        others: await keysFor({ filter: 'others' }),
        search: await keysFor({ searchQuery: 'faucet' })
      };
    };

    it.each([MIDEN_NETWORK_NAME.TESTNET, MIDEN_NETWORK_NAME.MAINNET])(
      'shows the faucet rows on %s in every filter and in the search',
      async network => {
        // On Mainnet the native faucet is the USDCx minter, so a consume of the native asset sent by
        // its faucet is a bridge-in; hiding such rows there hid every bridged-in claim (#1655 follow-up).
        mockWalletNetwork = network;
        const { rerender } = await renderHistory();
        const views = await viewsOf(rerender);

        expect(views.all).toEqual(expect.arrayContaining(['completed-FC', 'completed-FF', 'pending-PF']));
        expect(views.pending).toContain('pending-PF');
        expect(views.transfer).toEqual(expect.arrayContaining(['completed-FC', 'pending-PF']));
        expect(views.search.sort()).toEqual(['completed-FC', 'pending-PF']);
      }
    );

    // `isFaucetRequest` is mocked here, so only `transactionUtils.test` and `activityGroups.test` can
    // say that Mainnet groups such a row under its sender instead.
    it('gives the Groups view a faucet group off Mainnet', async () => {
      let seen: any;
      const utils = await renderHistory({
        renderEntries: (view: any) => {
          seen = view;
          return <div data-testid="history-view" />;
        }
      });
      await waitFor(() => expect(seen?.initialLoading).toBe(false));
      expect(groupActivityEntries(seen.entries).map(group => group.kind)).toContain('faucet');
      utils.unmount();
    });

    // The rows read the id during render (`isFaucetRequest`) and the row components are memoized on the
    // entry, so a row that mounted while the id was unknown is relabelled only by a new entry object.
    it('hands the rows new entries once the native faucet id resolves', async () => {
      mockNativeAssetId = null;
      let resolveLookup!: (id: string) => void;
      mockNativeAssetLookup = new Promise(resolve => {
        resolveLookup = resolve;
      });
      let seen: any;
      const utils = await renderHistory({
        renderEntries: (view: any) => {
          seen = view;
          return <div data-testid="history-view" />;
        }
      });
      await waitFor(() => expect(seen?.initialLoading).toBe(false));
      // Let the load settle, so only the id can replace the entries.
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });
      const before = seen.entries[0];
      expect(before).toBeDefined();

      mockNativeAssetId = 'NATIVE';
      await act(async () => {
        resolveLookup('NATIVE');
      });

      await waitFor(() => expect(seen.entries[0]).not.toBe(before));
      utils.unmount();
    });
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
    await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));

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
    // Two rows against a 1000 limit is a short page, so the history is
    // exhausted and paging stops here.
    await waitFor(() => expect(mockHistoryViewProps.hasMore).toBe(false));
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

  it('shows a requeued transaction as pending after the refreshed settled head becomes empty', async () => {
    const failed = {
      id: 'requeued',
      status: STATUS.Failed,
      displayMessage: 'Transaction failed',
      displayIcon: 'FAILED',
      type: 'send',
      completedAt: 1000,
      initiatedAt: 900
    };
    const queued = {
      id: 'requeued',
      status: STATUS.Queued,
      displayMessage: 'Sending again',
      type: 'send',
      initiatedAt: 1100
    };
    let settledRows = [failed];
    let pendingRows: (typeof queued)[] = [];
    mockGetCompletedTransactions.mockImplementation(async (_address: string, offset?: number) =>
      offset === undefined ? settledRows : []
    );
    mockGetUncompletedTransactions.mockImplementation(async () => pendingRows);

    await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain('completed-requeued'));

    settledRows = [];
    pendingRows = [queued];
    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
      mockSwrMutates['latest-pending-transactions']?.();
    });

    await waitFor(() => expect(entryKeys()).toContain('pending-requeued'));
    expect(entryKeys()).not.toContain('completed-requeued');
    expect(entryKeys().filter(key => key?.includes('requeued'))).toEqual(['pending-requeued']);
  });

  it('loads older history contiguously after the initial newest page', async () => {
    const makeRow = (id: string, timestamp: number) => ({
      id,
      status: STATUS.Completed,
      displayMessage: 'history item',
      displayIcon: 'RECEIVE',
      faucetId: undefined,
      type: 'consume',
      amount: undefined,
      completedAt: timestamp === 100 ? 0 : timestamp,
      initiatedAt: timestamp
    });
    const rows = Array.from({ length: HISTORY_PAGE_SIZE * 2 + 17 }, (_, index) =>
      makeRow(`page-${String(index).padStart(4, '0')}`, index + 100)
    );
    const records = [...rows];
    const cursorFor = (row: (typeof records)[number]) => ({
      effectiveTimestamp: row.completedAt || row.initiatedAt,
      transactionId: row.id
    });
    const olderRequests: Array<{ cursor?: unknown }> = [];
    const descending = (a: (typeof records)[number], b: (typeof records)[number]) =>
      (b.completedAt || b.initiatedAt) - (a.completedAt || a.initiatedAt) || b.id.localeCompare(a.id);

    mockGetCompletedTransactions.mockImplementation(
      async (
        _address: string,
        offset?: number,
        limit?: number,
        _includeFailed?: boolean,
        _tokenId?: string,
        fromEnd?: boolean
      ) => {
        const ordered = [...records].sort(
          (a, b) => (a.completedAt || a.initiatedAt) - (b.completedAt || b.initiatedAt)
        );
        if (fromEnd) return ordered.slice(-limit!);
        const start = offset ?? 0;
        return ordered.slice(start, start + (limit ?? HISTORY_PAGE_SIZE));
      }
    );
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      const ordered = [...records].sort(descending);
      if (request.fromEnd) {
        const page = ordered.slice(0, request.limit);
        return {
          transactions: page,
          rawCount: page.length,
          hasMore: ordered.length > page.length,
          nextCursor: page.length ? cursorFor(page[page.length - 1]!) : null
        };
      }
      olderRequests.push({ cursor: request.cursor });
      const pageRows = ordered.filter(row => {
        const cursor = request.cursor;
        const effectiveTimestamp = row.completedAt || row.initiatedAt;
        return (
          !cursor ||
          effectiveTimestamp < cursor.effectiveTimestamp ||
          (effectiveTimestamp === cursor.effectiveTimestamp && row.id < cursor.transactionId)
        );
      });
      const page = pageRows.slice(0, request.limit);
      return {
        transactions: page,
        rawCount: page.length,
        hasMore: pageRows.length > page.length,
        nextCursor: page.length ? cursorFor(page[page.length - 1]!) : request.cursor
      };
    });

    await renderHistory();
    const initialBoundary = cursorFor(rows[rows.length - HISTORY_PAGE_SIZE]!);
    await waitFor(() => expect(entryKeys()).toContain(`completed-${rows[rows.length - 1]!.id}`));

    records.push(makeRow('page-newer', rows.length + 100));
    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-page-newer'));

    await act(async () => {
      await mockHistoryViewProps.loadMore(1);
    });
    await act(async () => {
      await mockHistoryViewProps.loadMore(2);
    });

    const loadedIds = entryKeys().filter((key): key is string => key?.startsWith('completed-page-') ?? false);
    const allIds = records.map(row => `completed-${row.id}`).sort();
    expect(loadedIds.sort()).toEqual(allIds);
    expect(new Set(loadedIds).size).toBe(allIds.length);
    expect(olderRequests[0]?.cursor).toEqual(initialBoundary);
    expect(
      mockHistoryViewProps.entries.find((entry: { key: string }) => entry.key === 'completed-page-0000')?.timestamp
    ).toBe(100);
  });

  it('backfills every row between a refreshed head and the older-page cursor', async () => {
    const makeRow = (id: string, timestamp: number) => ({
      id,
      status: STATUS.Completed,
      displayMessage: id,
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: timestamp,
      initiatedAt: timestamp
    });
    const oldRows = Array.from({ length: HISTORY_PAGE_SIZE * 2 + 17 }, (_, index) =>
      makeRow(`old-${String(index).padStart(4, '0')}`, index + 100)
    );
    const insertedRows = Array.from({ length: HISTORY_PAGE_SIZE * 2 + 1 }, (_, index) =>
      makeRow(`inserted-${String(index).padStart(4, '0')}`, 10_000 + index)
    );
    const records = [...oldRows];
    const cursorFor = (row: (typeof records)[number]) => ({
      effectiveTimestamp: row.completedAt || row.initiatedAt,
      transactionId: row.id,
      status: row.status,
      initiatedAt: row.initiatedAt
    });
    const newestFirst = (a: (typeof records)[number], b: (typeof records)[number]) =>
      (b.completedAt || b.initiatedAt) - (a.completedAt || a.initiatedAt) || b.id.localeCompare(a.id);
    mockGetUncompletedTransactions.mockResolvedValue([]);
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      const ordered = [...records].sort(newestFirst);
      const eligible = request.fromEnd
        ? ordered
        : ordered.filter(row => {
            const cursor = request.cursor;
            const timestamp = row.completedAt || row.initiatedAt;
            return (
              !cursor ||
              timestamp < cursor.effectiveTimestamp ||
              (timestamp === cursor.effectiveTimestamp && row.id < cursor.transactionId)
            );
          });
      const page = eligible.slice(0, request.limit);
      const oldest = page[page.length - 1];
      return {
        transactions: page,
        rawIds: page.map(row => row.id),
        rawCount: page.length,
        hasMore: eligible.length > page.length,
        nextCursor: oldest ? cursorFor(oldest) : (request.cursor ?? null)
      };
    });

    await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain(`completed-${oldRows[oldRows.length - 1]!.id}`));
    records.push(...insertedRows);

    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });
    await waitFor(() => expect(entryKeys()).toContain(`completed-${insertedRows[insertedRows.length - 1]!.id}`));

    let page = 1;
    while (mockHistoryViewProps.hasMore && page <= 5) {
      const loadMore = mockHistoryViewProps.loadMore;
      const currentPage = page++;
      await act(async () => {
        await loadMore(currentPage);
      });
    }

    const loadedIds = entryKeys().filter((key): key is string => key?.startsWith('completed-') ?? false);
    const expectedIds = [...oldRows, ...insertedRows].map(row => `completed-${row.id}`).sort();
    expect(mockHistoryViewProps.hasMore).toBe(false);
    expect(loadedIds).toContain('completed-inserted-0000');
    expect(loadedIds.sort()).toEqual(expectedIds);
    expect(new Set(loadedIds).size).toBe(expectedIds.length);
  });

  it('stops a gap backfill when a suppressed consume page still carries a known raw id', async () => {
    const row = (id: string, timestamp: number) => ({
      id,
      status: STATUS.Completed,
      displayMessage: id,
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: timestamp,
      initiatedAt: timestamp
    });
    const anchor = row('anchor', 2000);
    const head = row('head', 5000);
    const gapVisible = row('gap-visible', 4000);
    const linkedKnown = row('linked-known', 1500);
    const tail = row('tail-older', 1000);
    const cursorFor = (entry: ReturnType<typeof row>): CompletedHistoryCursor => ({
      effectiveTimestamp: entry.completedAt,
      transactionId: entry.id,
      status: entry.status,
      initiatedAt: entry.initiatedAt
    });
    let refreshed = false;
    const olderCursors: unknown[] = [];
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) {
        const page = refreshed ? [head] : [anchor, linkedKnown];
        return {
          transactions: page,
          rawCount: page.length,
          hasMore: true,
          nextCursor: cursorFor(page[page.length - 1]!)
        };
      }
      olderCursors.push(request.cursor);
      if (olderCursors.length === 1) {
        const page = [gapVisible, linkedKnown];
        return {
          transactions: page,
          rawCount: page.length,
          hasMore: true,
          nextCursor: cursorFor(linkedKnown)
        };
      }
      return { transactions: [tail], rawCount: 1, hasMore: false, nextCursor: cursorFor(tail) };
    });
    mockSuppressedLinkedConsumeIds.mockImplementation(
      async (transactions: Array<{ id: string }>) =>
        new Set(transactions.filter(tx => tx.id.startsWith('linked-')).map(tx => tx.id))
    );
    mockGetUncompletedTransactions.mockResolvedValue([]);

    await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain('completed-anchor'));
    refreshed = true;
    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });

    await waitFor(() => expect(entryKeys()).toContain('completed-gap-visible'));
    expect(entryKeys()).toContain('completed-head');
    expect(entryKeys()).toContain('completed-anchor');
    expect(entryKeys().some(key => key?.includes('linked-'))).toBe(false);
    expect(entryKeys()).not.toContain('completed-tail-older');
    expect(olderCursors).toHaveLength(1);
  });

  it('does not retry a gap backfill when its cursor stops advancing', async () => {
    const row = (id: string, timestamp: number) => ({
      id,
      status: STATUS.Completed,
      displayMessage: id,
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: timestamp,
      initiatedAt: timestamp
    });
    const anchor = row('stalled-anchor', 1000);
    const head = row('stalled-head', 5000);
    const pageRow = row('stalled-page-row', 4000);
    const cursorFor = (entry: ReturnType<typeof row>): CompletedHistoryCursor => ({
      effectiveTimestamp: entry.completedAt,
      transactionId: entry.id,
      status: entry.status,
      initiatedAt: entry.initiatedAt
    });
    let refreshed = false;
    const olderCursors: unknown[] = [];
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) {
        const page = refreshed ? [head] : [anchor];
        return {
          transactions: page,
          rawCount: page.length,
          hasMore: true,
          nextCursor: cursorFor(page[page.length - 1]!)
        };
      }
      olderCursors.push(request.cursor);
      return {
        transactions: [pageRow],
        rawCount: 1,
        hasMore: true,
        nextCursor: cursorFor(head)
      };
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);

    await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain('completed-stalled-anchor'));
    refreshed = true;
    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-stalled-page-row'));
    expect(olderCursors).toHaveLength(1);

    await act(() => new Promise(resolve => setTimeout(resolve, 3_100)));
    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });
    expect(olderCursors).toHaveLength(1);
  });

  it('continues the gap backfill without restarting on a same-head refresh', async () => {
    const row = (id: string, timestamp: number) => ({
      id,
      status: STATUS.Completed,
      displayMessage: id,
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: timestamp,
      initiatedAt: timestamp
    });
    const anchor = row('old-anchor', 1000);
    const head = row('inserted-head', 4000);
    const mid = row('inserted-mid', 3000);
    const oldest = row('inserted-0000', 2000);
    const cursorFor = (entry: ReturnType<typeof row>): CompletedHistoryCursor => ({
      effectiveTimestamp: entry.completedAt,
      transactionId: entry.id,
      status: entry.status,
      initiatedAt: entry.initiatedAt
    });
    const pageOf = (transactions: ReturnType<typeof row>[], hasMore = true) => ({
      transactions,
      rawCount: transactions.length,
      hasMore,
      nextCursor: cursorFor(transactions[transactions.length - 1]!)
    });
    const tail = row('tail-older', 500);
    let refreshed = false;
    const pending: Array<{
      cursor: CompletedHistoryCursor | null | undefined;
      resolve: (page: ReturnType<typeof pageOf>) => void;
    }> = [];
    const olderCursors: Array<CompletedHistoryCursor | null | undefined> = [];
    const pageForCursor = (cursor: CompletedHistoryCursor | null | undefined) => {
      if (cursor?.transactionId === head.id) return pageOf([mid]);
      if (cursor?.transactionId === mid.id) return pageOf([oldest, anchor]);
      return pageOf([tail], false);
    };
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) return pageOf(refreshed ? [head] : [anchor]);
      olderCursors.push(request.cursor);
      return await new Promise(resolve => {
        pending.push({ cursor: request.cursor, resolve });
      });
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);

    await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain('completed-old-anchor'));
    refreshed = true;
    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-inserted-head'));
    await waitFor(() => expect(pending).toHaveLength(1));

    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });
    expect(pending).toHaveLength(1);
    expect(olderCursors).toEqual([cursorFor(head)]);

    const first = pending[0]!;
    await act(async () => {
      first.resolve(pageForCursor(first.cursor));
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-inserted-mid'));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(olderCursors[1]).toEqual(cursorFor(mid));

    const next = pending[1]!;
    await act(async () => {
      next.resolve(pageForCursor(next.cursor));
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-inserted-0000'));
    expect(entryKeys()).toContain('completed-old-anchor');
    expect(entryKeys()).not.toContain('completed-tail-older');
    expect(pending).toHaveLength(2);
  });

  it('displaces mixed-status rows from a full equal-time head by page cursor order', async () => {
    const stamp = 50_000;
    const row = (id: string, status: ITransactionStatus, initiatedAt: number) => ({
      id,
      status,
      displayMessage: id,
      displayIcon: status === STATUS.Failed ? 'FAILED' : 'RECEIVE',
      type: 'send',
      completedAt: stamp,
      initiatedAt
    });
    const previousHead = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) =>
      row(`m-old-${String(index).padStart(2, '0')}`, index === 0 ? STATUS.Failed : STATUS.Completed, index)
    ).sort((left, right) => right.id.localeCompare(left.id));
    const refreshedHead = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) =>
      row(`z-new-${String(index).padStart(2, '0')}`, STATUS.Completed, HISTORY_PAGE_SIZE + index)
    ).sort((left, right) => right.id.localeCompare(left.id));
    const cursorFor = (entry: (typeof previousHead)[number]): CompletedHistoryCursor => ({
      effectiveTimestamp: stamp,
      transactionId: entry.id,
      status: entry.status,
      initiatedAt: entry.initiatedAt
    });
    let refreshed = false;
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (!request.fromEnd) {
        return { transactions: [], rawCount: 0, hasMore: false, nextCursor: null };
      }
      const transactions = refreshed ? refreshedHead : previousHead;
      return {
        transactions,
        rawCount: transactions.length,
        hasMore: true,
        nextCursor: cursorFor(transactions[transactions.length - 1]!)
      };
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);

    await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain('completed-m-old-00'));

    refreshed = true;
    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });

    await waitFor(() => expect(entryKeys()).toContain('completed-z-new-00'));
    expect(entryKeys()).toContain('completed-m-old-00');
  });

  it('orders equal-time failed rows by initiatedAt across head, displaced page, and older rest', async () => {
    const stamp = 40_000;
    const failed = (id: string, initiatedAt: number) => ({
      id,
      status: STATUS.Failed,
      displayMessage: id,
      displayIcon: 'FAILED',
      type: 'send',
      completedAt: stamp,
      initiatedAt
    });
    const row1 = failed('row-a', 1);
    const row2 = failed('row-z', 2);
    const row3 = failed('row-zz', 3);
    const cursorFor = (row: ReturnType<typeof failed>): CompletedHistoryCursor => ({
      effectiveTimestamp: stamp,
      transactionId: row.id,
      status: STATUS.Failed,
      initiatedAt: row.initiatedAt
    });
    let refreshed = false;
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) {
        if (!refreshed) {
          return { transactions: [row2], rawCount: 1, hasMore: true, nextCursor: cursorFor(row2) };
        }
        return { transactions: [row3], rawCount: 1, hasMore: true, nextCursor: cursorFor(row3) };
      }
      return { transactions: [row1], rawCount: 1, hasMore: false, nextCursor: cursorFor(row1) };
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);

    await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain('completed-row-z'));
    await act(async () => {
      await mockHistoryViewProps.loadMore(1);
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-row-a'));
    refreshed = true;
    await act(async () => {
      mockSwrMutates['latest-transactions']?.();
    });
    await waitFor(() => expect(entryKeys()[0]).toBe('completed-row-zz'));

    const equalTimeIds = entryKeys()
      .filter(key => key?.startsWith('completed-row-'))
      .map(key => key?.slice('completed-'.length));
    expect(equalTimeIds).toEqual(['row-zz', 'row-z', 'row-a']);
  });

  it('advances past a full raw page of linked consumes', async () => {
    const latest = {
      id: 'latest',
      status: STATUS.Completed,
      displayMessage: 'latest',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 3000
    };
    const linkedPage = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) => ({
      id: `linked-${index}`,
      status: STATUS.Completed,
      displayMessage: 'linked consume',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 2000 - index
    }));
    const older = {
      id: 'older-visible',
      status: STATUS.Completed,
      displayMessage: 'older visible',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 1000
    };
    const latestCursor = { effectiveTimestamp: latest.completedAt, transactionId: latest.id };
    const linkedCursor = { effectiveTimestamp: 1001, transactionId: 'linked-999' };
    const visibleCursor = { effectiveTimestamp: older.completedAt, transactionId: older.id };
    const pageRequests: Array<{ cursor?: unknown }> = [];

    mockGetCompletedTransactions.mockImplementation(
      async (
        _address: string,
        offset?: number,
        _limit?: number,
        _includeFailed?: boolean,
        _tokenId?: string,
        fromEnd?: boolean
      ) => {
        if (fromEnd) return [latest];
        return offset === HISTORY_PAGE_SIZE ? linkedPage : [older];
      }
    );
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) {
        return { transactions: [latest], rawCount: 1, hasMore: true, nextCursor: latestCursor };
      }
      pageRequests.push({ cursor: request.cursor });
      if (pageRequests.length === 1) {
        return { transactions: linkedPage, rawCount: linkedPage.length, hasMore: true, nextCursor: linkedCursor };
      }
      return { transactions: [older], rawCount: 1, hasMore: false, nextCursor: visibleCursor };
    });
    mockSuppressedLinkedConsumeIds.mockImplementation(
      async (transactions: Array<{ id: string }>) =>
        new Set(transactions.filter(tx => tx.id.startsWith('linked-')).map(tx => tx.id))
    );

    await renderHistory();
    await act(async () => {
      await mockHistoryViewProps.loadMore(1);
    });
    expect(mockHistoryViewProps.hasMore).toBe(true);

    await act(async () => {
      await mockHistoryViewProps.loadMore(2);
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-older-visible'));
    expect(pageRequests[0]?.cursor).toEqual(latestCursor);
    expect(pageRequests[1]?.cursor).toEqual(linkedCursor);
  });

  // `hasMore` has to key off what the PAGE returned, not off the merged list:
  // merged, the list is non-empty from the first successful page onward, so an
  // exhausted history would never stop paging and the scroller — which re-arms
  // on every parent render, and SWR re-renders this on a timer — would fire an
  // endless run of empty queries.
  it('keeps paging while a page comes back full', async () => {
    const latest = {
      id: 'LATEST',
      status: STATUS.Completed,
      displayMessage: 'latest transaction',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 20_000
    };
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `OLD${i}`,
      status: STATUS.Completed,
      displayMessage: 'older tx',
      displayIcon: 'RECEIVE',
      faucetId: undefined,
      type: 'consume',
      amount: undefined,
      completedAt: 10_000 - i
    }));
    mockGetUncompletedTransactions.mockResolvedValue([]);
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined ? [latest] : fullPage
    );
    await renderHistory();

    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });

    expect(mockHistoryViewProps.hasMore).toBe(true);
  });

  it('loadMore is re-entrancy guarded while a previous page is in flight', async () => {
    let releaseInFlight: (v: unknown[]) => void = () => {};
    const latest = {
      id: 'LATEST',
      status: STATUS.Completed,
      displayMessage: 'latest transaction',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 20_000
    };
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) => {
      if (offset === undefined) return [latest];
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
    const latest = {
      id: 'LATEST',
      status: STATUS.Completed,
      displayMessage: 'latest transaction',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 20_000
    };
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) => {
      if (offset === undefined) return [latest];
      throw new Error('dexie-down');
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);
    await renderHistory();

    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load history before'),
      expect.any(Error)
    );
    await waitFor(() => expect(mockHistoryViewProps.hasMore).toBe(false));

    const readsAfterFailure = mockGetCompletedTransactions.mock.calls.length;
    await act(async () => {
      await mockHistoryViewProps.loadMore(1);
    });
    expect(mockGetCompletedTransactions).toHaveBeenCalledTimes(readsAfterFailure);

    consoleErrorSpy.mockRestore();
  });

  // Paging state belongs to the account and token scope, so a failure must not
  // disable pagination for a different scope in the same mount.
  it('re-enables paging after a failed page when the scope changes', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const latest = {
      id: 'LATEST',
      status: STATUS.Completed,
      displayMessage: 'latest transaction',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 20_000
    };
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) => {
      if (offset === undefined) return [latest];
      throw new Error('dexie-down');
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);
    const { rerender } = await renderHistory({ tokenId: 'tok-a' });

    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });
    await waitFor(() => expect(mockHistoryViewProps.hasMore).toBe(false));

    await act(async () => {
      rerender(<History address="0xme" tokenId="tok-b" />);
    });
    await waitFor(() => expect(mockHistoryViewProps.hasMore).toBe(true));

    consoleErrorSpy.mockRestore();
  });

  // `useSafeState`'s setter only checks that the component is still MOUNTED, not
  // that its key still matches, so a page in flight across an account switch
  // would otherwise merge one account's history into another's list.
  it('discards a page that resolves after the scope changed', async () => {
    let releasePage: (rows: unknown[]) => void = () => {};
    const latest = {
      id: 'LATEST',
      status: STATUS.Completed,
      displayMessage: 'latest transaction',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 20_000
    };
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) => {
      if (offset === undefined) return [latest];
      return new Promise(resolve => {
        releasePage = resolve;
      });
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);
    const { rerender } = await renderHistory({ tokenId: 'tok-a' });

    let pageDone: Promise<void> = Promise.resolve();
    await act(async () => {
      pageDone = mockHistoryViewProps.loadMore(0);
    });

    await act(async () => {
      rerender(<History address="0xme" tokenId="tok-b" />);
    });

    await act(async () => {
      releasePage([
        {
          id: 'FROM-A',
          status: STATUS.Completed,
          displayMessage: 'token A row',
          displayIcon: 'RECEIVE',
          type: 'consume',
          completedAt: 10
        }
      ]);
      await pageDone;
    });

    expect(entryKeys()).not.toContain('completed-FROM-A');
  });

  it('discards a loadMore page that resolves after settled history stops running', async () => {
    const head = {
      id: 'VISIBLE-HEAD',
      status: STATUS.Completed,
      displayMessage: 'head',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 2000,
      initiatedAt: 2000
    };
    const older = { ...head, id: 'OFFSCREEN-OLDER', completedAt: 1000, initiatedAt: 1000 };
    const cursorFor = (row: typeof head): CompletedHistoryCursor => ({
      effectiveTimestamp: row.completedAt,
      transactionId: row.id
    });
    let releasePage: (page: unknown) => void = () => {};
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) {
        return { transactions: [head], rawCount: 1, hasMore: true, nextCursor: cursorFor(head) };
      }
      return await new Promise(resolve => {
        releasePage = resolve;
      });
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);
    const view = (onScreen: boolean) => (
      <PageActiveContext.Provider value={onScreen}>
        <History address="0xme" />
      </PageActiveContext.Provider>
    );
    let utils: ReturnType<typeof render> | undefined;
    await act(async () => {
      utils = render(view(true));
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-VISIBLE-HEAD'));

    let pageDone: Promise<void> = Promise.resolve();
    await act(async () => {
      pageDone = mockHistoryViewProps.loadMore(0);
    });
    await act(async () => {
      utils?.rerender(view(false));
    });
    await act(async () => {
      releasePage({ transactions: [older], rawCount: 1, hasMore: false, nextCursor: cursorFor(older) });
      await pageDone;
    });

    expect(entryKeys()).toEqual(['completed-VISIBLE-HEAD']);
  });

  it.each(['offscreen', 'pending', 'unmounted'] as const)(
    'stops a gap traversal when History is %s',
    async transition => {
      const row = (id: string, timestamp: number) => ({
        id,
        status: STATUS.Completed,
        displayMessage: id,
        displayIcon: 'RECEIVE',
        type: 'consume',
        completedAt: timestamp,
        initiatedAt: timestamp
      });
      const anchor = row('GAP-ANCHOR', 1000);
      const head = row('GAP-HEAD', 3000);
      const middle = row('GAP-MIDDLE', 2000);
      const cursorFor = (entry: ReturnType<typeof row>): CompletedHistoryCursor => ({
        effectiveTimestamp: entry.completedAt,
        transactionId: entry.id
      });
      let refreshed = false;
      let releaseFirstPage: (page: unknown) => void = () => {};
      const olderRequests: Array<CompletedHistoryCursor | null | undefined> = [];
      mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
        if (request.fromEnd) {
          const transactions = refreshed ? [head] : [anchor];
          return {
            transactions,
            rawCount: transactions.length,
            hasMore: true,
            nextCursor: cursorFor(transactions[0]!)
          };
        }
        olderRequests.push(request.cursor);
        if (olderRequests.length === 1) {
          return await new Promise(resolve => {
            releaseFirstPage = resolve;
          });
        }
        return { transactions: [anchor], rawCount: 1, hasMore: false, nextCursor: cursorFor(anchor) };
      });
      mockGetUncompletedTransactions.mockResolvedValue([]);
      const view = (onScreen: boolean, filter: string) => (
        <PageActiveContext.Provider value={onScreen}>
          <History address="0xme" filter={filter as any} />
        </PageActiveContext.Provider>
      );
      let utils: ReturnType<typeof render> | undefined;
      await act(async () => {
        utils = render(view(true, 'all'));
      });
      await waitFor(() => expect(entryKeys()).toContain('completed-GAP-ANCHOR'));

      refreshed = true;
      await act(async () => mockHistoryViewProps.onRetry());
      await waitFor(() => expect(olderRequests).toHaveLength(1));

      if (transition === 'unmounted') {
        await act(async () => utils?.unmount());
      } else {
        await act(async () =>
          utils?.rerender(view(transition === 'offscreen' ? false : true, transition === 'pending' ? 'pending' : 'all'))
        );
      }
      await act(async () => {
        releaseFirstPage({ transactions: [middle], rawCount: 1, hasMore: true, nextCursor: cursorFor(middle) });
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      expect(olderRequests).toHaveLength(1);
    }
  );

  it('finishes the active gap page before starting work from a refreshed cursor', async () => {
    const row = (id: string, timestamp: number) => ({
      id,
      status: STATUS.Completed,
      displayMessage: id,
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: timestamp,
      initiatedAt: timestamp
    });
    const anchor = row('CURSOR-ANCHOR', 1000);
    const firstHead = row('CURSOR-HEAD-1', 3000);
    const refreshedHead = row('CURSOR-HEAD-2', 4000);
    const middle = row('CURSOR-MIDDLE', 2000);
    const cursorFor = (entry: ReturnType<typeof row>): CompletedHistoryCursor => ({
      effectiveTimestamp: entry.completedAt,
      transactionId: entry.id
    });
    let latestHead = anchor;
    let releaseFirstPage: (page: unknown) => void = () => {};
    const olderRequests: Array<CompletedHistoryCursor | null | undefined> = [];
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) {
        return { transactions: [latestHead], rawCount: 1, hasMore: true, nextCursor: cursorFor(latestHead) };
      }
      olderRequests.push(request.cursor);
      if (olderRequests.length === 1) {
        return await new Promise(resolve => {
          releaseFirstPage = resolve;
        });
      }
      return { transactions: [anchor], rawCount: 1, hasMore: false, nextCursor: cursorFor(anchor) };
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);

    try {
      await renderHistory();
      await waitFor(() => expect(entryKeys()).toContain('completed-CURSOR-ANCHOR'));

      latestHead = firstHead;
      await act(async () => mockSwrMutates['latest-transactions']?.());
      await waitFor(() => expect(olderRequests).toHaveLength(1));
      expect(olderRequests).toEqual([cursorFor(firstHead)]);

      latestHead = refreshedHead;
      await act(async () => mockSwrMutates['latest-transactions']?.());
      await waitFor(() => expect(entryKeys()).toContain('completed-CURSOR-HEAD-2'));
      expect(olderRequests).toEqual([cursorFor(firstHead)]);

      await act(async () => {
        releaseFirstPage({ transactions: [middle], rawCount: 1, hasMore: true, nextCursor: cursorFor(middle) });
      });
      await waitFor(() => expect(olderRequests).toHaveLength(2));
      expect(olderRequests).toEqual([cursorFor(firstHead), cursorFor(refreshedHead)]);
      expect(entryKeys()).not.toContain('completed-CURSOR-MIDDLE');
    } finally {
      await act(async () => {
        releaseFirstPage({ transactions: [anchor], rawCount: 1, hasMore: false, nextCursor: cursorFor(anchor) });
      });
    }
  });

  it("never shows the last scope's older pages after a switch, nor merges them into the new scope's", async () => {
    const row = (id: string) => ({
      id,
      status: STATUS.Completed,
      displayMessage: id,
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 10
    });
    const cursorFor = (entry: ReturnType<typeof row>): CompletedHistoryCursor => ({
      effectiveTimestamp: entry.completedAt,
      transactionId: entry.id
    });
    const olderAccountReads: string[] = [];
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      const latest = row(request.accountId === '0xme' ? 'LATEST-ME' : 'LATEST-OTHER');
      if (request.fromEnd) {
        return { transactions: [latest], rawCount: 1, hasMore: true, nextCursor: cursorFor(latest) };
      }
      olderAccountReads.push(request.accountId);
      const older = row(request.accountId === '0xme' ? 'OLD-PAGE' : 'NEW-PAGE');
      return { transactions: [older], rawCount: 1, hasMore: false, nextCursor: cursorFor(older) };
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);
    const { rerender } = await renderHistory();

    await waitFor(() => expect(entryKeys()).toContain('completed-LATEST-ME'));
    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });
    expect(entryKeys()).toContain('completed-OLD-PAGE');

    mockHistoryViewCalls = [];
    await act(async () => {
      rerender(<History address="0xother" />);
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-LATEST-OTHER'));

    expect(mockHistoryViewCalls.length).toBeGreaterThan(0);
    for (const props of mockHistoryViewCalls) {
      expect(props.entries.map((e: any) => e.key)).not.toContain('completed-OLD-PAGE');
    }

    await act(async () => {
      await mockHistoryViewProps.loadMore(0);
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-NEW-PAGE'));
    expect(olderAccountReads).toEqual(['0xme', '0xother']);
    expect(entryKeys()).not.toContain('completed-OLD-PAGE');
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

    expect(mockGetCompletedTransactions).toHaveBeenCalledWith('0xme', undefined, 1000, true, 'tok-9', true);
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
                  intentOwner: '0xold-owner',
                  midenNoteId: '0xold-note',
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
      bridgeInEvmTxHash: '0xebd',
      bridgeInSourceAddress: '0xold-owner',
      bridgeInMidenNoteId: '0xold-note'
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

  it('drops a failed claim row the superseded lookup names (#771)', async () => {
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined
        ? [
            {
              id: 'CLAIMED',
              status: STATUS.Completed,
              displayMessage: 'Received',
              displayIcon: 'RECEIVE',
              faucetId: 'fa1',
              type: 'consume',
              amount: 4n,
              noteId: 'n1',
              noteIds: ['n1'],
              completedAt: 5000
            },
            {
              id: 'ATTEMPT',
              status: STATUS.Failed,
              displayMessage: 'Failed',
              displayIcon: 'FAILED',
              faucetId: 'fa1',
              type: 'consume',
              noteId: 'n1',
              completedAt: 4000
            }
          ]
        : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([]);
    mockSupersededFailedConsumeIds.mockResolvedValue(new Set(['ATTEMPT']));

    await renderHistory();
    await waitFor(() => expect(entryKeys()).toContain('completed-CLAIMED'));

    expect(entryKeys()).not.toContain('completed-ATTEMPT');
  });
});

describe('History Agglayer destination plumbing', () => {
  it('keeps the saved EVM route on completed and pending entries', async () => {
    const agglayerRoute = {
      chainId: 1,
      contractAddress: '0x0000000000000000000000000000000000000001',
      midenBridgeId: '0xbridge',
      indexerUrl: 'https://indexer.example',
      rollupId: 1,
      evmNetworkId: 0
    };
    const extraInputs = { provider: 'agglayer', destinationNetwork: 0, agglayerRoute };
    mockGetCompletedTransactions.mockImplementation(async (_address: string, offset?: number) =>
      offset === undefined
        ? [
            {
              id: 'AGG-COMPLETE',
              status: STATUS.Completed,
              type: 'bridged-send',
              completedAt: 3000,
              extraInputs
            }
          ]
        : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([
      {
        id: 'AGG-PENDING',
        status: STATUS.GeneratingTransaction,
        type: 'bridged-send',
        initiatedAt: 1000,
        extraInputs
      }
    ]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(2));
    expect(mockHistoryViewProps.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'completed-AGG-COMPLETE', bridgeAgglayerRoute: agglayerRoute }),
        expect.objectContaining({ key: 'pending-AGG-PENDING', bridgeAgglayerRoute: agglayerRoute })
      ])
    );
  });
});

describe('History USDCx entry plumbing', () => {
  it('threads burn and bridged-receive state onto completed and pending entries', async () => {
    const completedBurn = {
      noteId: 'completed-burn-note',
      destinationDomain: 0,
      phase: 'confirmed',
      destinationBalanceConfirmed: { balance: '1000000', blockNumber: '42' }
    } as const;
    const pendingBurn = {
      noteId: 'pending-burn-note',
      destinationDomain: 0,
      phase: 'pending'
    } as const;
    const cctp = { sourceDomain: 6, executeTxHash: '0xexecute', forwardState: 'COMPLETE' } as const;

    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) =>
      offset === undefined
        ? [
            {
              id: 'COMPLETED-BURN',
              status: STATUS.Completed,
              displayMessage: 'Burning',
              displayIcon: 'SEND',
              type: 'bridged-send',
              completedAt: 3000,
              extraInputs: {
                provider: 'usdcx',
                destinationAddress: '0xdestination',
                destinationNetwork: 11155111,
                sourceFaucetId: 'usdcx-faucet',
                claimStatus: 'not-applicable',
                usdcxBurn: completedBurn
              }
            },
            {
              id: 'USDCX-RECEIVE',
              status: STATUS.Completed,
              displayMessage: 'Received',
              displayIcon: 'RECEIVE',
              type: 'bridged-receive',
              completedAt: 2000,
              extraInputs: {
                provider: 'usdcx',
                sourceAddress: '0xsource',
                sourceChainId: 84532,
                sourceAmount: '10',
                sourceSymbol: 'USDC',
                evmTxHash: '0xdeposit',
                phase: 'received',
                cctp,
                outputAmount: '10',
                outputSymbol: 'USDCx',
                midenNoteId: 'received-note'
              }
            }
          ]
        : []
    );
    mockGetUncompletedTransactions.mockResolvedValue([
      {
        id: 'PENDING-BURN',
        status: STATUS.GeneratingTransaction,
        displayMessage: 'Burning',
        type: 'bridged-send',
        initiatedAt: 1000,
        extraInputs: {
          provider: 'usdcx',
          destinationAddress: '0xdestination',
          destinationNetwork: 11155111,
          sourceFaucetId: 'usdcx-faucet',
          claimStatus: 'not-applicable',
          usdcxBurn: pendingBurn
        }
      }
    ]);

    await renderHistory();
    await waitFor(() => expect(mockHistoryViewProps.entries).toHaveLength(3));

    const entry = (key: string) =>
      mockHistoryViewProps.entries.find((candidate: { key: string }) => candidate.key === key);
    expect(entry('completed-COMPLETED-BURN').usdcxBurn).toEqual(completedBurn);
    expect(entry('pending-PENDING-BURN').usdcxBurn).toEqual(pendingBurn);
    expect(entry('completed-USDCX-RECEIVE')).toMatchObject({
      bridgeInProvider: 'usdcx',
      bridgeInSourceChainId: 84532,
      bridgeInCctp: cctp,
      bridgeInPhase: 'received'
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

    // Assert the ROW reached the resolver, not just its id: the mock keys off
    // `tx.id`, so an `objectContaining({ id })` check passes even when the
    // caller strips the very field the resolver needs.
    expect(mockResolveConsumeExtraAmounts).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'CLAIM', assetTotals: claimRow.assetTotals })
    );
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

it('suppresses a consume row represented by its claiming note, but retains a batch with other notes', async () => {
  mockGetCompletedTransactions.mockResolvedValue([]);
  mockGetUncompletedTransactions.mockResolvedValue([
    { id: 'single', status: STATUS.Queued, type: 'consume', noteIds: ['note-one'], initiatedAt: 500 },
    { id: 'batch', status: STATUS.Queued, type: 'consume', noteIds: ['note-one', 'note-two'], initiatedAt: 600 }
  ]);
  const item: PendingActivityItem = {
    note: {
      id: 'note-one',
      faucetId: 'fa1',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: true,
      type: 'unknown',
      metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
    },
    status: 'claiming'
  };
  await renderHistory({ pendingItems: [item] });
  expect(entryKeys()).not.toContain('pending-single');
  expect(entryKeys()).toHaveLength(1);
  expect(mockHistoryViewProps.entries[0].txId).toBe('batch');
});

it('suppresses a legacy single-note consume row behind a CLAIMING card, keeps rows no card represents, and keeps only in-flight rows under Pending', async () => {
  mockGetCompletedTransactions.mockResolvedValue([
    {
      id: 'legacy',
      status: STATUS.Completed,
      displayMessage: 'Received',
      displayIcon: 'RECEIVE',
      type: 'consume',
      noteId: 'note-claimed',
      completedAt: 700
    },
    {
      id: 'no-notes',
      status: STATUS.Completed,
      displayMessage: 'Received',
      displayIcon: 'RECEIVE',
      type: 'consume',
      completedAt: 650
    }
  ]);
  mockGetUncompletedTransactions.mockResolvedValue([
    {
      id: 'queued-legacy',
      status: STATUS.Queued,
      displayMessage: '',
      type: 'consume',
      noteId: 'note-claimed',
      initiatedAt: 800
    },
    {
      id: 'queued-send',
      status: STATUS.Queued,
      displayMessage: '',
      faucetId: 'fa1',
      type: 'send',
      amount: 10n,
      initiatedAt: 900
    }
  ]);
  const claimed: PendingActivityItem = {
    note: {
      id: 'note-claimed',
      faucetId: 'fa1',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: 'unknown',
      metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
    },
    // `claiming`, not `claimed`: an ACCEPTED transfer has no card any more, so its consume row is
    // exactly what the feed must show. A claim still in flight is the case a card stands in for.
    status: 'claiming',
    txId: 'legacy'
  };
  const { rerender } = await renderHistory({ pendingItems: [claimed] });
  await waitFor(() =>
    expect(entryKeys()).toEqual(expect.arrayContaining(['pending-queued-send', 'completed-no-notes']))
  );
  expect(new Set(entryKeys())).toEqual(new Set(['pending-queued-send', 'completed-no-notes']));

  await act(async () => {
    rerender(<History address="0xme" pendingItems={[claimed]} filter="pending" />);
  });
  expect(entryKeys()).toEqual(['pending-queued-send']);
});

it('lists in-flight transactions under Pending beside the note cards, and no settled row', async () => {
  const note: PendingActivityItem = {
    note: {
      id: 'incoming',
      faucetId: 'fa1',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: 'unknown',
      metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
    },
    status: 'pending'
  };
  // Settled rows are held first, so choosing Pending has some to drop.
  const { rerender } = await renderHistory({ filter: 'all', pendingItems: [note] });
  await waitFor(() => expect(entryKeys()).toContain('completed-S'));

  await act(async () => {
    rerender(<History address="0xme" filter="pending" pendingItems={[note]} />);
  });
  // Queued and generating rows (a send, a swap, a consume) stay; completed, failed and cancelled rows do not.
  expect(entryKeys()).toEqual(['pending-PQ', 'pending-PP', 'pending-undefined']);
  expect(mockHistoryViewProps.pendingItems).toEqual([note]);
});

it('keeps Pending loading while the in-flight read has not answered', async () => {
  mockGetUncompletedTransactions.mockImplementation(() => new Promise(() => {}));
  await renderHistory({ filter: 'pending', pendingItems: [] });
  await act(async () => undefined);
  expect(mockHistoryViewProps.initialLoading).toBe(true);
});

it('shows a load error under Pending when the in-flight read fails', async () => {
  mockGetUncompletedTransactions.mockRejectedValue(new Error('db down'));
  await renderHistory({ filter: 'pending', pendingItems: [] });
  await waitFor(() => expect(mockHistoryViewProps.loadError).toBe(true));
});

it('hides the consume row of every represented claim while drawing only the cards it is told to', async () => {
  mockGetCompletedTransactions.mockResolvedValue([]);
  mockGetUncompletedTransactions.mockResolvedValue([
    { id: 'single', status: STATUS.Queued, type: 'consume', noteIds: ['note-one'], initiatedAt: 500 }
  ]);
  const item: PendingActivityItem = {
    note: {
      id: 'note-one',
      faucetId: 'fa1',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: 'unknown',
      metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
    },
    status: 'claiming'
  };
  await renderHistory({ pendingItems: [item], drawnPendingItems: [] });
  expect(entryKeys()).toEqual([]);
  expect(mockHistoryViewProps.pendingItems).toEqual([]);
});

it('shows the consume row of an ACCEPTED transfer: the card it used to hide behind is gone', async () => {
  mockGetCompletedTransactions.mockResolvedValue([
    {
      id: 'accepted',
      status: STATUS.Completed,
      displayMessage: 'Received',
      displayIcon: 'RECEIVE',
      type: 'consume',
      noteIds: ['note-accepted'],
      completedAt: 700
    }
  ]);
  mockGetUncompletedTransactions.mockResolvedValue([]);
  const accepted: PendingActivityItem = {
    note: {
      id: 'note-accepted',
      faucetId: 'fa1',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: 'unknown',
      metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
    },
    status: 'claimed',
    txId: 'accepted'
  };

  await renderHistory({ pendingItems: [accepted] });
  // Standing it down would leave the transaction with nothing on screen at all: the card has no
  // accepted state any more, so the row IS the accepted transfer.
  await waitFor(() => expect(entryKeys()).toEqual(['completed-accepted']));
});

it('hides a failed consume row while its failed card offers the retry, and shows it again once no card does', async () => {
  mockGetCompletedTransactions.mockResolvedValue([
    {
      id: 'failed-claim',
      status: STATUS.Failed,
      displayMessage: 'Failed',
      displayIcon: 'FAILED',
      type: 'consume',
      noteIds: ['note-failed'],
      completedAt: 700
    }
  ]);
  mockGetUncompletedTransactions.mockResolvedValue([]);
  const failed: PendingActivityItem = {
    note: {
      id: 'note-failed',
      faucetId: 'fa1',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: 'unknown',
      metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
    },
    status: 'failed',
    txId: 'failed-claim'
  };
  const { rerender } = await renderHistory({ pendingItems: [], filter: 'transfer' });
  await waitFor(() => expect(entryKeys()).toEqual(['completed-failed-claim']));

  await act(async () => {
    rerender(<History address="0xme" pendingItems={[failed]} filter="transfer" />);
  });
  expect(entryKeys()).toEqual([]);
  await act(async () => {
    rerender(<History address="0xme" pendingItems={[failed]} />);
  });
  expect(entryKeys()).toEqual([]);
  await act(async () => {
    rerender(<History address="0xme" pendingItems={[]} />);
  });
  expect(entryKeys()).toEqual(['completed-failed-claim']);
});

// [settled history, in-flight transactions]: whether each read holds a key, and so is subscribed and running.
const readsRunning = () => mockUseRetryableSWR.mock.calls.slice(-2).map(call => call[0] !== null);

it('stops paging and reading settled history under Pending but keeps reading in-flight transactions', async () => {
  const { rerender } = await renderHistory({ filter: 'pending' });
  await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
  expect(mockHistoryViewProps.hasMore).toBe(false);
  expect(readsRunning()).toEqual([false, true]);

  await act(async () => {
    rerender(<History address="0xme" filter="all" />);
  });
  await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
  expect(mockHistoryViewProps.hasMore).toBe(true);
  expect(readsRunning()).toEqual([true, true]);
});

it('stops both transaction reads while the page is off screen and reads them when it returns', async () => {
  const view = (onScreen: boolean) => (
    <PageActiveContext.Provider value={onScreen}>
      <History address="0xme" />
    </PageActiveContext.Provider>
  );
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(view(false));
  });
  await waitFor(() => expect(screen.getByTestId('history-view')).toBeTruthy());
  expect(readsRunning()).toEqual([false, false]);
  expect(mockGetCompletedTransactions).not.toHaveBeenCalled();
  expect(mockGetUncompletedTransactions).not.toHaveBeenCalled();

  await act(async () => {
    utils?.rerender(view(true));
  });
  expect(readsRunning()).toEqual([true, true]);
  await waitFor(() => expect(mockGetCompletedTransactions).toHaveBeenCalled());
  expect(mockGetUncompletedTransactions).toHaveBeenCalled();
  await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
});

it('refreshes each transaction read whenever it resumes, and only then', async () => {
  const view = (onScreen: boolean, filter: 'pending' | 'all') => (
    <PageActiveContext.Provider value={onScreen}>
      <History address="0xme" filter={filter} />
    </PageActiveContext.Provider>
  );
  const fetches = () => [
    mockGetCompletedTransactions.mock.calls.filter(call => call[1] === undefined).length,
    mockGetUncompletedTransactions.mock.calls.length
  ];
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(view(true, 'pending'));
  });
  await waitFor(() => expect(fetches()).toEqual([0, 1]));

  // Off screen: nothing is read.
  await act(async () => {
    utils?.rerender(view(false, 'pending'));
  });
  expect(fetches()).toEqual([0, 1]);

  // Back on screen with Pending still selected: only the in-flight read runs again.
  await act(async () => {
    utils?.rerender(view(true, 'pending'));
  });
  await waitFor(() => expect(fetches()).toEqual([0, 2]));
  await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));

  // Leaving Pending starts the settled-history read at once rather than on its next interval.
  await act(async () => {
    utils?.rerender(view(true, 'all'));
  });
  await waitFor(() => expect(fetches()).toEqual([1, 2]));
  await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
});

it('keeps showing its rows while its page is off screen', async () => {
  const view = (onScreen: boolean) => (
    <PageActiveContext.Provider value={onScreen}>
      <History address="0xme" />
    </PageActiveContext.Provider>
  );
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(view(true));
  });
  await waitFor(() => expect(entryKeys()).toContain('completed-S'));
  const shown = entryKeys();

  await act(async () => {
    utils?.rerender(view(false));
  });
  expect(entryKeys()).toEqual(shown);
});

it('takes the loading state under Pending from the in-flight read alone', async () => {
  // A read that never settles keeps reporting loading, as a needed read that has not answered does.
  mockGetCompletedTransactions.mockImplementation(() => new Promise(() => {}));
  const { rerender } = await renderHistory({ filter: 'pending', pendingItems: [] });
  await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));

  await act(async () => {
    rerender(<History address="0xme" filter="all" pendingItems={[]} />);
  });
  expect(mockHistoryViewProps.initialLoading).toBe(true);
});

it('offers no more pages while its page is off screen', async () => {
  const view = (onScreen: boolean) => (
    <PageActiveContext.Provider value={onScreen}>
      <History address="0xme" />
    </PageActiveContext.Provider>
  );
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(view(false));
  });
  await waitFor(() => expect(screen.getByTestId('history-view')).toBeTruthy());
  expect(mockHistoryViewProps.hasMore).toBe(false);

  await act(async () => {
    utils?.rerender(view(true));
  });
  await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
  expect(mockHistoryViewProps.hasMore).toBe(true);
});

describe('History narrowed and re-rendered by its caller', () => {
  it('narrows the filtered, searched list by `predicate`', async () => {
    // "transfer" leaves the send and receive rows; the predicate keeps one of them.
    await renderHistory({ filter: 'transfer', predicate: (entry: any) => entry.secondaryAddress === '0xEEE' });

    expect(entryKeys()).toEqual(['completed-SD']);
  });

  it('narrows the list without touching what was loaded, so paging is unchanged', async () => {
    await renderHistory({ predicate: () => false });

    expect(entryKeys()).toEqual([]);
    expect(mockHistoryViewProps.hasMore).toBe(true);
  });

  it('hands `renderEntries` the same entries and paging state instead of the timeline', async () => {
    let seen: any;
    await act(async () => {
      render(
        <History
          address="0xme"
          renderEntries={(view: any) => {
            seen = view;
            return <div data-testid="custom-view" data-count={String(view.entries.length)} />;
          }}
        />
      );
    });
    await waitFor(() => expect(seen.entries.length).toBeGreaterThan(0));

    // The timeline is not rendered at all; the caller's own view is.
    expect(screen.queryByTestId('history-view')).toBeNull();
    expect(screen.getByTestId('custom-view')).toBeTruthy();
    expect(seen.hasMore).toBe(true);
    expect(seen.initialLoading).toBe(false);
    expect(typeof seen.loadMore).toBe('function');
  });

  it('lets that view page the list the same way the timeline does', async () => {
    let seen: any;
    await act(async () => {
      render(
        <History
          address="0xme"
          renderEntries={(view: any) => {
            seen = view;
            return <div data-testid="custom-view" />;
          }}
        />
      );
    });
    await waitFor(() => expect(seen.entries.length).toBeGreaterThan(0));

    await act(async () => {
      await seen.loadMore(1);
    });

    expect(mockGetCompletedTransactions).toHaveBeenCalledWith(
      '0xme',
      expect.any(Number),
      expect.any(Number),
      true,
      undefined
    );
  });
});

// The real lib/swr, whose shared cache and routing the mock above cannot model.
describe('History on the real SWR cache', () => {
  beforeEach(() => {
    mockRealSwr = true;
  });

  const inCache = (ui: React.ReactElement) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>
  );
  const page = (onScreen: boolean, props: Record<string, unknown> = {}) => (
    <PageActiveContext.Provider value={onScreen}>
      <History address="0xme" {...(props as any)} />
    </PageActiveContext.Provider>
  );
  const visibleView = () => mockHistoryViewCalls.filter(props => props.fullHistory).at(-1);

  it('refreshes mutable bridge and Earn status on older loaded rows', async () => {
    await Repo.transactions.clear();
    const head: ITransaction = {
      id: 'STATUS-HEAD',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'consume',
      initiatedAt: 5000,
      completedAt: 5000,
      displayIcon: 'RECEIVE'
    };
    const oldRows = [
      {
        id: 'STATUS-BRIDGE-SEND',
        type: 'bridged-send',
        extraInputs: { provider: 'agglayer', claimStatus: 'pending' }
      },
      {
        id: 'STATUS-BRIDGE-RECEIVE',
        type: 'bridged-receive',
        extraInputs: { provider: 'epoch', phase: 'delivering' }
      },
      {
        id: 'STATUS-EARN-DEPOSIT',
        type: 'earn-deposit',
        extraInputs: { evmRecipient: '0xrecipient', marketUid: 'market', sourceFaucetId: 'fa1', epochStatus: 'pending' }
      },
      {
        id: 'STATUS-EARN-WITHDRAW',
        type: 'earn-withdraw',
        extraInputs: {
          evmOwner: '0xowner',
          marketUid: 'market',
          destinationFaucetId: 'fa1',
          sourceAmount: '1',
          sourceSymbol: 'USDC',
          phase: 'redeeming'
        }
      }
    ].map((row, index) => ({
      ...row,
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      displayMessage: row.id,
      displayIcon: 'RECEIVE',
      initiatedAt: 4000 - index * 100,
      completedAt: 4000 - index * 100
    })) as ITransaction[];
    const cursorFor = (tx: ITransaction): CompletedHistoryCursor => ({
      effectiveTimestamp: tx.completedAt ?? tx.initiatedAt ?? 0,
      transactionId: tx.id,
      status: tx.status,
      initiatedAt: tx.initiatedAt
    });
    await Repo.transactions.bulkPut(oldRows);
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) =>
      request.fromEnd
        ? {
            transactions: [head],
            rawCount: 1,
            hasMore: true,
            nextCursor: cursorFor(head)
          }
        : {
            transactions: oldRows,
            rawCount: oldRows.length,
            hasMore: false,
            nextCursor: cursorFor(oldRows[oldRows.length - 1]!)
          }
    );
    mockGetUncompletedTransactions.mockResolvedValue([]);

    try {
      await act(async () => render(inCache(page(true, { fullHistory: true }))));
      await waitFor(() => expect(visibleView()?.entries).toHaveLength(1));
      await act(async () => visibleView().loadMore(0));
      const entryFor = (id: string) => visibleView().entries.find((entry: any) => entry.txId === id);
      await waitFor(() => expect(entryFor('STATUS-EARN-WITHDRAW')?.earnWithdrawPhase).toBe('redeeming'));
      expect(entryFor('STATUS-BRIDGE-SEND')?.bridgeClaimStatus).toBe('pending');
      expect(entryFor('STATUS-BRIDGE-RECEIVE')?.bridgeInPhase).toBe('delivering');
      expect(entryFor('STATUS-EARN-DEPOSIT')?.earnDepositStatus).toBe('pending');

      const refreshedRows = oldRows.map(tx => {
        const extraInputs = { ...(tx.extraInputs as Record<string, unknown>) };
        if (tx.id === 'STATUS-BRIDGE-SEND') extraInputs.claimStatus = 'claimed';
        if (tx.id === 'STATUS-BRIDGE-RECEIVE') extraInputs.phase = 'received';
        if (tx.id === 'STATUS-EARN-DEPOSIT') extraInputs.epochStatus = 'confirmed';
        if (tx.id === 'STATUS-EARN-WITHDRAW') extraInputs.phase = 'received';
        return { ...tx, extraInputs } as ITransaction;
      });
      await Repo.transactions.bulkPut(refreshedRows);
      await pastDedupe();
      await act(async () => visibleView().onRetry());

      await waitFor(() => expect(entryFor('STATUS-BRIDGE-SEND')?.bridgeClaimStatus).toBe('claimed'));
      expect(entryFor('STATUS-BRIDGE-RECEIVE')?.bridgeInPhase).toBe('received');
      expect(entryFor('STATUS-EARN-DEPOSIT')?.earnDepositStatus).toBe('confirmed');
      expect(entryFor('STATUS-EARN-WITHDRAW')?.earnWithdrawPhase).toBe('received');
    } finally {
      await Repo.transactions.clear();
    }
  }, 15_000);

  it('refreshes an older Unconfirmed row when reconciliation proves it never committed', async () => {
    await Repo.transactions.clear();
    const head: ITransaction = {
      id: 'UNCONFIRMED-HEAD',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'consume',
      initiatedAt: 5000,
      completedAt: 5000,
      displayIcon: 'RECEIVE'
    };
    const older: ITransaction = {
      id: 'OLDER-UNCONFIRMED',
      accountId: '0xme',
      status: ITransactionStatus.Unconfirmed,
      type: 'send',
      initiatedAt: 4000,
      completedAt: 4000,
      displayMessage: 'Not confirmed',
      displayIcon: 'SEND',
      submitEvidence: [{ attemptId: 'attempt-1', capturedAt: 4000, source: 'stage' }]
    };
    const cursorFor = (tx: ITransaction): CompletedHistoryCursor => ({
      effectiveTimestamp: tx.completedAt ?? tx.initiatedAt ?? 0,
      transactionId: tx.id,
      status: tx.status,
      initiatedAt: tx.initiatedAt
    });
    await Repo.transactions.put(older);
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) =>
      request.fromEnd
        ? { transactions: [head], rawCount: 1, hasMore: true, nextCursor: cursorFor(head) }
        : { transactions: [older], rawCount: 1, hasMore: false, nextCursor: cursorFor(older) }
    );
    mockGetUncompletedTransactions.mockResolvedValue([]);

    try {
      await act(async () => render(inCache(page(true, { fullHistory: true }))));
      await waitFor(() => expect(visibleView()?.entries).toHaveLength(1));
      await act(async () => visibleView().loadMore(0));
      const entryFor = (id: string) => visibleView().entries.find((entry: any) => entry.txId === id);
      await waitFor(() => expect(entryFor(older.id)?.isUnconfirmed).toBe(true));
      expect(entryFor(older.id)?.status).toBe(ITransactionStatus.Unconfirmed);

      await Repo.transactions.put({
        ...older,
        status: ITransactionStatus.Failed,
        error: TRANSACTION_NEVER_COMMITTED_ERROR,
        rawError: 'node verdict: never committed',
        displayMessage: 'Failed',
        displayIcon: 'FAILED',
        neverCommittedAt: 6000
      });
      await pastDedupe();
      await act(async () => visibleView().onRetry());

      await waitFor(() => expect(entryFor(older.id)?.status).toBe(ITransactionStatus.Failed));
      expect(entryFor(older.id)?.message).toBe('Transaction failed');
      expect(entryFor(older.id)?.transactionIcon).toBe('FAILED');
      expect(entryFor(older.id)?.isUnconfirmed).toBe(false);
      expect(entryFor(older.id)?.timestamp).toBe(older.completedAt);
    } finally {
      await Repo.transactions.clear();
    }
  }, 15_000);

  it('refreshes older swaps after an equal SWR head and retries a failed row read', async () => {
    await Repo.transactions.clear();

    const latest: ITransaction = {
      id: 'LATEST-HEAD',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'consume',
      initiatedAt: 5000,
      completedAt: 5000,
      displayIcon: 'RECEIVE'
    };
    const olderSwap: ITransaction = {
      id: 'OLDER-SWAP',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'swap',
      initiatedAt: 1000,
      completedAt: 1000,
      displayIcon: 'SWAP',
      faucetId: 'fa1',
      amount: 5n,
      outputNoteIds: ['order-note'],
      extraInputs: {
        orderId: 'order-1',
        autoConsume: true,
        expiresAt: 4_000_000_000,
        requestedAmount: 10n,
        requestedFaucetId: 'fa2'
      }
    };
    const fill: ITransaction = {
      id: 'OLDER-FILL',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'consume',
      initiatedAt: 1100,
      completedAt: 1100,
      displayIcon: 'RECEIVE',
      noteIds: ['fill-note'],
      amount: 4n,
      faucetId: 'fa2',
      extraInputs: { swapOrderTxId: olderSwap.id, swapSettleKind: 'settle' }
    };
    await Repo.transactions.bulkPut([latest, olderSwap, fill]);

    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) =>
      request.fromEnd
        ? {
            transactions: [latest],
            rawCount: 1,
            hasMore: true,
            nextCursor: { effectiveTimestamp: 5000, transactionId: latest.id }
          }
        : {
            transactions: [olderSwap],
            rawCount: 1,
            hasMore: false,
            nextCursor: { effectiveTimestamp: 1000, transactionId: olderSwap.id }
          }
    );
    const actualResolveSwapHistoryProgress =
      jest.requireActual<typeof import('./resolveSwapHistoryProgress')>(
        './resolveSwapHistoryProgress'
      ).resolveSwapHistoryProgress;
    jest.mocked(resolveSwapHistoryProgress).mockImplementation(actualResolveSwapHistoryProgress);
    mockGetUncompletedTransactions.mockResolvedValue([]);

    const originalBulkGet = Repo.transactions.bulkGet.bind(Repo.transactions);
    const bulkGet = jest.spyOn(Repo.transactions, 'bulkGet').mockImplementation(originalBulkGet);
    try {
      await act(async () => render(inCache(page(true, { fullHistory: true }))));
      await waitFor(() => expect(visibleView()?.entries).toHaveLength(1));
      await act(async () => {
        await visibleView().loadMore(0);
      });
      const olderEntry = () => visibleView().entries.find((entry: any) => entry.key === 'completed-OLDER-SWAP');
      await waitFor(() => expect(olderEntry()?.swapFillProgress).toBe('40'));
      expect(olderEntry()?.swapSettlement).toBe('pending');

      await Repo.transactions.put({ ...olderSwap, extraInputs: { ...olderSwap.extraInputs, reclaimedAt: 1200 } });
      await Repo.transactions.put({ ...fill, amount: 10n });
      bulkGet.mockRejectedValueOnce(new Error('older row read failed'));

      await act(async () => visibleView().onRetry());
      await waitFor(() => expect(bulkGet).toHaveBeenCalledTimes(1));
      expect(olderEntry()?.swapFillProgress).toBe('40');
      expect(olderEntry()?.swapSettlement).toBe('pending');

      await pastDedupe();
      await act(async () => visibleView().onRetry());
      await waitFor(() => expect(bulkGet).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(olderEntry()?.swapFillProgress).toBe('100'));
      expect(olderEntry()?.swapSettlement).toBe('reclaimed');
    } finally {
      bulkGet.mockRestore();
      await Repo.transactions.clear();
      jest.mocked(resolveSwapHistoryProgress).mockImplementation(async () => new Map());
    }
  }, 15_000);

  it('restarts a gap backfill from an equal SWR head without the layout effect', async () => {
    const anchor = {
      id: 'old-anchor',
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'consume',
      displayMessage: 'anchor',
      displayIcon: 'RECEIVE',
      completedAt: 1000,
      initiatedAt: 1000
    };
    const inserted = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, index) => ({
      id: `inserted-${String(index).padStart(4, '0')}`,
      accountId: '0xme',
      status: ITransactionStatus.Completed,
      type: 'consume',
      displayMessage: 'inserted',
      displayIcon: 'RECEIVE',
      completedAt: 20_000 + index,
      initiatedAt: 20_000 + index
    }));
    const newestFirst = [...inserted].sort((a, b) => b.completedAt - a.completedAt || b.id.localeCompare(a.id));
    const head = newestFirst.slice(0, HISTORY_PAGE_SIZE);
    const oldest = newestFirst[newestFirst.length - 1]!;
    const cursorFor = (row: { id: string; completedAt: number; initiatedAt: number; status: ITransactionStatus }) => ({
      effectiveTimestamp: row.completedAt,
      transactionId: row.id,
      status: row.status,
      initiatedAt: row.initiatedAt
    });
    const tail = { ...anchor, id: 'tail-older', completedAt: 0, initiatedAt: 0 };
    const restartCursor = cursorFor(head[head.length - 1]!);
    let gapped = false;
    let olderCalls = 0;
    const olderCursors: Array<CompletedHistoryCursor | null | undefined> = [];
    let releaseStale: (page: unknown) => void = () => {};
    mockGetCompletedTransactionsPage.mockImplementation(async (request: CompletedTransactionsPageRequest) => {
      if (request.fromEnd) {
        const page = gapped ? head : [anchor];
        return {
          transactions: page,
          rawCount: page.length,
          hasMore: true,
          nextCursor: cursorFor(page[page.length - 1]!)
        };
      }
      olderCalls += 1;
      olderCursors.push(request.cursor);
      if (olderCalls === 1) {
        return await new Promise(resolve => {
          releaseStale = resolve;
        });
      }
      if (request.cursor?.transactionId === restartCursor.transactionId) {
        return {
          transactions: [oldest, anchor],
          rawCount: 2,
          hasMore: true,
          nextCursor: cursorFor(anchor)
        };
      }
      return { transactions: [tail], rawCount: 1, hasMore: false, nextCursor: cursorFor(tail) };
    });
    mockGetUncompletedTransactions.mockResolvedValue([]);

    try {
      await act(async () => render(inCache(page(true, { fullHistory: true }))));
      const keysOf = () => visibleView()?.entries.map((entry: { key: string }) => entry.key) ?? [];
      await waitFor(() => expect(keysOf()).toContain('completed-old-anchor'));
      gapped = true;
      await act(async () => visibleView().onRetry());
      await waitFor(() => expect(olderCalls).toBe(1));
      await waitFor(() => expect(keysOf()).toContain('completed-inserted-1000'));

      await pastDedupe();
      await act(async () => visibleView().onRetry());
      await waitFor(() => expect(olderCalls).toBe(2));
      expect(olderCursors[1]).toEqual(restartCursor);
      await waitFor(() => expect(keysOf()).toContain('completed-inserted-0000'));
      expect(keysOf()).not.toContain('completed-tail-older');
    } finally {
      releaseStale({ transactions: [], rawCount: 0, hasMore: false, nextCursor: null });
    }
  }, 20_000);

  it('retries on the page that is showing when an off-screen page of the same account mounted first', async () => {
    // The first settled read, which only the page on screen runs, fails; later ones succeed.
    let failed = false;
    mockGetCompletedTransactions.mockImplementation(async (_addr: string, offset?: number) => {
      if (offset === undefined && !failed) {
        failed = true;
        throw new Error('db down');
      }
      return offset === undefined ? makeCompleted() : [];
    });
    await act(async () => {
      render(
        inCache(
          <>
            {page(false)}
            {page(true, { fullHistory: true })}
          </>
        )
      );
    });
    await waitFor(() => expect(visibleView()?.loadError).toBe(true));
    const before = mockGetCompletedTransactions.mock.calls.length;

    await act(async () => visibleView().onRetry());
    await waitFor(() => expect(mockGetCompletedTransactions.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(visibleView()?.loadError).toBe(false));
  });

  it('reports no initial load for a page that mounted off screen until it is on screen and answered', async () => {
    const onInitialLoad = jest.fn();
    let utils: ReturnType<typeof render> | undefined;
    await act(async () => {
      utils = render(inCache(page(false, { onInitialLoad })));
    });
    expect(onInitialLoad).not.toHaveBeenCalled();
    expect(mockHistoryViewProps.initialLoading).toBe(true);

    await act(async () => {
      utils?.rerender(inCache(page(true, { onInitialLoad })));
    });
    await waitFor(() => expect(onInitialLoad).toHaveBeenCalled());
  });

  // Past the hooks' own 3 s dedupe window, so a read again is SWR revalidating a key that comes back, not a dedupe hit.
  const pastDedupe = () => act(() => new Promise(resolve => setTimeout(resolve, 3_100)));
  const settledFetches = () => mockGetCompletedTransactions.mock.calls.filter(call => call[1] === undefined).length;

  it('reads both again when its page comes back on screen with their data cached', async () => {
    let utils: ReturnType<typeof render> | undefined;
    await act(async () => {
      utils = render(inCache(page(true)));
    });
    await waitFor(() => expect(settledFetches()).toBe(1));
    await waitFor(() => expect(mockGetUncompletedTransactions).toHaveBeenCalledTimes(1));

    await act(async () => {
      utils?.rerender(inCache(page(false)));
    });
    await pastDedupe();
    await act(async () => {
      utils?.rerender(inCache(page(true)));
    });
    await waitFor(() => expect(settledFetches()).toBe(2));
    await waitFor(() => expect(mockGetUncompletedTransactions).toHaveBeenCalledTimes(2));
  }, 10_000);

  it('reads settled history again when the filter leaves Pending', async () => {
    let utils: ReturnType<typeof render> | undefined;
    await act(async () => {
      utils = render(inCache(page(true, { filter: 'all' })));
    });
    await waitFor(() => expect(settledFetches()).toBe(1));

    await act(async () => {
      utils?.rerender(inCache(page(true, { filter: 'pending' })));
    });
    await pastDedupe();
    await act(async () => {
      utils?.rerender(inCache(page(true, { filter: 'all' })));
    });
    await waitFor(() => expect(settledFetches()).toBe(2));
  }, 10_000);

  it("never shows another account's rows while an off-screen page switches accounts", async () => {
    mockGetCompletedTransactions.mockImplementation(async (addr: string, offset?: number) =>
      addr === '0xA' && offset === undefined ? makeCompleted() : []
    );
    mockGetUncompletedTransactions.mockImplementation(async (addr: string) => (addr === '0xA' ? makePending() : []));
    const account = (address: string, onScreen: boolean, filter = 'all') => (
      <PageActiveContext.Provider value={onScreen}>
        <History address={address} filter={filter as any} />
      </PageActiveContext.Provider>
    );
    let utils: ReturnType<typeof render> | undefined;
    await act(async () => {
      utils = render(inCache(account('0xA', true)));
    });
    await waitFor(() => expect(entryKeys()).toContain('completed-S'));

    await act(async () => {
      utils?.rerender(inCache(account('0xA', false)));
    });
    await act(async () => {
      utils?.rerender(inCache(account('0xB', false)));
    });
    expect(entryKeys()).toEqual([]);

    // Under Pending the settled read stays off; leaving Pending must not bring 0xA's settled rows back.
    await act(async () => {
      utils?.rerender(inCache(account('0xB', true, 'pending')));
    });
    await act(async () => {
      utils?.rerender(inCache(account('0xB', true, 'all')));
    });
    await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
    expect(entryKeys()).toEqual([]);
  });

  // The cached settled read predates the claim that took the card away, so it still holds the note's failed
  // attempts unsuperseded (#771).
  describe('when a claim card leaves', () => {
    const failedAttempt = (id: string, noteId: string) => ({
      id,
      status: STATUS.Failed,
      displayMessage: 'Failed',
      displayIcon: 'FAILED',
      type: 'consume',
      noteIds: [noteId],
      completedAt: 700
    });
    // Only the refreshed read has it, so seeing it means that read has landed.
    const freshRow = {
      id: 'fresh',
      status: STATUS.Completed,
      displayMessage: 'fresh',
      displayIcon: 'SEND',
      type: 'send',
      completedAt: 800
    };
    const claimCard = (noteId: string): PendingActivityItem => ({
      note: {
        id: noteId,
        faucetId: 'fa1',
        amount: '100',
        senderAddress: 'sender',
        isBeingClaimed: true,
        type: 'unknown',
        metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
      },
      status: 'claiming'
    });
    const holdNextSettledRead = () => {
      let release: (rows: unknown[]) => void = () => {};
      mockGetCompletedTransactions.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = resolve;
          })
      );
      return (rows: unknown[]) => act(async () => release(rows));
    };
    const shownSince = (from: number, key: string) =>
      mockHistoryViewCalls.slice(from).some(props => props.entries.some((entry: { key: string }) => entry.key === key));
    const settledReads = () => mockGetCompletedTransactions.mock.calls.length;
    // A hold a failing test never reached would otherwise answer the next test's first read.
    afterEach(() => mockGetCompletedTransactions.mockReset());

    const mountWithCards = async (rows: unknown[], cards: PendingActivityItem[]) => {
      mockGetCompletedTransactions.mockResolvedValue(rows);
      let utils: ReturnType<typeof render> | undefined;
      await act(async () => {
        utils = render(inCache(page(true, { pendingItems: cards })));
      });
      await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
      return (next: PendingActivityItem[]) =>
        act(async () => {
          utils?.rerender(inCache(page(true, { pendingItems: next })));
        });
    };

    it('keeps its failed attempts hidden until the refreshed read settles, which drops them as superseded', async () => {
      const rows = [failedAttempt('attempt', 'note-n')];
      const showCards = await mountWithCards(rows, [claimCard('note-n')]);
      expect(entryKeys()).not.toContain('completed-attempt');
      const before = settledReads();
      const release = holdNextSettledRead();
      const from = mockHistoryViewCalls.length;

      await showCards([]);
      expect(shownSince(from, 'completed-attempt')).toBe(false);
      await waitFor(() => expect(settledReads()).toBe(before + 1));
      expect(shownSince(from, 'completed-attempt')).toBe(false);

      mockSupersededFailedConsumeIds.mockResolvedValue(new Set(['attempt']));
      await release([...rows, freshRow]);
      await waitFor(() => expect(entryKeys()).toContain('completed-fresh'));
      await act(async () => {});
      expect(entryKeys()).not.toContain('completed-attempt');
      expect(shownSince(from, 'completed-attempt')).toBe(false);
    });

    it('releases overlapping leaves only once the refresh started after the last of them settles', async () => {
      const rows = [failedAttempt('attempt-a', 'note-a'), failedAttempt('attempt-b', 'note-b')];
      const showCards = await mountWithCards(rows, [claimCard('note-a'), claimCard('note-b')]);
      const before = settledReads();
      const from = mockHistoryViewCalls.length;

      const releaseA = holdNextSettledRead();
      await showCards([claimCard('note-b')]);
      await waitFor(() => expect(settledReads()).toBe(before + 1));
      const releaseB = holdNextSettledRead();
      await showCards([]);
      await waitFor(() => expect(settledReads()).toBe(before + 2));

      // SWR discards the older fetch that the newer refresh replaced, so settling it proves nothing about the feed.
      mockSupersededFailedConsumeIds.mockResolvedValue(new Set(['attempt-a']));
      await releaseA(rows);
      expect(shownSince(from, 'completed-attempt-a')).toBe(false);
      expect(shownSince(from, 'completed-attempt-b')).toBe(false);

      // Attempt-a is left unsuperseded, so only the release can show it.
      mockSupersededFailedConsumeIds.mockResolvedValue(new Set(['attempt-b']));
      await releaseB([...rows, freshRow]);
      await waitFor(() => expect(entryKeys()).toContain('completed-fresh'));
      await act(async () => {});
      await waitFor(() => expect(entryKeys()).toContain('completed-attempt-a'));
      const stale = mockHistoryViewCalls
        .slice(from)
        .filter(props => props.entries.some((entry: { key: string }) => entry.key === 'completed-attempt-a'))
        .filter(props => !props.entries.some((entry: { key: string }) => entry.key === 'completed-fresh'));
      expect(stale).toEqual([]);
      expect(shownSince(from, 'completed-attempt-b')).toBe(false);
    });

    it('shows a failed attempt again once the refreshed read settles without superseding it', async () => {
      const rows = [failedAttempt('attempt', 'note-n')];
      const showCards = await mountWithCards(rows, [claimCard('note-n')]);
      const before = settledReads();
      const release = holdNextSettledRead();
      const from = mockHistoryViewCalls.length;

      await showCards([]);
      await waitFor(() => expect(settledReads()).toBe(before + 1));
      expect(shownSince(from, 'completed-attempt')).toBe(false);

      await release(rows);
      await waitFor(() => expect(entryKeys()).toContain('completed-attempt'));
    });

    it('keeps a note that left under Pending held until the settled read runs again and is refreshed', async () => {
      const rows = [failedAttempt('attempt', 'note-n')];
      mockGetCompletedTransactions.mockResolvedValue(rows);
      let utils: ReturnType<typeof render> | undefined;
      const show = (filter: string, cards: PendingActivityItem[]) =>
        act(async () => {
          utils?.rerender(inCache(page(true, { filter, pendingItems: cards })));
        });
      await act(async () => {
        utils = render(inCache(page(true, { filter: 'all', pendingItems: [claimCard('note-n')] })));
      });
      await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
      await show('pending', [claimCard('note-n')]);
      await show('pending', []);

      mockGetCompletedTransactions.mockResolvedValue([...rows, freshRow]);
      const from = mockHistoryViewCalls.length;
      await show('all', []);
      await waitFor(() => expect(entryKeys()).toContain('completed-attempt'));
      const stale = mockHistoryViewCalls
        .slice(from)
        .filter(props => props.entries.some((entry: { key: string }) => entry.key === 'completed-attempt'))
        .filter(props => !props.entries.some((entry: { key: string }) => entry.key === 'completed-fresh'));
      expect(stale).toEqual([]);
    });

    it('refreshes a note that left under Pending when the switch to all commits before any other render', async () => {
      const rows = [failedAttempt('attempt', 'note-n')];
      mockGetCompletedTransactions.mockResolvedValue(rows);
      let utils: ReturnType<typeof render> | undefined;
      await act(async () => {
        utils = render(inCache(page(true, { filter: 'all', pendingItems: [claimCard('note-n')] })));
      });
      await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
      await act(async () => {
        utils?.rerender(inCache(page(true, { filter: 'pending', pendingItems: [claimCard('note-n')] })));
      });

      mockGetCompletedTransactions.mockResolvedValue([...rows, freshRow]);
      const before = settledReads();
      const from = mockHistoryViewCalls.length;
      // Two sync commits: the effect after the leave queues its updates at default priority, which the switch skips.
      await act(async () => {
        flushSync(() => utils?.rerender(inCache(page(true, { filter: 'pending', pendingItems: [] }))));
        flushSync(() => utils?.rerender(inCache(page(true, { filter: 'all', pendingItems: [] }))));
      });
      await waitFor(() => expect(settledReads()).toBe(before + 1));
      await waitFor(() => expect(entryKeys()).toContain('completed-attempt'));
      const stale = mockHistoryViewCalls
        .slice(from)
        .filter(props => props.entries.some((entry: { key: string }) => entry.key === 'completed-attempt'))
        .filter(props => !props.entries.some((entry: { key: string }) => entry.key === 'completed-fresh'));
      expect(stale).toEqual([]);
    });

    it('keeps its failed attempts hidden when the page goes off screen before the refreshed read settles', async () => {
      const rows = [failedAttempt('attempt', 'note-n')];
      mockGetCompletedTransactions.mockResolvedValue(rows);
      let utils: ReturnType<typeof render> | undefined;
      const show = (onScreen: boolean, cards: PendingActivityItem[]) =>
        act(async () => {
          utils?.rerender(inCache(page(onScreen, { pendingItems: cards })));
        });
      await act(async () => {
        utils = render(inCache(page(true, { pendingItems: [claimCard('note-n')] })));
      });
      await waitFor(() => expect(mockHistoryViewProps.initialLoading).toBe(false));
      const before = settledReads();
      const release = holdNextSettledRead();
      const from = mockHistoryViewCalls.length;

      await show(true, []);
      await waitFor(() => expect(settledReads()).toBe(before + 1));
      await show(false, []);

      // Off screen the page keeps drawing its pre-refresh rows, so the refresh settling there cannot release.
      mockSupersededFailedConsumeIds.mockResolvedValue(new Set(['attempt']));
      await release([...rows, freshRow]);
      await act(() => new Promise(resolve => setTimeout(resolve, 0)));
      expect(shownSince(from, 'completed-attempt')).toBe(false);
    });
  });
});
