import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

// Imported after the mocks so the module graph is wired to the stubs.
import { HistoryDetails } from './HistoryDetails';

// ---------------------------------------------------------------------------
// Mutable state the mocks read at call time (must be `mock`-prefixed for jest).
// ---------------------------------------------------------------------------
let mockAccount: { publicKey?: string; name?: string } | undefined = { publicKey: 'acct-A', name: 'Mine' };
let mockAllAccounts: Array<{ publicKey: string; name: string }> = [{ publicKey: 'acct-B', name: 'Other' }];
let mockTokenPrices: Record<string, { price: number }> = { MID: { price: 2 } };
let mockPrice = 2;

// ---------------------------------------------------------------------------
// Data / logic dependency mocks.
// ---------------------------------------------------------------------------
const mockGetTransactionById = jest.fn();
const mockRetryEarnWithdrawReceive = jest.fn().mockResolvedValue(undefined);
const mockTrackOrderId = jest.fn();
const mockGetSwapSettlementNotes = jest.fn();
const mockGetTokenMetadata = jest.fn();
const mockGetSwapTokenByFaucetId = jest.fn();
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockCancelTransactionById = jest.fn();
const mockRequeueFailedTransaction = jest.fn();
const mockRequestSWTransactionProcessing = jest.fn();
const mockIsRequeueableTransaction = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/miden/activity', () => ({
  getTransactionById: (...args: unknown[]) => mockGetTransactionById(...args),
  trackOrderId: (...args: unknown[]) => mockTrackOrderId(...args),
  getSwapSettlementNotes: (...args: unknown[]) => mockGetSwapSettlementNotes(...args),
  cancelTransactionById: (...args: unknown[]) => mockCancelTransactionById(...args),
  requeueFailedTransaction: (...args: unknown[]) => mockRequeueFailedTransaction(...args),
  requestSWTransactionProcessing: (...args: unknown[]) => mockRequestSWTransactionProcessing(...args),
  isRequeueableTransaction: (...args: unknown[]) => mockIsRequeueableTransaction(...args),
  retryEarnWithdrawReceive: (...args: unknown[]) => mockRetryEarnWithdrawReceive(...args),
  USER_CANCELLED_TRANSACTION_REASON: 'Transaction was cancelled by user',
  isUserCancelledTransaction: (error: unknown) => error === 'Transaction was cancelled by user'
}));

jest.mock('lib/miden/front', () => ({
  useAllAccounts: () => mockAllAccounts,
  useAccount: () => mockAccount
}));

jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: (...args: unknown[]) => mockGetTokenMetadata(...args)
}));

jest.mock('lib/miden/swap/tokens', () => ({
  getSwapTokenByFaucetId: (...args: unknown[]) => mockGetSwapTokenByFaucetId(...args)
}));

jest.mock('lib/prices', () => ({
  getTokenPrice: () => ({ price: mockPrice })
}));

// Deterministic formatter so amount assertions are exact (real formatAmount
// pulls in lib/i18n/numbers + MIDEN_METADATA from lib/miden/front).
jest.mock('lib/shared/format', () => ({
  formatAmount: jest.fn((amount: bigint | number | string) => String(amount))
}));

jest.mock('lib/store', () => ({
  // The component only reads `tokenPrices` via a selector.
  useWalletStore: (selector: (state: { tokenPrices: typeof mockTokenPrices }) => unknown) =>
    selector({ tokenPrices: mockTokenPrices })
}));

jest.mock('lib/woozie', () => ({
  goBack: () => mockGoBack(),
  navigate: (...args: unknown[]) => mockNavigate(...args)
}));

// ---------------------------------------------------------------------------
// Presentational dependency mocks — light DOM so the test stays focused on
// HistoryDetails' own branches (mirrors how sibling tests stub sub-components).
// ---------------------------------------------------------------------------
jest.mock('app/atoms/ActivitySpinner', () => ({
  ActivitySpinner: () => <div data-testid="spinner" />
}));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>
}));

jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: ({ title, backLabel, onBack }: { title: string; backLabel: string; onBack: () => void }) => (
    <div data-testid="screen-header">
      <span data-testid="header-title">{title}</span>
      <button data-testid="back-button" onClick={onBack}>
        {backLabel}
      </button>
    </div>
  )
}));

jest.mock('../AddressChip', () => ({
  __esModule: true,
  default: ({ address, displayName }: { address: string; displayName?: string }) => (
    <span data-testid="address-chip" data-address={address} data-displayname={displayName ?? ''}>
      {displayName ?? address}
    </span>
  )
}));

