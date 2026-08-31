import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import {
  REMOTE_PROVER_FAILED_ERROR,
  TRANSACTION_STUCK_ERROR,
  USER_CANCELLED_TRANSACTION_REASON,
  isUserCancelledTransaction
} from 'lib/miden/transaction/constants';

// Imported after the mocks so the module graph is wired to the stubs.
import { HistoryDetails } from './HistoryDetails';

// ---------------------------------------------------------------------------
// Mutable state the mocks read at call time (must be `mock`-prefixed for jest).
// ---------------------------------------------------------------------------
let mockAccount: { publicKey?: string; name?: string } | undefined = { publicKey: 'acct-A', name: 'Mine' };
let mockAllAccounts: Array<{ publicKey: string; name: string }> = [{ publicKey: 'acct-B', name: 'Other' }];
let mockTokenPrices: Record<string, { price: number }> = { MID: { price: 2 } };
let mockPrice = 2;
let mockRow: Tx | undefined;
let mockRowLoaded = true;
let mockSettlementNotes: {
  settled: string[];
  reclaimed: string[];
  settledTransactions: Tx[];
  reclaimedTransactions: Tx[];
} | null = null;

const setMockRow = (row: Tx) => {
  mockRow = row;
};

const setMockSettlementNotes = (notes: {
  settled: string[];
  reclaimed: string[];
  settledTransactions: Tx[];
  reclaimedTransactions: Tx[];
}) => {
  mockSettlementNotes = notes;
};

// ---------------------------------------------------------------------------
// Data / logic dependency mocks.
// ---------------------------------------------------------------------------
const mockRetryEarnWithdrawReceive = jest.fn().mockResolvedValue(undefined);
const mockGetTokenMetadata = jest.fn();
const mockGetSwapTokenByFaucetId = jest.fn();
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockCancelTransactionById = jest.fn();
const mockRequeueFailedTransaction = jest.fn();
const mockRequestSWTransactionProcessing = jest.fn();
const mockIsRequeueableTransaction = jest.fn();
const mockIsUnverifiableSendRetryError = jest.fn((..._args: unknown[]) => false);

const mockT = (key: string, opts?: Record<string, string | number | boolean | undefined>) => {
  const values = opts ? Object.values(opts) : [];
  return values.length > 0 ? `${key}_${values.join('_')}` : key;
};

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT })
}));

jest.mock('lib/miden/activity', () => ({
  cancelTransactionById: (...args: unknown[]) => mockCancelTransactionById(...args),
  requeueFailedTransaction: (...args: unknown[]) => mockRequeueFailedTransaction(...args),
  requestSWTransactionProcessing: (...args: unknown[]) => mockRequestSWTransactionProcessing(...args),
  isRequeueableTransaction: (...args: unknown[]) => mockIsRequeueableTransaction(...args),
  // The REAL predicate: which rows may be cancelled is exactly what these
  // tests assert, so a reimplementation here would assert the mock instead.
  isCancellableTransaction: jest.requireActual('lib/miden/transaction/retry').isCancellableTransaction,
  isUnverifiableSendRetryError: (...args: unknown[]) => mockIsUnverifiableSendRetryError(...args),
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

jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: () => ({ row: mockRow, loaded: mockRowLoaded })
}));

