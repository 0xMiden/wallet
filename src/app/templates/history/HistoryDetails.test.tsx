import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import { REMOTE_PROVER_FAILED_ERROR } from 'lib/miden/transaction/constants';

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
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
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

// The earn detail pages start their own Epoch pollers through a dynamic
// `import('lib/epoch')`; stub it so the test never loads the real (ESM,
// network-bound) intent SDK.
const mockPollEarnWithdrawDelivery = jest.fn();
const mockPollEarnIntentStatus = jest.fn();

jest.mock('lib/epoch', () => ({
  pollEarnWithdrawDelivery: (...args: unknown[]) => mockPollEarnWithdrawDelivery(...args),
  pollEarnIntentStatus: (...args: unknown[]) => mockPollEarnIntentStatus(...args)
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

jest.mock('components/GuardianTransitionHero', () => ({
  GuardianTransitionHero: ({
    previousEndpoint,
    newEndpoint,
    previousLabel,
    newLabel
  }: {
    previousEndpoint?: string;
    newEndpoint?: string;
    previousLabel: string;
    newLabel: string;
  }) => (
    <div
      data-testid="guardian-transition-hero"
      data-previous={previousEndpoint ?? 'unknown'}
      data-new={newEndpoint ?? 'unknown'}
      data-previous-label={previousLabel}
      data-new-label={newLabel}
    />
  )
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
  describe('Guardian switch details', () => {
    it('renders the From/To hero, status, generic details, and no wallet destination rows', async () => {
      mockGetTransactionById.mockResolvedValue({
        ...baseSendTx,
        type: 'switch-guardian',
        displayMessage: 'Guardian switched',
        displayIcon: 'DEFAULT',
        secondaryAccountId: 'misleading-wallet-address',
        amount: undefined,
        faucetId: undefined,
        outputNoteIds: undefined,
        extraInputs: {
          previousGuardianEndpoint: 'https://old.example',
          newGuardianEndpoint: 'https://new.example'
        }
      });
      await renderAndLoad();

      const hero = screen.getByTestId('guardian-transition-hero');
      expect(hero).toHaveAttribute('data-previous', 'https://old.example');
      expect(hero).toHaveAttribute('data-new', 'https://new.example');
      expect(hero).toHaveAttribute('data-previous-label', 'from');
      expect(hero).toHaveAttribute('data-new-label', 'to');
      expect(screen.getByTestId('status-pill')).toHaveAttribute('data-status', String(STATUS_COMPLETED));
      expect(screen.queryByTestId('tx-icon')).toBeNull();
      expect(screen.getByTestId('detail-card')).toHaveAttribute('data-title', 'details');
      expect(rowByLabel('date')).toBeDefined();
      expect(rowByLabel('txIdLabel')).toBeDefined();
      expect(rowByLabel('from')).toBeUndefined();
      expect(rowByLabel('to')).toBeUndefined();
    });

    it('keeps legacy metadata readable with an unknown source', async () => {
      mockGetTransactionById.mockResolvedValue({
        ...baseSendTx,
        type: 'switch-guardian',
        transactionId: undefined,
        amount: undefined,
        faucetId: undefined,
        outputNoteIds: undefined,
        extraInputs: { newGuardianEndpoint: 'https://new.example' }
      });
      await renderAndLoad();

      expect(screen.getByTestId('guardian-transition-hero')).toHaveAttribute('data-previous', 'unknown');
      expect(screen.getByTestId('guardian-transition-hero')).toHaveAttribute('data-new', 'https://new.example');
      expect(rowByLabel('txIdLabel')?.textContent).toContain('tx-1');
    });
  });

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
      // ID line echoes the transactionId (interpolated into the label key).
      expect(screen.getByText('historyDetailsIdLabel_tx-1')).toBeInTheDocument();
      expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    });

    it('falls back to a generic message when the thrown value is not an Error', async () => {
      mockGetTransactionById.mockRejectedValue('a plain string');
      await renderAndLoad();
      expect(screen.getByText('historyDetailsLoadError')).toBeInTheDocument();
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
      // Fiat: |1000| * price(2) => 2000.00, interpolated into the fiat key.
      expect(screen.getByText('historyDetailsFiatApprox_$2000.00')).toBeInTheDocument();

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

    it('swaps from/to for an inbound transaction and hides optional rows when data is absent', async () => {
      mockGetTransactionById.mockResolvedValue({
        ...baseSendTx,
        type: 'consume',
        displayMessage: 'Received',
        transactionId: undefined, // no external tx id row
        amount: 0n, // falsy → amount undefined → no amount span / no fiat
        faucetId: undefined, // no metadata → token undefined
        outputNoteIds: ['note-x'] // still has note data
      });
      await renderAndLoad();

      // Inbound: from = secondaryAccountId (acct-B, the note sender), to = accountId (acct-A).
      expect(rowByLabel('from')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute(
        'data-address',
        'acct-B'
      );
      expect(rowByLabel('to')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-address', 'acct-A');

      // No external tx id row.
      expect(rowByLabel('txIdLabel')).toBeUndefined();
      // No amount span (amount undefined) → fiat also absent.
      expect(screen.queryByText('historyDetailsFiatApprox_$2000.00')).not.toBeInTheDocument();
    });

    it.each([
      ['queued', 'Sending'],
      ['cancelled', 'Failed']
    ])('keeps From/To pointing outward on a %s send', async (_label, displayMessage) => {
      // `cancelTransaction` overwrites `displayMessage` with 'Failed', and a send
      // reads 'Sending' until it completes. Direction must come from the type, or
      // both of those render "From: <recipient> / To: <your own account>".
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx, displayMessage });
      await renderAndLoad();

      expect(rowByLabel('from')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute(
        'data-address',
        'acct-A'
      );
      expect(rowByLabel('to')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-address', 'acct-B');
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
      expect(screen.queryByText(/historyDetailsFiatApprox/)).not.toBeInTheDocument();
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
      // There is deliberately no fill-count meter: the lineage only tells us
      // how much remains, not how many fills the order will ultimately need.
      expect(screen.queryByTestId('swap-order-fill-rounds')).not.toBeInTheDocument();
      // filledRequested = 1000 - 400 = 600, so the amount bar is 60%.
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_600_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');

      // Registry hit → requested-faucet metadata NOT fetched (only the tx faucet was).
      expect(mockGetTokenMetadata).toHaveBeenCalledTimes(1);
      expect(mockGetTokenMetadata).toHaveBeenCalledWith('faucet-1');
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
      expect(screen.queryByText('cancel')).not.toBeInTheDocument();
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
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_0_0_');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
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
        swapTx({
          orderId: 9n,
          requestedFaucetId: 'req-faucet',
          requestedAmount: 1000n,
          autoConsume: false
        })
      );
      await renderAndLoad();

      // First poll → active.
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusActive');
      fireEvent.click(screen.getByText('swapOpenPendingNotes'));
      expect(mockNavigate).toHaveBeenCalledWith('/pending-notes');

      // Active schedules another poll at the base interval (2s).
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      await flush();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusFilled');
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
      expect(mockTrackOrderId).toHaveBeenCalledTimes(2);
    });

    it('shows the loading label while the first poll is in flight', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockReturnValue(new Promise(() => {})); // never resolves
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 5n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('loading');
      expect(screen.getByText('swapMatchingDex')).toBeInTheDocument();
    });

    it('shows a steady tracking indicator while the order is active', async () => {
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

      // The order is active, so the tracking indicator shows steadily — not only
      // while a poll is momentarily in flight (that per-poll flicker was #486).
      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusActive');
      expect(screen.getByText('swapMatchingDex')).toBeInTheDocument();
      // autoConsume defaults on, so this swap never needs the Pending Notes shortcut.
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();

      // It stays put across the next background poll rather than blinking off/on.
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(screen.getByText('swapMatchingDex')).toBeInTheDocument();

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

      expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusFilled');
    });

    it('reconciles to Filled once settlement notes are seen locally, even if the lineage still reports active (#486)', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      // The on-chain lineage lags — it keeps reporting the order as still active...
      mockTrackOrderId.mockResolvedValue({
        orderId: '10',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 700n
      });
      // ...but this wallet has already observed the settlement consume note.
      mockGetSwapSettlementNotes.mockResolvedValue({ settled: ['note-x'], reclaimed: [] });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 10n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      // Local settlement is the source of truth: show Filled and drop the spinner
      // instead of sitting on "Active" with a flickering loader.
      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusFilled');
      expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
    });

    it('reconciles to Reclaimed when the local settlement is a reclaim (#486)', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '11',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 700n
      });
      mockGetSwapSettlementNotes.mockResolvedValue({ settled: [], reclaimed: ['note-r'] });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 11n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusReclaimed');
      expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
    });

    it('treats a mixed settle+reclaim order as Filled — a settle consume outranks a reclaim (#486)', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '12',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 700n
      });
      // Paybacks settled in one consume tick, the tip reclaimed in another — both
      // buckets are non-empty. The swap-row chip stamps "Settled" (funds received),
      // so this row must agree rather than showing "Reclaimed".
      mockGetSwapSettlementNotes.mockResolvedValue({ settled: ['note-s'], reclaimed: ['note-r'] });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 12n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusFilled');
      expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
    });

    it('backs off on unresolved polls and gives up after the cap', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue(null); // never resolves the order
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 3n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      // First poll already ran during load.
      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('trackingUnavailable');

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
      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('trackingUnavailable');
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

    it('renders the swap receipt without polling when the transaction carries no order id', async () => {
      // The transaction can still be inspected while its order id is absent.
      mockGetTransactionById.mockResolvedValue(swapTx({ requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();
      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
      expect(mockTrackOrderId).not.toHaveBeenCalled();
    });

    it('renders a zero-state receipt for a swap with entirely absent extraInputs', async () => {
      mockGetTransactionById.mockResolvedValue({ ...swapTx({}), extraInputs: undefined });
      await renderAndLoad();
      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      expect(screen.getByTestId('swap-order-amount-filled')).toHaveTextContent('swapAmountProgress_0_0_');
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
      expect(
        Array.from(screen.getByTestId('swap-settled-notes').querySelectorAll('[data-testid="hash-chip"]')).map(
          note => note.textContent
        )
      ).toEqual(['note-a', 'note-b']);
      expect(
        Array.from(screen.getByTestId('swap-reclaimed-notes').querySelectorAll('[data-testid="hash-chip"]')).map(
          note => note.textContent
        )
      ).toEqual(['note-c']);
      // The card renders even though the swap itself created no output notes.
      expect(screen.queryByText('claimed')).not.toBeInTheDocument();
      expect(screen.getByText('swapFillNote_1')).toBeInTheDocument();
      expect(screen.getByText('swapFillNote_2')).toBeInTheDocument();
      expect(screen.getByText('reclaimed')).toBeInTheDocument();
    });

    it('shows the fill amount, consumed time, swap tx id and consume tx id from settlement metadata', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-local-1',
            transactionId: 'consume-chain-1',
            noteIds: ['note-a'],
            amount: 685n,
            faucetId: 'req-faucet',
            completedAt: 1_700_000_120
          }
        ],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue({
        ...swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }),
        transactionId: 'swap-chain-1'
      });

      await renderAndLoad();

      expect(screen.getByText('swapReceivedAmount_685_ ETH')).toBeInTheDocument();
      expect(screen.getByText(/^swapConsumedAt_/)).toBeInTheDocument();
      expect(rowByLabel('txIdLabel')).toHaveTextContent('swap-chain-1');
      expect(rowByLabel('consumeTxId')).toHaveTextContent('consume-chain-1');
      expect(rowByLabel('from')).toHaveTextContent('you (Mine)');
      expect(screen.queryByText('cancel')).not.toBeInTheDocument();
    });

    it('omits the received amount when the consume settled a different faucet than the requested token', async () => {
      // An expired order consumes its requested-token paybacks together with the
      // offered-token tip, and the consume's amount covers only its first input
      // note's faucet — so it can be the offered remainder, which must not be
      // relabelled as funds received in the requested token.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-local-1',
            transactionId: 'consume-chain-1',
            noteIds: ['note-a'],
            amount: 685n,
            faucetId: 'offered-faucet',
            completedAt: 1_700_000_120
          }
        ],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.queryByText(/^swapReceivedAmount_/)).toBeNull();
      // The row itself still lists what the consume claimed.
      expect(screen.getByTestId('swap-settled-notes')).toHaveTextContent('note-a');
    });

    it('derives the filled amount from the settled consumes when the lineage is unresolvable', async () => {
      // A reinstalled or restored wallet can no longer track the order, so the
      // lineage poll returns null. The fill has to come from what this wallet
      // actually consumed rather than from a 0% bar under a "Filled" label.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue(null);
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a', 'note-b'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-1',
            transactionId: 'chain-1',
            noteIds: ['note-a'],
            amount: 400n,
            faucetId: 'req-faucet',
            completedAt: 1_700_000_100
          },
          {
            id: 'consume-2',
            transactionId: 'chain-2',
            noteIds: ['note-b'],
            amount: 200n,
            faucetId: 'req-faucet',
            completedAt: 1_700_000_200
          }
        ],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_600_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    });

    it('never claims a full fill for a partially filled order that settled at expiry', async () => {
      // An expiry batch carrying any payback is tagged 'settle', so a PARTIAL
      // fill reaches `settledOrderState === 'filled'`. Assuming the requested
      // amount there would print a confident, wrong figure on the receipt.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue(null);
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['payback-note'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-1',
            transactionId: 'chain-1',
            noteIds: ['payback-note', 'tip-note'],
            amount: 300n,
            faucetId: 'req-faucet',
            completedAt: 1_700_000_100
          }
        ],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_300_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
    });

    it('leaves the fill unknown rather than assumed when no settled consume delivered the requested token', async () => {
      // Offered-token tip only: nothing was received in the requested token, so
      // the receipt must not synthesise a filled amount from the request.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue(null);
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['tip-note'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-1',
            transactionId: 'chain-1',
            noteIds: ['tip-note'],
            amount: 500n,
            faucetId: 'offered-faucet',
            completedAt: 1_700_000_100
          }
        ],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_0_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    });

    it('resolves the offered side through the swap registry so the hero is not misscaled', async () => {
      // The DEX faucets are usually absent from assetsMetadata, so the generic
      // getTokenMetadata resolves the OFFERED side to Unknown at 6 decimals
      // while the registry says 8. Reading the metadata decimals here scales the
      // hero amount 100x. Encode the decimals into the formatter output so the
      // scale, not just the symbol, is observable in the rendered hero.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatAmount } = require('lib/shared/format');
      formatAmount.mockImplementation((amount: bigint, decimals?: number) => `${amount}@${decimals}`);
      mockGetSwapTokenByFaucetId.mockImplementation((id: string | undefined) =>
        id === 'faucet-1' ? { symbol: 'IETH', decimals: 8 } : { symbol: 'ETH', decimals: 8 }
      );
      mockGetTransactionById.mockResolvedValue({
        ...swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }),
        amount: 500n
      });

      await renderAndLoad();

      const hero = screen.getByTestId('swap-order-card').textContent ?? '';
      expect(hero).toContain('500@8');
      expect(hero).toContain('IETH');
      expect(hero).not.toContain('500@6');
      expect(hero).not.toContain('MID');
    });

    it('surfaces the failure reason and the raw error for a failed swap', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockGetTransactionById.mockResolvedValue({
        ...swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }),
        status: 3,
        error: 'Swap request rejected',
        rawError: 'Error: note script failed at cycle 4211'
      });

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      expect(screen.getByTestId('history-failure-reason')).toHaveTextContent('Swap request rejected');
      fireEvent.click(screen.getByText('showFullError'));
      expect(screen.getByText('Error: note script failed at cycle 4211')).toBeInTheDocument();
    });

    it('omits the reclaimed row when the order only settled', async () => {
      mockGetSwapSettlementNotes.mockResolvedValue({ settled: ['note-a'], reclaimed: [] });
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-settled-notes')).toHaveTextContent('note-a');
      expect(screen.queryByTestId('swap-reclaimed-notes')).not.toBeInTheDocument();
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

      expect(screen.getByTestId('swap-settled-notes')).toHaveTextContent('note-late');
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
      error: REMOTE_PROVER_FAILED_ERROR,
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
      expect(errorCard.textContent).toContain(REMOTE_PROVER_FAILED_ERROR);

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

    // A bridge row created before the amount/quote were stamped still has to
    // render a hero rather than blanking out.
    it('falls back to an em dash on both sides when no amount is known', async () => {
      mockGetTransactionById.mockResolvedValue({
        ...bridgedSendTx,
        amount: undefined,
        extraInputs: { provider: 'epoch', destinationAddress: '0xdest', claimStatus: 'not-applicable' }
      });
      await renderAndLoad({ transactionId: 'bridge-out' });

      // Both the "in" amount and the (absent) "out" amount collapse to the dash.
      expect(document.body.textContent?.match(/—/g)?.length).toBeGreaterThanOrEqual(2);
    });

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
    mockPollEarnWithdrawDelivery.mockClear();
    mockPollEarnWithdrawDelivery.mockResolvedValue(undefined);
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

  it('renders the full withdraw detail card once the intent, settlement tx and note are known', async () => {
    mockGetTransactionById.mockResolvedValue(
      earnWithdrawTx(
        {
          phase: 'delivering',
          withdrawIntentNonce: 'NONCE-1',
          evmTxHash: '0xfeed',
          midenNoteId: 'note-delivered'
        },
        // No Miden tx id, so `txIdLabel` unambiguously belongs to the Sepolia row.
        { transactionId: undefined }
      )
    );
    await renderAndLoad();

    // Market shows only the protocol segment of the `PROTOCOL:chainId:token` uid.
    expect(rowByLabel('earnMarketLabel')?.textContent).toBe('DUMMY_LENDING');
    expect(rowByLabel('positionOwnerLabel')?.textContent).toContain('0x1111111111111111111111111111111111111111');
    expect(rowByLabel('redeemIntentLabel')?.textContent).toContain('NONCE-1');
    expect(rowByLabel('txIdLabel')?.querySelector('a')).toHaveAttribute(
      'href',
      'https://sepolia.etherscan.io/tx/0xfeed'
    );
    expect(rowByLabel('note')?.textContent).toContain('note-delivered');
  });

  it('falls back to the raw market uid when it has no protocol segment', async () => {
    mockGetTransactionById.mockResolvedValue(earnWithdrawTx({ phase: 'redeeming', marketUid: ':11155111:0xabc' }));
    await renderAndLoad();

    expect(rowByLabel('earnMarketLabel')?.textContent).toBe(':11155111:0xabc');
  });

  it('shows the note row as pending until the bridged note lands', async () => {
    mockGetTransactionById.mockResolvedValue(earnWithdrawTx({ phase: 'redeeming' }));
    await renderAndLoad();

    expect(rowByLabel('note')?.textContent).toBe('pending');
    expect(rowByLabel('redeemIntentLabel')).toBeUndefined();
  });

  // The initiating context's poller dies with its popup, so an in-flight detail
  // page restarts one — exactly once per nonce — and reloads the row on a timer.
  it('restarts the delivery poller once per nonce and reloads the row on the interval', async () => {
    mockGetTransactionById.mockResolvedValue(earnWithdrawTx({ phase: 'delivering', withdrawIntentNonce: 'NONCE-1' }));
    await renderAndLoad();

    expect(mockPollEarnWithdrawDelivery).toHaveBeenCalledWith({
      sponsorAddress: '0x1111111111111111111111111111111111111111',
      nonce: 'NONCE-1',
      txId: 'tx-1'
    });

    const loadsAfterMount = mockGetTransactionById.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await flush();

    expect(mockGetTransactionById.mock.calls.length).toBeGreaterThan(loadsAfterMount);
    // Still one poller — the nonce ref suppresses a restart on every reload.
    expect(mockPollEarnWithdrawDelivery).toHaveBeenCalledTimes(1);
  });

  it('does not start a poller for a non-EVM owner', async () => {
    mockGetTransactionById.mockResolvedValue(
      earnWithdrawTx({ phase: 'delivering', withdrawIntentNonce: 'NONCE-1', evmOwner: 'not-an-address' })
    );
    await renderAndLoad();

    expect(mockPollEarnWithdrawDelivery).not.toHaveBeenCalled();
  });

  it('does not poll once the withdrawal is delivered', async () => {
    mockGetTransactionById.mockResolvedValue(
      earnWithdrawTx({ phase: 'received', withdrawIntentNonce: 'NONCE-1' }, { amount: 999n })
    );
    await renderAndLoad();

    expect(mockPollEarnWithdrawDelivery).not.toHaveBeenCalled();
  });

  it('reports a poller that fails to start without breaking the page', async () => {
    mockPollEarnWithdrawDelivery.mockRejectedValue(new Error('poller down'));
    mockGetTransactionById.mockResolvedValue(earnWithdrawTx({ phase: 'delivering', withdrawIntentNonce: 'NONCE-1' }));
    await renderAndLoad();

    expect(console.warn).toHaveBeenCalledWith('[earn-withdraw] detail-page poll start failed', expect.any(Error));
    expect(rowByLabel('earnMarketLabel')).toBeDefined();
  });
});