jest.mock('../HashChip', () => ({
  __esModule: true,
  default: ({ hash }: { hash: string }) => <span data-testid="hash-chip">{hash}</span>
}));

jest.mock('./DetailCard', () => ({
  DetailCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-testid="detail-card" data-title={title}>
      {children}
    </section>
  ),
  DetailRow: ({ label, isLast, children }: { label: string; isLast?: boolean; children: React.ReactNode }) => (
    <div data-testid="detail-row" data-label={label} data-islast={String(!!isLast)}>
      {children}
    </div>
  ),
  ExternalLinkValue: ({ displayValue, href }: { displayValue: React.ReactNode; href: string }) => (
    <a data-testid="external-link" href={href}>
      {displayValue}
    </a>
  ),
  StatusPill: ({ status, isCancelled }: { status?: number; isCancelled?: boolean }) => (
    <div data-testid="status-pill" data-status={String(status)} data-cancelled={String(!!isCancelled)} />
  )
}));

jest.mock('./TransactionIcon', () => ({
  __esModule: true,
  default: ({ size }: { size?: string }) => <div data-testid="tx-icon" data-size={size} />,
  getTransactionIconBackgroundColor: () => '#91ACC1'
}));

// The branch adds the EVM bridge claim panel to history details. Stub it here
// so this swap/history unit test does not load Wagmi's ESM-only runtime.
jest.mock('./BridgeClaimSection', () => ({
  BridgeClaimSection: () => <div data-testid="bridge-claim-section" />
}));

jest.mock('./transactionUtils', () => ({
  ...jest.requireActual('./transactionUtils'),
  formatDate: (timestamp: number | string) => `formatted:${timestamp}`
}));

// ITransactionStatus.Completed === 2 (see lib/miden/db/types).
const STATUS_COMPLETED = 2;

type Tx = Record<string, unknown>;

const baseSendTx: Tx = {
  id: 'tx-1',
  accountId: 'acct-A',
  secondaryAccountId: 'acct-B',
  faucetId: 'faucet-1',
  amount: 1000n,
  completedAt: 1_700_000_000,
  displayMessage: 'Sent',
  status: STATUS_COMPLETED,
  displayIcon: 'SEND',
  noteType: 'P2ID',
  outputNoteIds: ['note-1'],
  transactionId: 'ext-tx-1',
  type: 'send',
  extraInputs: undefined
};