jest.mock('./useSwapSettlementNotes', () => ({
  useSwapSettlementNotes: (swapTxId: string | undefined) => (swapTxId ? mockSettlementNotes : null)
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

jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({ title, onBack }: { title: string; onBack: () => void }) => (
    <div data-testid="screen-header">
      <span data-testid="header-title">{title}</span>
      <button data-testid="back-button" onClick={onBack}>
        back
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
  StatusPill: ({
    status,
    isCancelled,
    swapSettlement
  }: {
    status?: number;
    isCancelled?: boolean;
    swapSettlement?: string;
  }) => (
    <div
      data-testid="status-pill"
      data-status={String(status)}
      data-cancelled={String(!!isCancelled)}
      data-swap-settlement={String(swapSettlement)}
    />
  )
}));

// Sentinel explorer helpers (a NON-testnet host) so the link assertions below
// prove the tx/account links are built from the override-aware explorer helpers
// rather than a hardcoded testnet URL. This is the regression guard for the
// dev-settings explorer-override bug: re-hardcoding `testnet.midenscan.com`
// would make these hrefs mismatch and fail the test.
jest.mock('lib/miden-chain/constants', () => ({
  // `constants` re-exports `./networks-config` (MIDEN_NETWORK_NAME, DEFAULT_NETWORK,
  // …) which the icon module and others rely on — keep them via requireActual and
  // override only the two explorer helpers.
  ...jest.requireActual('lib/miden-chain/constants'),
  getExplorerTxUrl: (hash: string) => `https://custom-explorer.test/tx/${hash}`,
  getExplorerAccountUrl: (address: string) => `https://custom-explorer.test/account/${address}`
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

/**
 * `getSwapSettlementNotes` collects a note id and the consume that claimed it in
 * the same pass, so it never returns one without the other. Fixtures that named
 * ids alone described a shape production cannot produce; give them the owning
 * consume. `amount: undefined` keeps the derived fill unknown, which is what an
 * ids-only fixture already meant.
 */
const settlementNotes = (settled: string[], reclaimed: string[] = []) => ({
  settled,
  reclaimed,
  settledTransactions:
    settled.length > 0
      ? [{ id: 'settle-consume', transactionId: 'ext-settle', noteIds: settled, amount: undefined }]
      : [],
  reclaimedTransactions:
    reclaimed.length > 0
      ? [{ id: 'reclaim-consume', transactionId: 'ext-reclaim', noteIds: reclaimed, amount: undefined }]
      : []
});

interface SeededTracking {
  orderId: string;
  state: 'active' | 'filled' | 'reclaimed';
  currentDepth: number;
  remainingOffered: bigint;
  remainingRequested: bigint;
}

const trackingStore = () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('lib/miden/swap/order-tracking-store');
};

const seedTracking = (tracking: SeededTracking) => {
  act(() => {
    trackingStore().useSwapOrderTrackingStore.getState().setEntry(tracking.orderId, { tracking, loading: false });
  });
};

const seedUnavailable = (orderId: string) => {
  act(() => {
    trackingStore().useSwapOrderTrackingStore.getState().setEntry(orderId, { tracking: null, loading: false });
  });
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

  mockRow = undefined;
  mockRowLoaded = true;
  setMockSettlementNotes(settlementNotes([]));
  trackingStore().useSwapOrderTrackingStore.setState({ entries: {} });
  trackingStore().clearSwapOrderSchedulesForTests();
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
  // Mirror the production predicate: Failed + a re-queueable type.
  mockIsRequeueableTransaction.mockImplementation(
    (tx: { status?: number; type: string }) =>
      tx.status === 3 && ['send', 'consume', 'swap', 'bridged-send', 'execute'].includes(tx.type)
  );
  mockIsUnverifiableSendRetryError.mockReturnValue(false);
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
  describe('private-note delivery warning', () => {
    it('warns on a COMPLETED send whose private note was never delivered', async () => {
      // The status pill answers a different question from this card: the
      // transaction really did land, which is why the row is Completed and must
      // stay that way (Failed would offer a Retry that spends again). The note not
      // reaching the transport is the part the user has to be told about, since a
      // private note is unreachable without its relayed body.
      setMockRow({
        ...baseSendTx,
        status: STATUS_COMPLETED,
        noteDelivery: 'undelivered'
      });

      await renderAndLoad();

      const warning = screen.getByTestId('history-note-delivery-warning');
      expect(warning).toBeInTheDocument();
      // `t` is stubbed to echo the key here, so assert on the key: the point is
      // WHICH copy is chosen, not its wording.
      expect(warning.textContent).toBe('noteDeliveryUndeliveredBody');
      // Recovery guidance accompanies the warning — a warning with no action is
      // just a dead end for the one user who most needs a next step.
      expect(screen.getByText('noteDeliveryRecoveryHint')).toBeInTheDocument();
    });

    it('warns on a row still recording a PENDING delivery', async () => {
      // 'pending' means the wallet recorded that a relay was owed and never
      // recorded an outcome — the process died mid-relay. No more reassuring than
      // an outright failure, so it is surfaced too.
      setMockRow({
        ...baseSendTx,
        status: STATUS_COMPLETED,
        noteDelivery: 'pending'
      });

      await renderAndLoad();

      const warning = screen.getByTestId('history-note-delivery-warning');
      // Distinct copy from the undelivered case: "we don't know" is not "it failed".
      expect(warning.textContent).toBe('noteDeliveryPendingBody');
    });

    it('shows no warning when the note was relayed', async () => {
      setMockRow({
        ...baseSendTx,
        status: STATUS_COMPLETED,
        noteDelivery: 'relayed'
      });

      await renderAndLoad();

      expect(screen.queryByTestId('history-note-delivery-warning')).not.toBeInTheDocument();
    });

    it('shows no warning for a public send or a row predating the field', async () => {
      // Absent means the question does not apply (public sends carry the whole note
      // on chain) or the row was written by an older build. Neither is a warning.
      setMockRow({ ...baseSendTx, status: STATUS_COMPLETED });

      await renderAndLoad();

      expect(screen.queryByTestId('history-note-delivery-warning')).not.toBeInTheDocument();
    });

    it('confirms delivery once the note has been consumed on chain', async () => {
      // The positive counterpart to the warnings: consumption is the only proof a
      // sender can have that a private note arrived, since the recipient cannot
      // spend a body they never received.
      setMockRow({
        ...baseSendTx,
        status: STATUS_COMPLETED,
        noteDelivery: 'confirmed'
      });

      await renderAndLoad();

      expect(screen.getByTestId('history-note-delivery-confirmed').textContent).toBe('noteDeliveryConfirmedBody');
      expect(screen.queryByTestId('history-note-delivery-warning')).not.toBeInTheDocument();
    });

    it('stays silent on a relayed-but-unconfirmed note rather than warning', async () => {
      // 'relayed' means accepted by the transport with nothing yet proving arrival,
      // and an unclaimed note is the ordinary case — a recipient who simply hasn't
      // claimed looks identical to one who never received it. Warning here would
      // fire on most healthy private sends.
      setMockRow({
        ...baseSendTx,
        status: STATUS_COMPLETED,
        noteDelivery: 'relayed',
        relayAttempts: 4
      });

      await renderAndLoad();

      expect(screen.queryByTestId('history-note-delivery-warning')).not.toBeInTheDocument();
      expect(screen.queryByTestId('history-note-delivery-confirmed')).not.toBeInTheDocument();
    });
  });

  describe('Guardian switch details', () => {
    it('renders the From/To hero, status, generic details, and no wallet destination rows', async () => {
      setMockRow({
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
      setMockRow({
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
      mockRowLoaded = false;
      render(<HistoryDetails transactionId="tx-1" />);
      expect(screen.getByTestId('spinner')).toBeInTheDocument();
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });

    it('renders the error view with the Error message when deriving the row throws an Error', async () => {
      setMockRow({ ...baseSendTx });
      mockGetTokenMetadata.mockRejectedValue(new Error('boom-failure'));
      await renderAndLoad();

      expect(screen.getByText('smthWentWrong')).toBeInTheDocument();
      expect(screen.getByText('boom-failure')).toBeInTheDocument();
      // ID line echoes the transactionId (interpolated into the label key).
      expect(screen.getByText('historyDetailsIdLabel_tx-1')).toBeInTheDocument();
      expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    });

    it('falls back to a generic message when the thrown value is not an Error', async () => {
      setMockRow({ ...baseSendTx });
      mockGetTokenMetadata.mockRejectedValue('a plain string');
      await renderAndLoad();
      expect(screen.getByText('historyDetailsLoadError')).toBeInTheDocument();
    });

    it('shows the not-found error when the row subscription settles empty', async () => {
      mockRow = undefined;
      mockRowLoaded = true;
      await renderAndLoad();
      expect(screen.getByText('historyDetailsLoadError')).toBeInTheDocument();
      expect(screen.getByText('historyDetailsIdLabel_tx-1')).toBeInTheDocument();
    });

    it('calls goBack when the header back button is pressed', async () => {
      setMockRow({ ...baseSendTx });
      await renderAndLoad();
      fireEvent.click(screen.getByTestId('back-button'));
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });
  });

  describe('sent transaction rendering', () => {
    it('renders amount, token, fiat, status, date, external tx id, from/to and notes', async () => {
      setMockRow({ ...baseSendTx });
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

      // External tx id row → HashChip + explorer link built from getExplorerTxUrl
      // (the override-aware helper), NOT a hardcoded testnet URL.
      const txRow = rowByLabel('txIdLabel')!;
      expect(txRow.querySelector('[data-testid="hash-chip"]')?.textContent).toBe('ext-tx-1');
      expect(txRow.querySelector('a[data-testid="external-link"]')).toHaveAttribute(
        'href',
        'https://custom-explorer.test/tx/ext-tx-1'
      );

      // 'Sent' => from = accountId (matches current account) / to = secondaryAccountId (matches allAccounts).
      const fromChip = rowByLabel('from')!.querySelector('[data-testid="address-chip"]')!;
      expect(fromChip).toHaveAttribute('data-address', 'acct-A');
      expect(fromChip).toHaveAttribute('data-displayname', 'you (Mine)');
      const toChip = rowByLabel('to')!.querySelector('[data-testid="address-chip"]')!;
      expect(toChip).toHaveAttribute('data-address', 'acct-B');
      expect(toChip).toHaveAttribute('data-displayname', 'you (Other)');

      // From/To account links also come from getExplorerAccountUrl (override-aware).
      expect(rowByLabel('from')!.querySelector('a[data-testid="external-link"]')).toHaveAttribute(
        'href',
        'https://custom-explorer.test/account/acct-A'
      );
      expect(rowByLabel('to')!.querySelector('a[data-testid="external-link"]')).toHaveAttribute(
        'href',
        'https://custom-explorer.test/account/acct-B'
      );

      // Notes section: created count = outputNoteIds length.
      expect(rowByLabel('created')?.textContent).toBe('1');

      // Transfer details and Notes are separated using the transaction icon accent.
      const dividers = screen.getAllByTestId('history-section-divider');
      expect(dividers).toHaveLength(2);
      dividers.forEach(divider => expect(divider).toHaveStyle({ backgroundColor: '#91ACC1' }));

      // Not a swap → no order-tracking card.
      expect(screen.queryByTestId('swap-order-card')).not.toBeInTheDocument();
    });

    // The placeholder's 6 decimals are a guess. Converting an 18-decimal token by
    // them yields a number a trillion times too large, and the fiat estimate turns
    // that invented quantity into an invented dollar value.
    it('withholds the fiat estimate when the faucet has no known scale', async () => {
      mockGetTokenMetadata.mockResolvedValue({ symbol: 'MID', decimals: 6, scaleIsUnknown: true });
      setMockRow({ ...baseSendTx });
      await renderAndLoad();

      expect(screen.queryByText(/historyDetailsFiatApprox/)).not.toBeInTheDocument();
    });

    it('shows the address itself when the account is unknown (no display name)', async () => {
      setMockRow({ ...baseSendTx, secondaryAccountId: 'stranger' });
      await renderAndLoad();
      const toChip = rowByLabel('to')!.querySelector('[data-testid="address-chip"]')!;
      expect(toChip).toHaveAttribute('data-displayname', '');
      expect(toChip.textContent).toBe('stranger');
    });

    it('swaps from/to for an inbound transaction and hides optional rows when data is absent', async () => {
      setMockRow({
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
      setMockRow({ ...baseSendTx, displayMessage });
      await renderAndLoad();

      expect(rowByLabel('from')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute(
        'data-address',
        'acct-A'
      );
      expect(rowByLabel('to')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-address', 'acct-B');
    });

    it('hides the notes section entirely when there is no note data', async () => {
      setMockRow({ ...baseSendTx, outputNoteIds: undefined });
      await renderAndLoad();
      expect(rowByLabel('created')).toBeUndefined();
    });

    it('treats a present-but-empty-first note id as note data via the outputNoteIds branch', async () => {
      // noteId = outputNoteIds[0] = '' (falsy) but outputNoteIds.length > 0 → hasNoteData true.
      setMockRow({ ...baseSendTx, outputNoteIds: [''] });
      await renderAndLoad();
      expect(rowByLabel('created')?.textContent).toBe('1');
    });

    it('returns the raw amount string when it is not a finite number (and omits fiat)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatAmount } = require('lib/shared/format');
      formatAmount.mockReturnValue('NaN');
      setMockRow({ ...baseSendTx });
      await renderAndLoad();

      // The shared summary badge preserves the formatter's non-finite output.
      expect(screen.getByText('NaN MID')).toBeInTheDocument();
      // formatFiatDisplayAmount → non-finite → undefined → no fiat line.
      expect(screen.queryByText(/historyDetailsFiatApprox/)).not.toBeInTheDocument();
    });

    it('renders address chips even when there is no current account (optional-chaining branch)', async () => {
      mockAccount = undefined;
      setMockRow({ ...baseSendTx, secondaryAccountId: 'acct-B' });
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

  // A batch claim consumes INPUT notes, so its Notes card lists what it claimed
  // rather than counting outputs it never created (#732).
  describe('batch-claim notes card', () => {
    const consumeTx = (overrides: Tx = {}): Tx => ({
      ...baseSendTx,
      type: 'consume',
      displayMessage: 'Received',
      displayIcon: 'RECEIVE',
      outputNoteIds: undefined,
      noteType: 'private',
      noteId: 'note-1',
      noteIds: ['note-1', 'note-2', 'note-3'],
      ...overrides
    });

    it('lists the consumed input notes instead of an output count on a completed claim', async () => {
      setMockRow(consumeTx());
      await renderAndLoad();

      expect(rowByLabel('created')).toBeUndefined();
      const consumed = rowByLabel('consumed')!;
      expect(consumed.querySelector('[data-testid="history-consumed-notes"]')).not.toBeNull();
      expect(Array.from(consumed.querySelectorAll('[data-testid="hash-chip"]')).map(chip => chip.textContent)).toEqual([
        'note-1',
        'note-2',
        'note-3'
      ]);
      // Storage mode of the claimed notes, shown only for the two known modes.
      expect(rowByLabel('noteTypeLabel')?.textContent).toBe('private');
    });

    it.each([
      ['queued', 0],
      ['generating', 1],
      ['failed', 3]
    ])('claims nothing yet on a %s row, so the whole card stays closed', async (_label, status) => {
      // `noteIds` is stamped at QUEUE time. Without the status gate the card
      // reports notes as "Consumed" while they are still sitting claimable.
      setMockRow(consumeTx({ status }));
      await renderAndLoad();

      expect(rowByLabel('consumed')).toBeUndefined();
      // And it must not degrade into "Created: 0" either — the note type alone
      // does not open the card.
      expect(rowByLabel('created')).toBeUndefined();
      expect(rowByLabel('noteTypeLabel')).toBeUndefined();
    });

    it('falls back to the scalar noteId on a legacy claim with no noteIds array', async () => {
      setMockRow(consumeTx({ noteIds: undefined }));
      await renderAndLoad();

      expect(
        Array.from(rowByLabel('consumed')!.querySelectorAll('[data-testid="hash-chip"]')).map(c => c.textContent)
      ).toEqual(['note-1']);
    });

    it('omits the note-type row for a storage mode that is neither private nor public', async () => {
      setMockRow(consumeTx({ noteType: 'P2ID' }));
      await renderAndLoad();
      expect(rowByLabel('noteTypeLabel')).toBeUndefined();
      expect(rowByLabel('consumed')).toBeDefined();
    });

    // A "Claim All" is bounded only by how many notes the user had waiting, so
    // an uncapped list can be hundreds of rows long.
    it('previews five notes behind a "+N more" tap and reveals the rest on click', async () => {
      const noteIds = Array.from({ length: 8 }, (_, i) => `note-${i}`);
      setMockRow(consumeTx({ noteId: noteIds[0], noteIds }));
      await renderAndLoad();

      // Scoped to the notes list: the external-tx-id row renders a chip too.
      const chips = () =>
        Array.from(screen.getByTestId('history-consumed-notes').querySelectorAll('[data-testid="hash-chip"]')).map(
          chip => chip.textContent
        );
      expect(chips()).toEqual(['note-0', 'note-1', 'note-2', 'note-3', 'note-4']);

      const showAll = screen.getByTestId('history-consumed-notes-show-all');
      expect(showAll.textContent).toBe('showAllNotes_3');

      fireEvent.click(showAll);

      expect(chips()).toEqual(noteIds);
      expect(screen.queryByTestId('history-consumed-notes-show-all')).toBeNull();
    });

    it('shows no expand affordance at exactly the preview count', async () => {
      const noteIds = Array.from({ length: 5 }, (_, i) => `note-${i}`);
      setMockRow(consumeTx({ noteId: noteIds[0], noteIds }));
      await renderAndLoad();

      expect(
        Array.from(screen.getByTestId('history-consumed-notes').querySelectorAll('[data-testid="hash-chip"]')).map(
          c => c.textContent
        )
      ).toEqual(noteIds);
      expect(screen.queryByTestId('history-consumed-notes-show-all')).toBeNull();
    });

    // The estimate is priced off the primary faucet alone, so under a hero that
    // lists several assets it reads as the total while understating it.
    it('suppresses the fiat estimate when the claim spans several faucets', async () => {
      setMockRow(
        consumeTx({
          amount: 20n,
          assetTotals: [
            { faucetId: 'faucet-1', amount: 20n },
            { faucetId: 'faucet-2', amount: 10n }
          ]
        })
      );
      await renderAndLoad();

      expect(screen.queryByText(/historyDetailsFiatApprox/)).not.toBeInTheDocument();
    });

    it('keeps the fiat estimate when the claim is a single faucet', async () => {
      setMockRow(consumeTx({ amount: 20n, assetTotals: [{ faucetId: 'faucet-1', amount: 20n }] }));
      await renderAndLoad();

      expect(screen.getByText('historyDetailsFiatApprox_$40.00')).toBeInTheDocument();
    });
  });

  describe('swap order tracking', () => {
    // Orders the wallet writes today always carry an expiry, which is what makes
    // auto-settlement reachable; tests covering rows persisted before that stamp
    // existed override it back to undefined.
    const swapTx = (extra: Record<string, unknown>): Tx => ({
      ...baseSendTx,
      type: 'swap',
      amount: undefined,
      faucetId: 'faucet-1',
      outputNoteIds: undefined,
      transactionId: undefined,
      extraInputs: { expiresAt: 1_700_000_120, ...extra }
    });

    it('resolves the requested token via the swap registry and shows a filled order', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      // A filled order has nothing outstanding — a lineage reporting 'filled'
      // with a remainder is a shape the protocol cannot produce, and asserting
      // on it hid the difference between a full and a partial fill.
      seedTracking({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));
      await renderAndLoad();

      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusFilled');
      // There is deliberately no fill-count meter: the lineage only tells us
      // how much remains, not how many fills the order will ultimately need.
      expect(screen.queryByTestId('swap-order-fill-rounds')).not.toBeInTheDocument();
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_1000_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

      // Registry hit → requested-faucet metadata NOT fetched (only the tx faucet was).
      expect(mockGetTokenMetadata).toHaveBeenCalledTimes(1);
      expect(mockGetTokenMetadata).toHaveBeenCalledWith('faucet-1');
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
      expect(screen.queryByText('cancel')).not.toBeInTheDocument();
    });

    it('does not call an unsettled order Confirmed while the list calls it Pending', async () => {
      // A swap row is Completed the moment the order note is created: the
      // place-order transaction confirmed, the swap did not. The list chip
      // already says Pending, so a Confirmed pill here contradicted both the
      // list and the "Open" line directly beneath it.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'active',
        currentDepth: 0,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      setMockSettlementNotes(settlementNotes([]));
      setMockRow(
        swapTx({
          orderId: 42n,
          requestedFaucetId: 'req-faucet',
          requestedAmount: 1000n,
          expiresAt: 1_700_000_999
        })
      );

      await renderAndLoad();

      expect(screen.getByTestId('status-pill')).toHaveAttribute('data-swap-settlement', 'pending');
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusActive');
    });

    it('keeps a way off the screen once the order is filled', async () => {
      // Close is a dismiss, not a cancellation, so no order state can take it
      // away. Deriving it from the order state left a filled receipt with only
      // the header controls, and slid it into the primary slot the instant a
      // fill landed — under a finger already travelling toward the other button.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      setMockSettlementNotes(settlementNotes([]));
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusFilled');
      expect(screen.getByText('close')).toBeInTheDocument();
    });

    it('calls a partly-matched open order partially filled, not open', async () => {
      // 600 of 1000 matched on the DEX with the order still live. "Open" alone
      // understates it and the bar would be the only hint that anything landed.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'active',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 400n
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));
      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilled');
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_600_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    });

    it('does not announce an expired partial fill as Filled', async () => {
      // The protocol's ordinary partial-fill ending: the expiry batch carries a
      // payback, so it is tagged 'settle' and the local stamp reads 'filled',
      // while the lineage — the authority on the order — says reclaimed
      // (playwright/e2e/tests/swap/swap-partial-fill.spec.ts). Announcing
      // "Filled" here told the user their whole order went through.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'reclaimed',
        currentDepth: 2,
        remainingOffered: 600n,
        remainingRequested: 600n
      });
      setMockSettlementNotes({
        settled: ['payback-note'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-1',
            transactionId: 'chain-1',
            noteIds: ['payback-note'],
            amount: 400n,
            faucetId: 'req-faucet',
            completedAt: 1_700_000_100
          }
        ],
        reclaimedTransactions: []
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilledReclaimed');
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_400_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    });

    it('falls back to token metadata and reports an absent requested amount as unknown, not as zero', async () => {
      // Registry miss → metadata lookup for the requested faucet (returns {} → no symbol/decimals).
      mockGetSwapTokenByFaucetId.mockReturnValue(undefined);
      seedTracking({
        orderId: '7',
        state: 'reclaimed',
        currentDepth: 0,
        remainingOffered: 0n,
        remainingRequested: 5n
      });
      setMockRow(swapTx({ orderId: 7n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusReclaimed');
      // The row carries no requestedAmount, so the total is unknown and the fill
      // derived from it is too. Defaulting the total to 0 used to render
      // "0 of 0 filled" at 0% — a confident claim about an order this receipt
      // knows nothing about. Unknown progress is indeterminate: no bar, no
      // percentage, no aria-valuenow.
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_—_—_');
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
      expect(screen.queryByTestId('swap-amount-progress-fill')).not.toBeInTheDocument();
      // Prefix match: the stubbed `t` renders this key as `swapProgressPercent_60`,
      // so an exact-string query returns null whether the element is there or not.
      expect(screen.queryByText(/^swapProgressPercent/)).toBeNull();
      // Two metadata calls: tx faucet + requested faucet.
      expect(mockGetTokenMetadata).toHaveBeenCalledWith('req-faucet');
    });

    it('drops the Pending Notes shortcut once the claim has been observed', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '9',
        state: 'filled',
        currentDepth: 3,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      setMockSettlementNotes(settlementNotes(['note-x'], []));
      setMockRow(swapTx({ orderId: 9n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, autoConsume: false }));

      await renderAndLoad();

      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
    });

    it('shows the loading label while the first poll is in flight', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      setMockRow(swapTx({ orderId: 5n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('loading');
      expect(screen.getByText('swapMatchingDex')).toBeInTheDocument();
    });

    it('reconciles to Filled once settlement notes are seen locally, even if the lineage still reports active (#486)', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      // The on-chain lineage lags — it keeps reporting the order as still active
      // even though its own remainder shows the request fully matched...
      seedTracking({
        orderId: '10',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      // ...but this wallet has already observed the settlement consume note.
      setMockSettlementNotes(settlementNotes(['note-x'], []));
      setMockRow(swapTx({ orderId: 10n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      // Local settlement is the source of truth: show Filled and drop the spinner
      // instead of sitting on "Active" with a flickering loader.
      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusFilled');
      expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
    });

    it('reconciles to Reclaimed when the local settlement is a reclaim (#486)', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '11',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 1000n,
        // Nothing was ever matched, so this is a plain reclaim.
        remainingRequested: 1000n
      });
      setMockSettlementNotes(settlementNotes([], ['note-r']));
      setMockRow(swapTx({ orderId: 11n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusReclaimed');
      expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
    });

    it('treats a mixed settle+reclaim order as Filled — a settle consume outranks a reclaim (#486)', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '12',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      // Paybacks settled in one consume tick, the tip reclaimed in another — both
      // buckets are non-empty. The swap-row chip stamps "Settled" (funds received),
      // so this row must agree rather than showing "Reclaimed".
      setMockSettlementNotes(settlementNotes(['note-s'], ['note-r']));
      setMockRow(swapTx({ orderId: 12n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('orderStatusFilled');
      expect(screen.queryByText('swapMatchingDex')).not.toBeInTheDocument();
    });

    it('renders the swap receipt without polling when the transaction carries no order id', async () => {
      // The transaction can still be inspected while its order id is absent.
      setMockRow(swapTx({ requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();
      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      // Nothing is tracked, so the fill is unknown rather than zero.
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    });

    it('renders an unknown-state receipt for a swap with entirely absent extraInputs', async () => {
      setMockRow({ ...swapTx({}), extraInputs: undefined });
      await renderAndLoad();
      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      // No order id and no requested amount, so neither side of the progress
      // line is known — em dashes, not zeroes that would claim the order
      // definitely filled nothing out of a total of nothing.
      expect(screen.getByTestId('swap-order-amount-filled')).toHaveTextContent('swapAmountProgress_—_—_');
      expect(screen.queryByTestId('swap-amount-progress-fill')).not.toBeInTheDocument();
    });
  });

  describe('swap settlement notes', () => {
    // Orders the wallet writes today always carry an expiry, which is what makes
    // auto-settlement reachable; tests covering rows persisted before that stamp
    // existed override it back to undefined.
    const swapTx = (extra: Record<string, unknown>): Tx => ({
      ...baseSendTx,
      type: 'swap',
      amount: undefined,
      faucetId: 'faucet-1',
      outputNoteIds: undefined,
      transactionId: undefined,
      extraInputs: { expiresAt: 1_700_000_120, ...extra }
    });

    it('lists the notes the suppressed settlement consumes claimed', async () => {
      setMockSettlementNotes({
        settled: ['note-a', 'note-b'],
        reclaimed: ['note-c'],
        settledTransactions: [
          { id: 'c-1', transactionId: 'ext-1', noteIds: ['note-a'], amount: undefined },
          { id: 'c-2', transactionId: 'ext-2', noteIds: ['note-b'], amount: undefined }
        ],
        reclaimedTransactions: [{ id: 'c-3', transactionId: 'ext-3', noteIds: ['note-c'], amount: undefined }]
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      // Each consume gets its own numbered row, so a multi-fill receipt does not
      // show N rows under one label.
      expect(rowByLabel('consumeTxIdNumber_1')).toBeInTheDocument();
      expect(rowByLabel('consumeTxIdNumber_2')).toBeInTheDocument();
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
      setMockSettlementNotes({
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
      setMockRow({
        ...swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }),
        transactionId: 'swap-chain-1'
      });

      await renderAndLoad();

      expect(screen.getByText('swapReceivedAmount_685_ ETH')).toBeInTheDocument();
      // Pin the scale of the timestamp, not just its presence: reading the
      // epoch-seconds field as milliseconds renders every fill at 1970 and a
      // prefix match cannot see it. Formatted here from the same instant so the
      // assertion does not depend on the runner's timezone.
      const consumedAt = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(1_700_000_120 * 1000));
      expect(screen.getByText(`swapConsumedAt_${consumedAt}`)).toBeInTheDocument();
      expect(rowByLabel('txIdLabel')).toHaveTextContent('swap-chain-1');
      expect(rowByLabel('consumeTxId')).toHaveTextContent('consume-chain-1');
      // The consume row's hash has to stay a link to the explorer.
      expect(rowByLabel('consumeTxId')?.querySelector('[data-testid="external-link"]')).toHaveAttribute(
        'href',
        expect.stringContaining('consume-chain-1') as unknown as string
      );
      expect(rowByLabel('from')).toHaveTextContent('you (Mine)');
      expect(screen.queryByText('cancel')).not.toBeInTheDocument();
    });

    it('omits the received amount when the consume settled a different faucet than the requested token', async () => {
      // An expired order consumes its requested-token paybacks together with the
      // offered-token tip, and the consume's amount covers only its first input
      // note's faucet — so it can be the offered remainder, which must not be
      // relabelled as funds received in the requested token.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      setMockSettlementNotes({
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
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

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
      seedUnavailable('42');
      setMockSettlementNotes({
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
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_600_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
      // 600 of 1000 is a partial fill, whatever the lineage would have said.
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilled');
    });

    it('reports the fill as unknown, not as smaller, when a consume cannot be attributed', async () => {
      // With no lineage the fill is inferred by summing the settled consumes'
      // amounts. A row whose notes were split across consumes carries no usable
      // amount, so the sum is incomplete — and an incomplete sum is not a
      // smaller fill, it is an unknown one. Adding up only the rows that happen
      // to have amounts stated 400 of 1000 where 600 arrived, which understates
      // the money as confidently as the old double-count overstated it.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedUnavailable('42');
      setMockSettlementNotes({
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
            amount: undefined,
            faucetId: 'req-faucet',
            completedAt: 1_700_000_200
          }
        ],
        reclaimedTransactions: []
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_—_1000_ ETH');
      expect(screen.queryByTestId('swap-amount-progress-fill')).not.toBeInTheDocument();
    });

    it('still sums the fill when an unattributable consume is for the other side of the swap', async () => {
      // The offered-token tip comes back in its own consume and legitimately has
      // no bearing on the requested side, so it must not poison the total the way
      // an unattributable requested-token row does.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedUnavailable('42');
      setMockSettlementNotes({
        settled: ['note-a', 'tip-note'],
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
            noteIds: ['tip-note'],
            amount: undefined,
            faucetId: 'offered-faucet',
            completedAt: 1_700_000_200
          }
        ],
        reclaimedTransactions: []
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_400_1000_ ETH');
    });

    it('keeps the claim route for a legacy order the wallet will never settle on its own', async () => {
      // Orders persisted before expiry stamping have no `expiresAt`, and
      // `reconcileSwapOrderNotes` only bundles an 'active' order's notes once it
      // expires — so this order is never auto-settled, no matter that
      // `autoConsume` is absent and therefore read as enabled. Trusting that
      // flag alone hid "Go to Pending Notes" from precisely the orders whose
      // funds nothing else will ever collect.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 400n,
        remainingRequested: 400n
      });
      setMockRow(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, expiresAt: undefined })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilled');
      expect(screen.getByText('swapOpenPendingNotes')).toBeInTheDocument();
    });

    it('does not let a lagging lineage assert zero over a fill it is already listing', async () => {
      // `remainingRequested` is read off the order's CURRENT tip, so a lineage
      // that has not yet synced the fill still reports the whole request
      // outstanding. That is the same lag that used to leave the status on
      // "Active" after settlement (#486) — but the rule that a local settle
      // consume outranks it was only ever applied to the STATE. Taking the
      // lineage's number first let it state a confident zero over a payback this
      // wallet had consumed and was showing three rows further down, and the
      // false zero stripped the partial-fill qualifier too, upgrading a 40% fill
      // to "Filled".
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      setMockSettlementNotes({
        settled: ['payback-note'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-1',
            transactionId: 'chain-1',
            noteIds: ['payback-note'],
            amount: 400n,
            faucetId: 'req-faucet',
            completedAt: 1_700_000_100
          }
        ],
        reclaimedTransactions: []
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_400_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilled');
      expect(screen.getByText('swapReceivedAmount_400_ ETH')).toBeInTheDocument();
    });

    it('reports the fill as unknown when a settlement consume never recorded its faucet', async () => {
      // `settleSwapOrders` queues its consume rows with `faucetId: ''`, and both
      // the stuck-transaction reaper and the killed-consume path can mark such a
      // row Completed without ever stamping the real faucet. Reading the blank
      // string as a mismatch made a settlement that DID deliver funds subtract
      // itself from the fill, and the receipt stated the shortfall as fact.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedUnavailable('42');
      setMockSettlementNotes({
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
            amount: 300n,
            faucetId: '',
            completedAt: 1_700_000_200
          }
        ],
        reclaimedTransactions: []
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_—_1000_ ETH');
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    });

    it('keeps the claim route for a partly filled order whose tip was reclaimed', async () => {
      // "Reclaimed" is a statement about the offered TIP being taken back. The
      // payback notes carrying whatever was matched are an independent P2ID
      // chain, and Pending Notes claims per group — so a manual-claim user can
      // take the tip back and leave the matched funds sitting there. Reading the
      // order's ending as "nothing left to collect" removed the only route to
      // them from a receipt that was simultaneously reporting a 40% fill.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'reclaimed',
        currentDepth: 1,
        remainingOffered: 600n,
        remainingRequested: 600n
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, autoConsume: false }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_400_1000_ ETH');
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilledReclaimed');
      expect(screen.getByText('swapOpenPendingNotes')).toBeInTheDocument();
    });

    it('does not link a local row id to the explorer as though it were on chain', async () => {
      // A consume the reaper marked Completed never received a chain id, and
      // falling back to the Dexie UUID published it under "Consume tx ID" with a
      // live explorer link — an identity the receipt does not have, and a dead
      // link.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      setMockSettlementNotes({
        settled: ['note-a'],
        reclaimed: [],
        settledTransactions: [
          { id: 'local-uuid-2f8c', transactionId: undefined, noteIds: ['note-a'], amount: undefined }
        ],
        reclaimedTransactions: []
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      const row = rowByLabel('consumeTxId');
      expect(row).toHaveTextContent('local-uuid-2f8c');
      expect(row?.querySelector('[data-testid="external-link"]')).toBeNull();
    });

    it('reports nothing filled, not a negative fill, when the lineage owes more than was requested', async () => {
      // `remainingRequested` comes from the lineage and the requested total from
      // the persisted row; nothing guarantees they agree. Subtracting without a
      // floor yields a negative filled amount and a negative aria-valuenow.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 1500n,
        remainingRequested: 1500n
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_0_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    });

    it('says nothing has been bundled only when the fill is actually known', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'filled',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByText('swapNoBundledNotes')).toBeInTheDocument();
    });

    it('withholds the "nothing bundled" claim from a receipt that cannot see the fill', async () => {
      // A restored wallet has no lineage and no tagged consumes, so it cannot
      // tell whether the order settled long ago. Denying it outright is worse
      // than saying nothing; the status line already reads "Not available".
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedUnavailable('42');
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.queryByText('swapNoBundledNotes')).not.toBeInTheDocument();
    });

    it('offers no claim route for a legacy order that has already gone terminal', async () => {
      // The missing `expiresAt` only strands an order that is still 'active':
      // `reconcileSwapOrderNotes` skips on `active && !expired`, so a terminal
      // order's paybacks are bundled on the next tick whether or not it carries
      // an expiry. Reading the absent stamp as "never self-settles" therefore
      // routed the user to Pending Notes for funds the wallet was about to claim.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'filled',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      setMockRow(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, expiresAt: undefined })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusFilled');
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
    });

    it('offers no claim route once a manual-consume order has been reclaimed', async () => {
      // A reclaim returned the offered tip; there is nothing left to collect, so
      // sending the user to Pending Notes would promise notes that do not exist.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedTracking({
        orderId: '42',
        state: 'reclaimed',
        currentDepth: 1,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, autoConsume: false }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusReclaimed');
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
    });

    it('never claims a full fill for a partially filled order that settled at expiry', async () => {
      // An expiry batch carrying any payback is tagged 'settle', so a PARTIAL
      // fill reaches `settledOrderState === 'filled'`. Assuming the requested
      // amount there would print a confident, wrong figure on the receipt.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedUnavailable('42');
      setMockSettlementNotes({
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
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_300_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
      // The label has to agree with the bar: this is the ordinary outcome for a
      // manual-claim or restored wallet, and "Filled" over a 30% bar is the
      // exact statement this receipt exists to avoid.
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilled');
    });

    it('shows an unknown fill as unknown, not as zero', async () => {
      // Offered-token tip only, no lineage: the receipt must neither synthesise
      // a filled amount from the request nor state "0 of 1000", which would
      // assert that nothing arrived. This is also the tip-first expiry consume,
      // where the payback did arrive but its faucet is not the one recorded.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      seedUnavailable('42');
      setMockSettlementNotes({
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
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_—_1000_ ETH');
      // An em dash beside a full-width empty bar reading "0%" still asserted
      // zero in every channel except the one word. Unknown progress draws no
      // bar and exposes no value to assistive technology.
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
      expect(screen.queryByTestId('swap-amount-progress-fill')).not.toBeInTheDocument();
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
      setMockRow({
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

    it('scales and labels the requested side with the requested token, not the offered one', async () => {
      // The requested faucet is a DEX faucet too, so it is subject to the same
      // Unknown-at-6-decimals fallback as the offered side. `toContain` over the
      // whole card cannot tell which side a symbol or a scale landed on, so pin
      // the amounts to the requested token's own decimals and read the hero's
      // two amount cells as an ordered pair.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { formatAmount } = require('lib/shared/format');
      formatAmount.mockImplementation((amount: bigint, decimals?: number) => `${amount}@${decimals}`);
      mockGetSwapTokenByFaucetId.mockImplementation((id: string | undefined) =>
        id === 'faucet-1' ? { symbol: 'IETH', decimals: 6 } : { symbol: 'ETH', decimals: 8 }
      );
      seedTracking({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 400n
      });
      setMockRow({
        ...swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }),
        amount: 500n
      });

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_600@8_1000@8_ ETH');
      // Read as an ordered pair: each side keeps its own scale AND its own
      // symbol, so neither can be reading the other's metadata.
      expect(screen.getByTestId('swap-order-hero').textContent).toBe('500@6IETH1000@8ETH');
    });

    it('surfaces the failure reason and the raw error for a failed swap', async () => {
      // A failed swap never placed an order, so it carries neither an orderId
      // nor an expiry: `completeSwapTransaction` stamps both only inside the
      // same write that sets Completed. Building this through `swapTx` gave the
      // one genuinely-failed fixture a shape production cannot produce, and with
      // it a lineage poll and an expiry the real screen would never run.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      setMockRow({
        ...baseSendTx,
        type: 'swap',
        amount: undefined,
        faucetId: 'faucet-1',
        outputNoteIds: undefined,
        transactionId: undefined,
        extraInputs: { requestedFaucetId: 'req-faucet', requestedAmount: 1000n },
        status: 3,
        error: 'Swap request rejected',
        rawError: 'Error: note script failed at cycle 4211'
      } as Tx);

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      expect(screen.getByTestId('history-failure-reason')).toHaveTextContent('Swap request rejected');
      fireEvent.click(screen.getByText('showFullError'));
      expect(screen.getByText('Error: note script failed at cycle 4211')).toBeInTheDocument();
      // No order to track and no notes to scan for.
      expect(screen.getByTestId('swap-order-status').textContent).toBe('trackingUnavailable');
      // A retry offers the whole swap again, so the receipt must not also be
      // offering its own in-card route out at the same time: the two action
      // groups are rendered by sibling, independently-gated conditionals.
      expect(screen.getByText('retry')).toBeInTheDocument();
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
      expect(screen.queryByText('close')).not.toBeInTheDocument();
    });

    it('omits the reclaimed row when the order only settled', async () => {
      setMockSettlementNotes(settlementNotes(['note-a'], []));
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      expect(screen.getByTestId('swap-settled-notes')).toHaveTextContent('note-a');
      expect(screen.queryByTestId('swap-reclaimed-notes')).not.toBeInTheDocument();
    });

    it('renders no settlement rows when nothing has settled yet', async () => {
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      expect(screen.queryByTestId('swap-settled-notes')).not.toBeInTheDocument();
      expect(screen.queryByTestId('swap-reclaimed-notes')).not.toBeInTheDocument();
    });

    it('picks the notes up when settlement lands while the page is open', async () => {
      setMockRow(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));
      const { rerender } = await renderAndLoad();
      expect(screen.queryByTestId('swap-settled-notes')).not.toBeInTheDocument();

      // Auto-consume completes after the page mounted. The mocked liveQuery hook
      // returns the pushed value on the next render.
      setMockSettlementNotes(settlementNotes(['note-late'], []));
      rerender(<HistoryDetails transactionId="tx-1" />);
      await flush();

      expect(screen.getByTestId('swap-settled-notes')).toHaveTextContent('note-late');
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
      setMockRow(failedSendTx());
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
      setMockRow(failedSendTx({ rawError: undefined, error: 'Note is invalid' }));
      await renderAndLoad();

      expect(screen.queryByText('showFullError')).toBeNull();
      expect(screen.getByText('Note is invalid')).toBeInTheDocument();
    });

    it('retries a failed send: re-queues the row, nudges the SW and navigates to the progress page', async () => {
      setMockRow(failedSendTx());
      await renderAndLoad();

      fireEvent.click(screen.getByText('retry'));
      await flush();

      expect(mockRequeueFailedTransaction).toHaveBeenCalledWith('tx-1', { acknowledgeUnverifiedSend: false });
      expect(mockRequestSWTransactionProcessing).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/tx-1');
    });

    // The two cancel routes leave an identical row apart from the error string,
    // and that string alone decides whether Retry exists at all. The
    // infra-resilience E2E depends on the distinction: it plants a reaped row
    // precisely so Retry is on screen to click. Stated as a pair because the
    // negative case is what carries the weight — the positive one restates the
    // ordinary failed-send path a few tests up, and passes for any string that
    // is not the hand-cancel text.
    it('offers Retry for a row the reaper failed', async () => {
      setMockRow(failedSendTx({ error: TRANSACTION_STUCK_ERROR }));
      await renderAndLoad();

      expect(screen.getByTestId('history-retry-button')).toBeInTheDocument();
    });

    it('withholds Retry for a row the user cancelled by hand', async () => {
      setMockRow(failedSendTx({ error: USER_CANCELLED_TRANSACTION_REASON }));
      await renderAndLoad();

      expect(screen.queryByTestId('history-retry-button')).toBeNull();
    });

    // Both cases above render against this file's mock of `lib/miden/activity`,
    // which reimplements the predicate rather than re-exporting it. Widening the
    // real one to match the reaper's reason too would leave them green and send
    // the E2E straight back to timing out, so assert the real predicate itself.
    // It lives here, next to what it protects, rather than in
    // `constants.test.ts` — which means: do NOT add a `jest.mock` for
    // `lib/miden/transaction/constants` to this file, or this becomes an
    // assertion about a mock and stops saying anything.
    it('treats only the hand-cancel reason as a user cancel', () => {
      expect(isUserCancelledTransaction(USER_CANCELLED_TRANSACTION_REASON)).toBe(true);
      expect(isUserCancelledTransaction(TRANSACTION_STUCK_ERROR)).toBe(false);
    });

    // Same contract as the progress screen: a send the wallet cannot verify is
    // refused with an explanation, and only then can the user vouch for it.
    it('offers "retry anyway" after refusing a send it cannot verify', async () => {
      setMockRow(failedSendTx());
      mockRequeueFailedTransaction.mockRejectedValueOnce(new Error('may already have reached the network'));
      mockIsUnverifiableSendRetryError.mockReturnValue(true);
      await renderAndLoad();

      expect(screen.queryByTestId('history-retry-anyway-button')).toBeNull();

      fireEvent.click(screen.getByText('retry'));
      await flush();

      expect(screen.getByTestId('history-retry-error').textContent).toContain('may already have reached the network');
      expect(mockNavigate).not.toHaveBeenCalled();

      mockRequeueFailedTransaction.mockResolvedValueOnce(undefined);
      fireEvent.click(screen.getByTestId('history-retry-anyway-button'));
      await flush();

      expect(mockRequeueFailedTransaction).toHaveBeenLastCalledWith('tx-1', { acknowledgeUnverifiedSend: true });
      expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/tx-1');
    });

    it('does not offer it for an ordinary retry failure', async () => {
      setMockRow(failedSendTx());
      mockRequeueFailedTransaction.mockRejectedValue(new Error('row is gone'));
      mockIsUnverifiableSendRetryError.mockReturnValue(false);
      await renderAndLoad();

      fireEvent.click(screen.getByText('retry'));
      await flush();

      expect(screen.queryByTestId('history-retry-anyway-button')).toBeNull();
    });

    it('surfaces a retry failure inline and does not navigate', async () => {
      setMockRow(failedSendTx());
      mockRequeueFailedTransaction.mockRejectedValue(new Error('row is gone'));
      await renderAndLoad();

      fireEvent.click(screen.getByText('retry'));
      await flush();

      expect(screen.getByText('row is gone')).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('offers no retry for a failed structural Guardian op', async () => {
      setMockRow(failedSendTx({ type: 'replace-hot-key' }));
      await renderAndLoad();

      expect(screen.queryByText('retry')).toBeNull();
    });

    it('renders a user-cancelled tx with the cancelled pill and no retry button', async () => {
      setMockRow(failedSendTx({ error: 'Transaction was cancelled by user', rawError: undefined }));
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
      setMockRow(failedSendTx({ completedAt: undefined, initiatedAt: 1_600_000_000 }));
      await renderAndLoad();

      expect(rowByLabel('date')!.textContent).toContain('formatted:1600000000');
    });

    it('cancels a still-queued tx with the user-cancelled sentinel', async () => {
      setMockRow({ ...baseSendTx, status: STATUS_QUEUED, error: undefined });
      await renderAndLoad();

      fireEvent.click(screen.getByText('cancel'));
      await flush();

      expect(mockCancelTransactionById).toHaveBeenCalledWith('tx-1', 'Transaction was cancelled by user');
    });

    it('shows the cancel failure inline when cancelling throws', async () => {
      setMockRow({ ...baseSendTx, status: STATUS_QUEUED, error: undefined });
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
      setMockRow({
        ...bridgedSendTx,
        amount: undefined,
        extraInputs: { provider: 'epoch', destinationAddress: '0xdest', claimStatus: 'not-applicable' }
      });
      await renderAndLoad({ transactionId: 'bridge-out' });

      // Both the "in" amount and the (absent) "out" amount collapse to the dash.
      expect(document.body.textContent?.match(/—/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('shows the claim section and bridge status pill for an outbound bridge', async () => {
      setMockRow(bridgedSendTx);
      await renderAndLoad({ transactionId: 'bridge-out' });

      expect(screen.getByTestId('bridge-claim-section')).toBeInTheDocument();
      expect(screen.getByText('confirmed')).toBeInTheDocument();
      // The bridged "to" is the EVM destination — no Miden to-row.
      expect(rowByLabel('to')).toBeUndefined();
    });

    it('renders an in-flight inbound bridge with EVM source, route and pending note', async () => {
      setMockRow(bridgedReceiveTx);
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
      setMockRow({
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
      setMockRow({
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
    setMockRow(earnWithdrawTx({ phase: 'delivering' }, { amount: 999n }));
    await renderAndLoad();

    expect(document.body.textContent).toContain('10.5');
    expect(document.body.textContent).toContain('USDC');
  });

  it('switches to the delivered destination amount once the note is received', async () => {
    setMockRow(earnWithdrawTx({ phase: 'received', outputSymbol: 'MDN' }, { amount: 999n }));
    await renderAndLoad();

    // The source figure is no longer what the hero claims.
    expect(document.body.textContent).not.toContain('10.5');
  });

  it('offers retry on a failed withdrawal that never recorded a nonce', async () => {
    setMockRow(earnWithdrawTx({ phase: 'failed', error: 'boom', withdrawIntentNonce: undefined }));
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
    setMockRow(earnWithdrawTx({ phase: 'failed', error: 'boom', withdrawIntentNonce: 'DEAD' }));
    await renderAndLoad();

    fireEvent.click(screen.getByText('retry'));
    await flush();

    expect(mockRetryEarnWithdrawReceive).toHaveBeenCalledWith('tx-1');
  });

  it('offers no retry while the withdrawal is still progressing', async () => {
    setMockRow(earnWithdrawTx({ phase: 'delivering' }));
    await renderAndLoad();

    expect(screen.queryByText('retry')).toBeNull();
  });

  it('surfaces a resubmission failure inline', async () => {
    setMockRow(earnWithdrawTx({ phase: 'failed', error: 'boom' }));
    mockRetryEarnWithdrawReceive.mockRejectedValue(new Error('epoch is down'));
    await renderAndLoad();

    fireEvent.click(screen.getByText('retry'));
    await flush();

    expect(screen.getByText('epoch is down')).toBeInTheDocument();
  });

  it('renders the full withdraw detail card once the intent, settlement tx and note are known', async () => {
    setMockRow(
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
    setMockRow(earnWithdrawTx({ phase: 'redeeming', marketUid: ':11155111:0xabc' }));
    await renderAndLoad();

    expect(rowByLabel('earnMarketLabel')?.textContent).toBe(':11155111:0xabc');
  });

  it('shows the note row as pending until the bridged note lands', async () => {
    setMockRow(earnWithdrawTx({ phase: 'redeeming' }));
    await renderAndLoad();

    expect(rowByLabel('note')?.textContent).toBe('pending');
    expect(rowByLabel('redeemIntentLabel')).toBeUndefined();
  });

  // The initiating context's poller dies with its popup, so an in-flight detail
  // page restarts one — exactly once per nonce — and reloads the row on a timer.
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

  it('renders the deposit detail card with the intent nonce and Sepolia settlement tx', async () => {
    setMockRow(
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

  it.each([
    ['while depositing', 'Depositing', 1],
    ['once deposited', 'Deposited to lending', STATUS_COMPLETED],
    ['after a failure', 'Failed', 3]
  ])('points From/To outward %s', async (_label, displayMessage, status) => {
    // The collateral leaves the user's account (`accountId`) for the Epoch
    // allocator (`secondaryAccountId` = sendParams.recipientId). None of the
    // deposit's display messages is ever 'Sent', so a direction rule keyed on
    // `txType === 'send' || message === 'Sent'` rendered this exactly backwards.
    setMockRow(earnDepositTx({}, { displayMessage, status }));
    await renderAndLoad();

    expect(rowByLabel('from')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-address', 'acct-A');
    expect(rowByLabel('to')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-address', 'acct-B');
  });

  it('falls back to the raw market uid when it has no protocol segment', async () => {
    setMockRow(earnDepositTx({ marketUid: ':11155111:0xabc' }));
    await renderAndLoad();

    expect(rowByLabel('earnMarketLabel')?.textContent).toBe(':11155111:0xabc');
  });

  it('omits the intent and settlement rows before the lending leg reports them', async () => {
    setMockRow(earnDepositTx({}, { transactionId: undefined }));
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
    setMockRow(earnDepositTx(epochStatus ? { epochStatus } : {}));
    await renderAndLoad();

    expect(screen.queryByTestId('status-pill')).toBeNull();
    expect(document.body.textContent).toContain(label);
  });

  it('falls back to the Miden status pill until the collateral note lands', async () => {
    // Status 1 === GeneratingTransaction: the deposit hasn't reached Miden yet.
    setMockRow(earnDepositTx({ epochStatus: 'pending' }, { status: 1 }));
    await renderAndLoad();

    expect(screen.getByTestId('status-pill')).toHaveAttribute('data-status', '1');
  });
});