// Smart Deposit detail: the row goes database-Completed as soon as the Miden
// collateral note lands, so the pill and the poller both track the separate,
// solver-fulfilled lending leg (`extraInputs.epochStatus`) instead.
describe('HistoryDetails earn-deposit', () => {
  const earnDepositTx = (extraInputs: Record<string, unknown> = {}, overrides: Tx = {}): Tx => ({
    ...baseSendTx,
    id: 'tx-1',
    type: 'earn-deposit',
    faucetId: 'faucet-1',
    displayMessage: 'Depositing',
    displayIcon: 'DEFAULT',
    status: STATUS_COMPLETED,
    extraInputs: {
      evmRecipient: '0x2222222222222222222222222222222222222222',
      marketUid: 'DUMMY_LENDING:11155111:0xunderlying',
      sourceFaucetId: 'faucet-1',
      ...extraInputs
    },
    ...overrides
  });

  beforeEach(() => {
    mockPollEarnIntentStatus.mockClear();
    mockPollEarnIntentStatus.mockResolvedValue(undefined);
  });

  it('renders the deposit detail card with the intent nonce and Sepolia settlement tx', async () => {
    mockGetTransactionById.mockResolvedValue(
      // No Miden tx id, so `txIdLabel` unambiguously belongs to the Sepolia row.
      earnDepositTx(
        { intentNonce: 'DEP-1', evmTxHash: '0xbeef', epochStatus: 'confirmed' },
        { transactionId: undefined }
      )
    );
    await renderAndLoad();

    expect(rowByLabel('earnMarketLabel')?.textContent).toBe('DUMMY_LENDING');
    expect(rowByLabel('positionOwnerLabel')?.querySelector('a')).toHaveAttribute(
      'href',
      'https://sepolia.etherscan.io/address/0x2222222222222222222222222222222222222222'
    );
    expect(rowByLabel('depositIntentLabel')?.textContent).toContain('DEP-1');
    expect(rowByLabel('txIdLabel')?.querySelector('a')).toHaveAttribute(
      'href',
      'https://sepolia.etherscan.io/tx/0xbeef'
    );
  });

  it('falls back to the raw market uid when it has no protocol segment', async () => {
    mockGetTransactionById.mockResolvedValue(earnDepositTx({ marketUid: ':11155111:0xabc' }));
    await renderAndLoad();

    expect(rowByLabel('earnMarketLabel')?.textContent).toBe(':11155111:0xabc');
  });

  it('omits the intent and settlement rows before the lending leg reports them', async () => {
    mockGetTransactionById.mockResolvedValue(earnDepositTx({}, { transactionId: undefined }));
    await renderAndLoad();

    expect(rowByLabel('depositIntentLabel')).toBeUndefined();
    expect(rowByLabel('txIdLabel')).toBeUndefined();
    // Position owner is then the card's last row.
    expect(rowByLabel('positionOwnerLabel')).toHaveAttribute('data-islast', 'true');
  });

  // The generic StatusPill would read "Completed" the moment the Miden note
  // lands, which is misleading while the lending leg is still unsettled.
  it.each([
    ['pending', undefined],
    ['pending', 'pending'],
    ['confirmed', 'confirmed'],
    ['failed', 'failed']
  ])('shows the lending-leg pill as %s', async (label, epochStatus) => {
    mockGetTransactionById.mockResolvedValue(earnDepositTx(epochStatus ? { epochStatus } : {}));
    await renderAndLoad();

    expect(screen.queryByTestId('status-pill')).toBeNull();
    expect(document.body.textContent).toContain(label);
  });

  it('falls back to the Miden status pill until the collateral note lands', async () => {
    // Status 1 === GeneratingTransaction: the deposit hasn't reached Miden yet.
    mockGetTransactionById.mockResolvedValue(earnDepositTx({ epochStatus: 'pending' }, { status: 1 }));
    await renderAndLoad();

    expect(screen.getByTestId('status-pill')).toHaveAttribute('data-status', '1');
  });

  it('restarts the lending-leg poller once per nonce and reloads the row on the interval', async () => {
    mockGetTransactionById.mockResolvedValue(earnDepositTx({ intentNonce: 'DEP-1' }));
    await renderAndLoad();

    expect(mockPollEarnIntentStatus).toHaveBeenCalledWith({
      sponsorAddress: '0x2222222222222222222222222222222222222222',
      nonce: 'DEP-1',
      txId: 'tx-1'
    });

    const loadsAfterMount = mockGetTransactionById.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await flush();

    expect(mockGetTransactionById.mock.calls.length).toBeGreaterThan(loadsAfterMount);
    expect(mockPollEarnIntentStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the lending leg already settled', { intentNonce: 'DEP-1', epochStatus: 'confirmed' }, {}],
    ['the lending leg already failed', { intentNonce: 'DEP-1', epochStatus: 'failed' }, {}],
    ['no intent nonce was recorded', {}, {}],
    ['the recipient is not an EVM address', { intentNonce: 'DEP-1', evmRecipient: 'nope' }, {}],
    ['the Miden note has not landed', { intentNonce: 'DEP-1' }, { status: 1 }]
  ])('does not poll when %s', async (_label, extraInputs, overrides) => {
    mockGetTransactionById.mockResolvedValue(earnDepositTx(extraInputs, overrides));
    await renderAndLoad();

    expect(mockPollEarnIntentStatus).not.toHaveBeenCalled();
  });

  it('reports a poller that fails to start without breaking the page', async () => {
    mockPollEarnIntentStatus.mockRejectedValue(new Error('poller down'));
    mockGetTransactionById.mockResolvedValue(earnDepositTx({ intentNonce: 'DEP-1' }));
    await renderAndLoad();

    expect(console.warn).toHaveBeenCalledWith('[earn-deposit] detail-page poll start failed', expect.any(Error));
    expect(rowByLabel('earnMarketLabel')).toBeDefined();
  });
});