/** Drain chained promise microtasks (loadTransaction awaits) inside act. */
const flush = async (ticks = 20) => {
  await act(async () => {
    for (let i = 0; i < ticks; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  });
};

const renderAndLoad = async (props: { transactionId?: string } = {}) => {
  const utils = render(<HistoryDetails transactionId={props.transactionId ?? 'tx-1'} />);
  await flush();
  return utils;
};

const rowByLabel = (label: string) =>
  Array.from(document.querySelectorAll('[data-testid="detail-row"]')).find(
    el => el.getAttribute('data-label') === label
  );

beforeEach(() => {
  jest.clearAllMocks();
  // Keep IndexedDB/Dexie's scheduling primitives real so the global database
  // cleanup hook can complete; only timer-based order polling needs faking.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });

  mockGetSwapSettlementNotes.mockResolvedValue({ settled: [], reclaimed: [] });
  mockAccount = { publicKey: 'acct-A', name: 'Mine' };
  mockAllAccounts = [{ publicKey: 'acct-B', name: 'Other' }];
  mockTokenPrices = { MID: { price: 2 } };
  mockPrice = 2;

  // Default: token metadata for the tx faucet; requested-faucet lookups get a
  // symbol-less record so the "no symbol" swap branch is reachable.
  mockGetTokenMetadata.mockImplementation((id: string | null) =>
    Promise.resolve(id === 'req-faucet' ? {} : { symbol: 'MID', decimals: 6 })
  );
  mockGetSwapTokenByFaucetId.mockReturnValue(undefined);
  mockTrackOrderId.mockResolvedValue(null);
  // Mirror the production predicate: Failed + a re-queueable type.
  mockIsRequeueableTransaction.mockImplementation(
    (tx: { status?: number; type: string }) =>
      tx.status === 3 && ['send', 'consume', 'swap', 'bridged-send', 'execute'].includes(tx.type)
  );
  mockCancelTransactionById.mockResolvedValue(undefined);
  mockRequeueFailedTransaction.mockResolvedValue(undefined);

  // Reset the deterministic formatAmount default (a test may override it).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { formatAmount } = require('lib/shared/format');
  formatAmount.mockImplementation((amount: bigint | number | string) => String(amount));

  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('HistoryDetails', () => {
  describe('loading & error states', () => {
    it('renders the spinner while the transaction is still loading', () => {
      // Never-resolving fetch keeps entry === null && no error → spinner branch.
      mockGetTransactionById.mockReturnValue(new Promise(() => {}));
      render(<HistoryDetails transactionId="tx-1" />);
      expect(screen.getByTestId('spinner')).toBeInTheDocument();
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });

    it('renders the error view with the Error message when the fetch throws an Error', async () => {
      mockGetTransactionById.mockRejectedValue(new Error('boom-failure'));
      await renderAndLoad();

      expect(screen.getByText('smthWentWrong')).toBeInTheDocument();
      expect(screen.getByText('boom-failure')).toBeInTheDocument();
      // ID line echoes the transactionId.
      expect(screen.getByText('ID: tx-1')).toBeInTheDocument();
      expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    });

    it('falls back to a generic message when the thrown value is not an Error', async () => {
      mockGetTransactionById.mockRejectedValue('a plain string');
      await renderAndLoad();
      expect(screen.getByText('Failed to load transaction')).toBeInTheDocument();
    });

    it('calls goBack when the header back button is pressed', async () => {
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx });
      await renderAndLoad();
      fireEvent.click(screen.getByTestId('back-button'));
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });
  });

  describe('sent transaction rendering', () => {
    it('renders amount, token, fiat, status, date, external tx id, from/to and notes', async () => {
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx });
      await renderAndLoad();

      // Amount + token now share the summary badge's left side.
      expect(screen.getByText('1000 MID')).toBeInTheDocument();
      expect(screen.getByText('acct-B')).toBeInTheDocument();
      // Fiat: |1000| * price(2) => 2000.00.
      expect(screen.getByText('≈ $2000.00 USD')).toBeInTheDocument();

      // Status pill fed the raw status.
      expect(screen.getByTestId('status-pill')).toHaveAttribute('data-status', String(STATUS_COMPLETED));

      // Date row uses our formatDate stub.
      expect(rowByLabel('date')?.textContent).toContain('formatted:1700000000');

      // External tx id row → HashChip + midenscan link.
      const txRow = rowByLabel('txIdLabel')!;
      expect(txRow.querySelector('[data-testid="hash-chip"]')?.textContent).toBe('ext-tx-1');
      expect(txRow.querySelector('a[data-testid="external-link"]')).toHaveAttribute(
        'href',
        'https://testnet.midenscan.com/tx/ext-tx-1'
      );

      // 'Sent' => from = accountId (matches current account) / to = secondaryAccountId (matches allAccounts).
      const fromChip = rowByLabel('from')!.querySelector('[data-testid="address-chip"]')!;
      expect(fromChip).toHaveAttribute('data-address', 'acct-A');
      expect(fromChip).toHaveAttribute('data-displayname', 'you (Mine)');
      const toChip = rowByLabel('to')!.querySelector('[data-testid="address-chip"]')!;
      expect(toChip).toHaveAttribute('data-address', 'acct-B');
      expect(toChip).toHaveAttribute('data-displayname', 'you (Other)');

      // Notes section: created count = outputNoteIds length.
      expect(rowByLabel('created')?.textContent).toBe('1');

      // Transfer details and Notes are separated using the transaction icon accent.
      const dividers = screen.getAllByTestId('history-section-divider');
      expect(dividers).toHaveLength(2);
      dividers.forEach(divider => expect(divider).toHaveStyle({ backgroundColor: '#91ACC1' }));

      // Not a swap → no order-tracking card.
      expect(screen.queryByTestId('swap-order-card')).not.toBeInTheDocument();
    });

    it('shows the address itself when the account is unknown (no display name)', async () => {
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx, secondaryAccountId: 'stranger' });
      await renderAndLoad();
      const toChip = rowByLabel('to')!.querySelector('[data-testid="address-chip"]')!;
      expect(toChip).toHaveAttribute('data-displayname', '');
      expect(toChip.textContent).toBe('stranger');
    });

    it('swaps from/to for a non-Sent message and hides optional rows when data is absent', async () => {
      mockGetTransactionById.mockResolvedValue({
        ...baseSendTx,
        displayMessage: 'Received',
        transactionId: undefined, // no external tx id row
        amount: 0n, // falsy → amount undefined → no amount span / no fiat
        faucetId: undefined, // no metadata → token undefined
        outputNoteIds: ['note-x'] // still has note data
      });
      await renderAndLoad();

      // 'Received': from = secondaryAccountId (acct-B), to = accountId (acct-A).
      expect(rowByLabel('from')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute(
        'data-address',
        'acct-B'
      );
      expect(rowByLabel('to')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-address', 'acct-A');

      // No external tx id row.
      expect(rowByLabel('txIdLabel')).toBeUndefined();
      // No amount span (amount undefined) → fiat also absent.
      expect(screen.queryByText('≈ $2000.00 USD')).not.toBeInTheDocument();
    });

    it('hides the notes section entirely when there is no note data', async () => {
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx, outputNoteIds: undefined });
      await renderAndLoad();
      expect(rowByLabel('created')).toBeUndefined();
    });

    it('treats a present-but-empty-first note id as note data via the outputNoteIds branch', async () => {
      // noteId = outputNoteIds[0] = '' (falsy) but outputNoteIds.length > 0 → hasNoteData true.
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx, outputNoteIds: [''] });
      await renderAndLoad();
      expect(rowByLabel('created')?.textContent).toBe('1');
    });

    it('returns the raw amount string when it is not a finite number (and omits fiat)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatAmount } = require('lib/shared/format');
      formatAmount.mockReturnValue('NaN');
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx });
      await renderAndLoad();

      // The shared summary badge preserves the formatter's non-finite output.
      expect(screen.getByText('NaN MID')).toBeInTheDocument();
      // formatFiatDisplayAmount → non-finite → undefined → no fiat line.
      expect(screen.queryByText(/USD/)).not.toBeInTheDocument();
    });

    it('renders address chips even when there is no current account (optional-chaining branch)', async () => {
      mockAccount = undefined;
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx, secondaryAccountId: 'acct-B' });
      await renderAndLoad();
      // account undefined → falls through to allAccounts lookup for the matching id.
      expect(rowByLabel('to')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute(
        'data-displayname',
        'you (Other)'
      );
      // 'acct-A' now matches no account → shown raw.
      expect(rowByLabel('from')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-displayname', '');
    });
  });

  describe('swap order tracking', () => {
    const swapTx = (extra: Record<string, unknown>): Tx => ({
      ...baseSendTx,
      type: 'swap',
      amount: undefined,
      faucetId: 'faucet-1',
      outputNoteIds: undefined,
      transactionId: undefined,
      extraInputs: extra
    });

    it('resolves the requested token via the swap registry and shows a filled order', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 400n
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );
      await renderAndLoad();

      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusFilled');
      expect(screen.getByTestId('swap-order-fill-rounds').textContent).toBe('2');
      // filledRequested = 1000 - 400 = 600; symbol appended.
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('600 / 1000 ETH');

      // Registry hit → requested-faucet metadata NOT fetched (only the tx faucet was).
      expect(mockGetTokenMetadata).toHaveBeenCalledTimes(1);
      expect(mockGetTokenMetadata).toHaveBeenCalledWith('faucet-1');
    });

    it('falls back to token metadata, defaults the requested amount, clamps overfill to 0 and omits an unknown symbol', async () => {
      // Registry miss → metadata lookup for the requested faucet (returns {} → no symbol/decimals).
      mockGetSwapTokenByFaucetId.mockReturnValue(undefined);
      mockTrackOrderId.mockResolvedValue({
        orderId: '7',
        state: 'reclaimed',
        currentDepth: 0,
        remainingOffered: 0n,
        remainingRequested: 5n
      });
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 7n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusReclaimed');
      // requestedAmount defaulted to 0n; remainingRequested(5) > amount(0) → filled clamped to 0; no symbol.
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('0 / 0');
      // Two metadata calls: tx faucet + requested faucet.
      expect(mockGetTokenMetadata).toHaveBeenCalledWith('req-faucet');
    });

    it('shows the active label and keeps polling until a terminal state', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId
        .mockResolvedValueOnce({
          orderId: '9',
          state: 'active',
          currentDepth: 1,
          remainingOffered: 0n,
          remainingRequested: 700n
        })
        .mockResolvedValueOnce({
          orderId: '9',
          state: 'filled',
          currentDepth: 3,
          remainingOffered: 0n,
          remainingRequested: 0n
        });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 9n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );
      await renderAndLoad();

      // First poll → active.
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusActive');

      // Active schedules another poll at the base interval (2s).
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      await flush();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusFilled');
      expect(mockTrackOrderId).toHaveBeenCalledTimes(2);
    });

    it('shows the loading label while the first poll is in flight', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockReturnValue(new Promise(() => {})); // never resolves
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 5n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      const statusRow = rowByLabel('orderStatus')!;
      expect(statusRow.textContent).toBe('loading');
      expect(screen.queryByTestId('swap-order-status')).not.toBeInTheDocument();
    });

    it('shows a polling indicator while refreshing an active order', async () => {
      let resolveRefresh!: (tracking: {
        orderId: string;
        state: string;
        currentDepth: number;
        remainingOffered: bigint;
        remainingRequested: bigint;
      }) => void;
      const refresh = new Promise(resolve => {
        resolveRefresh = resolve;
      });
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId
        .mockResolvedValueOnce({
          orderId: '10',
          state: 'active',
          currentDepth: 1,
          remainingOffered: 0n,
          remainingRequested: 700n
        })
        .mockReturnValueOnce(refresh);
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 10n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );
      await renderAndLoad();

      expect(screen.queryByTestId('swap-order-polling')).not.toBeInTheDocument();

      await act(async () => {
        jest.advanceTimersByTime(2000);
      });

      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusActive');
      expect(screen.getByTestId('swap-order-polling')).toHaveTextContent('loading');

      await act(async () => {
        resolveRefresh({
          orderId: '10',
          state: 'filled',
          currentDepth: 2,
          remainingOffered: 0n,
          remainingRequested: 0n
        });
        await Promise.resolve();
      });

      expect(screen.queryByTestId('swap-order-polling')).not.toBeInTheDocument();
      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusFilled');
    });

    it('backs off on unresolved polls and gives up after the cap', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue(null); // never resolves the order
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 3n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      // First poll already ran during load.
      expect(rowByLabel('orderStatus')!.textContent).toBe('trackingUnavailable');

      // Drive the exponential-backoff retries until the cap (MAX_UNRESOLVED_POLLS = 20).
      for (let i = 0; i < 25; i++) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          jest.advanceTimersByTime(30_000);
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      // Exactly 20 attempts, then it stops scheduling.
      expect(mockTrackOrderId).toHaveBeenCalledTimes(20);
      expect(rowByLabel('orderStatus')!.textContent).toBe('trackingUnavailable');
    });

    it('logs and backs off when a poll throws', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockRejectedValueOnce(new Error('lineage exploded')).mockResolvedValue(null);
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 11n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      expect(console.error).toHaveBeenCalledWith('[HistoryDetails] Failed to track swap order:', expect.any(Error));
      // The catch path also schedules a retry; advancing fires it (result null now).
      await act(async () => {
        jest.advanceTimersByTime(30_000);
        await Promise.resolve();
      });
      expect(mockTrackOrderId).toHaveBeenCalledTimes(2);
    });

    it('clears the pending poll timer on unmount', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '13',
        state: 'active',
        currentDepth: 0,
        remainingOffered: 0n,
        remainingRequested: 100n
      });
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 13n, requestedFaucetId: 'req-faucet' }));
      const { unmount } = await renderAndLoad();

      const clearSpy = jest.spyOn(global, 'clearTimeout');
      await act(async () => {
        unmount();
      });
      expect(clearSpy).toHaveBeenCalled();
    });

    it('does not render the order card for a swap tx that carries no order id', async () => {
      // extraInputs present but without orderId → orderId stays null.
      mockGetTransactionById.mockResolvedValue(swapTx({ requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();
      expect(screen.queryByTestId('swap-order-card')).not.toBeInTheDocument();
      expect(mockTrackOrderId).not.toHaveBeenCalled();
    });

    it('handles a swap tx with entirely absent extraInputs', async () => {
      mockGetTransactionById.mockResolvedValue({ ...swapTx({}), extraInputs: undefined });
      await renderAndLoad();
      expect(screen.queryByTestId('swap-order-card')).not.toBeInTheDocument();
    });
  });

  describe('swap settlement notes', () => {
    const swapTx = (extra: Record<string, unknown>): Tx => ({
      ...baseSendTx,
      type: 'swap',
      amount: undefined,
      faucetId: 'faucet-1',
      outputNoteIds: undefined,
      transactionId: undefined,
      extraInputs: extra
    });

    it('lists the notes the suppressed settlement consumes claimed', async () => {
      mockGetSwapSettlementNotes.mockResolvedValue({ settled: ['note-a', 'note-b'], reclaimed: ['note-c'] });
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      expect(mockGetSwapSettlementNotes).toHaveBeenCalledWith('tx-1');
      expect(screen.getByTestId('swap-settled-notes').textContent).toBe('note-anote-b');
      expect(screen.getByTestId('swap-reclaimed-notes').textContent).toBe('note-c');
      // The card renders even though the swap itself created no output notes.
      expect(rowByLabel('claimed')).toBeDefined();
      expect(rowByLabel('reclaimed')).toBeDefined();
    });

    it('omits the reclaimed row when the order only settled', async () => {
      mockGetSwapSettlementNotes.mockResolvedValue({ settled: ['note-a'], reclaimed: [] });
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-settled-notes').textContent).toBe('note-a');
      expect(screen.queryByTestId('swap-reclaimed-notes')).not.toBeInTheDocument();
      // Last row in the card is the claimed one.
      expect(rowByLabel('claimed')?.getAttribute('data-islast')).toBe('true');
    });

    it('renders no settlement rows when nothing has settled yet', async () => {
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      expect(screen.queryByTestId('swap-settled-notes')).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-reclaimed-notes')).not.toBeInTheDocument();
    });

    it('picks the notes up when settlement lands while the page is open', async () => {
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();
      expect(screen.queryByTestId('swap-settled-notes')).not.toBeInTheDocument();

      // Auto-consume completes after the page mounted.
      mockGetSwapSettlementNotes.mockResolvedValue({ settled: ['note-late'], reclaimed: [] });
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      await flush();

      expect(screen.getByTestId('swap-settled-notes').textContent).toBe('note-late');
    });

    it('does not poll for settlement notes on a swap with no order id', async () => {
      mockGetTransactionById.mockResolvedValue(swapTx({ requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();
      mockGetSwapSettlementNotes.mockClear();

      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });

      expect(mockGetSwapSettlementNotes).not.toHaveBeenCalled();
    });
  });

  describe('failed transactions: error card, retry & cancel', () => {
    const STATUS_FAILED = 3;
    const STATUS_QUEUED = 0;

    const failedSendTx = (overrides: Tx = {}): Tx => ({
      ...baseSendTx,
      status: STATUS_FAILED,
      displayMessage: 'Failed',
      displayIcon: 'FAILED',
      error: 'Remote prover failed — this is most often caused by a timeout. Please try again.',
      rawError: 'Error: fetch timeout after 30000ms',
      ...overrides
    });

    it('shows the friendly failure reason with a toggleable raw-error disclosure', async () => {
      mockGetTransactionById.mockResolvedValue(failedSendTx());
      await renderAndLoad();

      const errorCard = Array.from(document.querySelectorAll('[data-testid="detail-card"]')).find(
        el => el.getAttribute('data-title') === 'error'
      )!;
      expect(errorCard).toBeTruthy();
      expect(errorCard.textContent).toContain('Remote prover failed');

      // Raw error hidden until the disclosure is toggled.
      expect(errorCard.textContent).not.toContain('fetch timeout');
      fireEvent.click(screen.getByText('showFullError'));
      expect(errorCard.textContent).toContain('Error: fetch timeout after 30000ms');
      fireEvent.click(screen.getByText('hideFullError'));
      expect(errorCard.textContent).not.toContain('fetch timeout');
    });

    it('omits the raw-error disclosure when no rawError was persisted', async () => {
      mockGetTransactionById.mockResolvedValue(failedSendTx({ rawError: undefined, error: 'Note is invalid' }));
      await renderAndLoad();

      expect(screen.queryByText('showFullError')).toBeNull();
      expect(screen.getByText('Note is invalid')).toBeInTheDocument();
    });

    it('retries a failed send: re-queues the row, nudges the SW and navigates to the progress page', async () => {
      mockGetTransactionById.mockResolvedValue(failedSendTx());
      await renderAndLoad();

      fireEvent.click(screen.getByText('retry'));
      await flush();

      expect(mockRequeueFailedTransaction).toHaveBeenCalledWith('tx-1');
      expect(mockRequestSWTransactionProcessing).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/tx-1');
    });

    it('surfaces a retry failure inline and does not navigate', async () => {
      mockGetTransactionById.mockResolvedValue(failedSendTx());
      mockRequeueFailedTransaction.mockRejectedValue(new Error('row is gone'));
      await renderAndLoad();

      fireEvent.click(screen.getByText('retry'));
      await flush();

      expect(screen.getByText('row is gone')).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('offers no retry for a failed structural Guardian op', async () => {
      mockGetTransactionById.mockResolvedValue(failedSendTx({ type: 'replace-hot-key' }));
      await renderAndLoad();

      expect(screen.queryByText('retry')).toBeNull();
    });

    it('renders a user-cancelled tx with the cancelled pill and no retry button', async () => {
      mockGetTransactionById.mockResolvedValue(
        failedSendTx({ error: 'Transaction was cancelled by user', rawError: undefined })
      );
      await renderAndLoad();

      expect(screen.getByTestId('status-pill').getAttribute('data-cancelled')).toBe('true');
      // The failure card is titled "cancelled" and retry is suppressed.
      const cancelledCard = Array.from(document.querySelectorAll('[data-testid="detail-card"]')).find(
        el => el.getAttribute('data-title') === 'cancelled'
      );
      expect(cancelledCard).toBeTruthy();
      expect(screen.queryByText('retry')).toBeNull();
    });

    it('falls back to initiatedAt for the date of a row that never completed', async () => {
      mockGetTransactionById.mockResolvedValue(failedSendTx({ completedAt: undefined, initiatedAt: 1_600_000_000 }));
      await renderAndLoad();

      expect(rowByLabel('date')!.textContent).toContain('formatted:1600000000');
    });

    it('cancels a still-queued tx with the user-cancelled sentinel and reloads the row', async () => {
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx, status: STATUS_QUEUED, error: undefined });
      await renderAndLoad();

      fireEvent.click(screen.getByText('cancel'));
      await flush();

      expect(mockCancelTransactionById).toHaveBeenCalledWith('tx-1', 'Transaction was cancelled by user');
      // The row is re-fetched after the cancel lands.
      expect(mockGetTransactionById.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('shows the cancel failure inline when cancelling throws', async () => {
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx, status: STATUS_QUEUED, error: undefined });
      mockCancelTransactionById.mockRejectedValue(new Error('cancel exploded'));
      await renderAndLoad();

      fireEvent.click(screen.getByText('cancel'));
      await flush();

      expect(screen.getByText('cancel exploded')).toBeInTheDocument();
    });
  });

  describe('bridge details', () => {
    const bridgedSendTx: Tx = {
      ...baseSendTx,
      id: 'bridge-out',
      type: 'bridged-send',
      displayMessage: 'Bridged to EVM',
      extraInputs: {
        provider: 'epoch',
        destinationAddress: '0xdest',
        destinationNetwork: 8453,
        claimStatus: 'not-applicable',
        outputAmount: '8.99',
        outputSymbol: 'USDC',
        epochStatus: 'confirmed'
      }
    };

    const bridgedReceiveTx: Tx = {
      ...baseSendTx,
      id: 'bridge-in',
      type: 'bridged-receive',
      secondaryAccountId: undefined,
      displayMessage: 'Bridging from EVM',
      extraInputs: {
        provider: 'epoch',
        sourceAddress: '0xffffffffffffffffffffffffffffffffffffffff',
        sourceAmount: '10',
        sourceSymbol: 'USDC',
        evmTxHash: '0xevmhash',
        phase: 'delivering',
        outputAmount: '9.98',
        outputSymbol: 'USDC'
      }
    };

    it('shows the claim section and bridge status pill for an outbound bridge', async () => {
      mockGetTransactionById.mockResolvedValue(bridgedSendTx);
      await renderAndLoad({ transactionId: 'bridge-out' });

      expect(screen.getByTestId('bridge-claim-section')).toBeInTheDocument();
      expect(screen.getByText('confirmed')).toBeInTheDocument();
      // The bridged "to" is the EVM destination — no Miden to-row.
      expect(rowByLabel('to')).toBeUndefined();
    });

    it('renders an in-flight inbound bridge with EVM source, route and pending note', async () => {
      mockGetTransactionById.mockResolvedValue(bridgedReceiveTx);
      await renderAndLoad({ transactionId: 'bridge-in' });

      // From = the EVM source address (Sepolia link), to = our Miden account.
      const fromRow = rowByLabel('from');
      expect(fromRow?.textContent).toContain('0xffffffffffffffffffffffffffffffffffffffff');
      expect(rowByLabel('to')?.textContent).toContain('you (Mine)');

      // Inbound bridge details card: Fast route, EVM tx hash, note still pending.
      expect(screen.getByText('fastRouteLabel')).toBeInTheDocument();
      expect(screen.getByText('0xevmhash')).toBeInTheDocument();
      expect(rowByLabel('noteId')?.textContent).toContain('pending');
      // Outbound-only claim section stays hidden.
      expect(screen.queryByTestId('bridge-claim-section')).not.toBeInTheDocument();
    });

    it('renders a delivered inbound bridge with its Miden note id and slow-route label', async () => {
      mockGetTransactionById.mockResolvedValue({
        ...bridgedReceiveTx,
        extraInputs: {
          ...(bridgedReceiveTx.extraInputs as Record<string, unknown>),
          provider: 'agglayer',
          phase: 'received',
          midenNoteId: '0xminednote'
        }
      });
      await renderAndLoad({ transactionId: 'bridge-in' });

      expect(screen.getByText('slowRouteLabel')).toBeInTheDocument();
      expect(screen.getByText('0xminednote')).toBeInTheDocument();
      expect(screen.getByText('confirmed')).toBeInTheDocument();
    });

    it('surfaces the failure reason for a failed inbound bridge', async () => {
      mockGetTransactionById.mockResolvedValue({
        ...bridgedReceiveTx,
        error: 'The Epoch bridge intent failed.',
        extraInputs: {
          ...(bridgedReceiveTx.extraInputs as Record<string, unknown>),
          phase: 'failed',
          error: 'The Epoch bridge intent failed.'
        }
      });
      await renderAndLoad({ transactionId: 'bridge-in' });

      expect(screen.getByText('bridgeFailed')).toBeInTheDocument();
      expect(screen.getByText('The Epoch bridge intent failed.')).toBeInTheDocument();
    });
  });
});

// Smart Withdraw detail: the hero must show the same side as the activity row
// (source USDC in flight, destination asset once delivered), and retry must be
// offered for ANY failed withdrawal — it resubmits a brand-new Epoch intent
// rather than re-polling the dead nonce, so a missing nonce is not a blocker.
describe('HistoryDetails earn-withdraw', () => {
  const earnWithdrawTx = (extraInputs: Record<string, unknown>, overrides: Tx = {}): Tx => ({
    ...baseSendTx,
    id: 'tx-1',
    type: 'earn-withdraw',
    faucetId: 'faucet-1',
    displayMessage: 'Withdraw from Earn',
    displayIcon: 'DEFAULT',
    extraInputs: {
      phase: 'redeeming',
      evmOwner: '0x1111111111111111111111111111111111111111',
      marketUid: 'DUMMY_LENDING:11155111:0xunderlying',
      sourceAmount: '10.50',
      sourceSymbol: 'USDC',
      ...extraInputs
    },
    ...overrides
  });

  beforeEach(() => {
    mockRetryEarnWithdrawReceive.mockClear();
    mockRetryEarnWithdrawReceive.mockResolvedValue(undefined);
  });

  it('shows the redeemed source side while the withdrawal is still in flight', async () => {
    mockGetTransactionById.mockResolvedValue(earnWithdrawTx({ phase: 'delivering' }, { amount: 999n }));
    await renderAndLoad();

    expect(document.body.textContent).toContain('10.5');
    expect(document.body.textContent).toContain('USDC');
  });

  it('switches to the delivered destination amount once the note is received', async () => {
    mockGetTransactionById.mockResolvedValue(
      earnWithdrawTx({ phase: 'received', outputSymbol: 'MDN' }, { amount: 999n })
    );
    await renderAndLoad();

    // The source figure is no longer what the hero claims.
    expect(document.body.textContent).not.toContain('10.5');
  });

  it('offers retry on a failed withdrawal that never recorded a nonce', async () => {
    mockGetTransactionById.mockResolvedValue(
      earnWithdrawTx({ phase: 'failed', error: 'boom', withdrawIntentNonce: undefined })
    );
    await renderAndLoad();

    fireEvent.click(screen.getByText('retry'));
    await flush();

    // Full resubmission, not a re-queue of a Miden row.
    expect(mockRetryEarnWithdrawReceive).toHaveBeenCalledWith('tx-1');
    expect(mockRequeueFailedTransaction).not.toHaveBeenCalled();
    // The row is reused in place, so the page reloads rather than navigating.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('offers retry on a failed withdrawal that does have a nonce', async () => {
    mockGetTransactionById.mockResolvedValue(
      earnWithdrawTx({ phase: 'failed', error: 'boom', withdrawIntentNonce: 'DEAD' })
    );
    await renderAndLoad();

    fireEvent.click(screen.getByText('retry'));
    await flush();

    expect(mockRetryEarnWithdrawReceive).toHaveBeenCalledWith('tx-1');
  });

  it('offers no retry while the withdrawal is still progressing', async () => {
    mockGetTransactionById.mockResolvedValue(earnWithdrawTx({ phase: 'delivering' }));
    await renderAndLoad();

    expect(screen.queryByText('retry')).toBeNull();
  });

  it('surfaces a resubmission failure inline', async () => {
    mockGetTransactionById.mockResolvedValue(earnWithdrawTx({ phase: 'failed', error: 'boom' }));
    mockRetryEarnWithdrawReceive.mockRejectedValue(new Error('epoch is down'));
    await renderAndLoad();

    fireEvent.click(screen.getByText('retry'));
    await flush();

    expect(screen.getByText('epoch is down')).toBeInTheDocument();
  });
});
