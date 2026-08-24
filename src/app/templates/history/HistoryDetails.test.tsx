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
const mockIsUnverifiableSendRetryError = jest.fn((..._args: unknown[]) => false);

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

const rowByLabel = (label: string) =>
  Array.from(document.querySelectorAll('[data-testid="detail-row"]')).find(
    el => el.getAttribute('data-label') === label
  );

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` wipes recorded calls but NOT queued `...Once` values, so a
  // test that failed before consuming its queue used to hand its leftovers to
  // the next one — which then failed for a reason that had nothing to do with it.
  mockTrackOrderId.mockReset();
  mockGetSwapSettlementNotes.mockReset();
  mockGetTransactionById.mockReset();
  // Keep IndexedDB/Dexie's scheduling primitives real so the global database
  // cleanup hook can complete; only timer-based order polling needs faking.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });

  mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([]));
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

    it('does not let a stale rejection replace a receipt that already rendered', async () => {
      // Reloads overlap by design (a queued row reloads every 3s), and the
      // success path is generation-guarded while the catch was not. So an older
      // load rejecting after a newer one had rendered replaced a perfectly good
      // receipt with the error screen — permanently, because the load effect is
      // gated on `!loadError` and that screen offers no retry.
      // Queued keeps the 3s reload interval alive, which is what makes loads
      // overlap in the first place.
      const queuedRow = { ...baseSendTx, status: 0 };
      let rejectStale: (reason: Error) => void = () => {};
      mockGetTransactionById
        .mockResolvedValueOnce(queuedRow)
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectStale = reject;
            })
        )
        .mockResolvedValue(queuedRow);

      await renderAndLoad();

      // Second load starts and hangs; the third supersedes it and renders.
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });
      await flush();
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });
      await flush();

      // Only now does the superseded load fail.
      await act(async () => {
        rejectStale(new Error('stale-boom'));
        await Promise.resolve();
      });
      await flush();

      expect(screen.queryByText('stale-boom')).not.toBeInTheDocument();
      expect(screen.queryByText('smthWentWrong')).not.toBeInTheDocument();
    });

    it('still renders the swap receipt when the settlement-note lookup fails', async () => {
      // The notes enrich the receipt; they are not what it is for. Sharing the
      // main try meant one failed Dexie scan replaced the whole receipt with an
      // error screen that never retried.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockGetSwapSettlementNotes.mockRejectedValue(new Error('dexie-down'));
      mockGetTransactionById.mockResolvedValue({
        ...baseSendTx,
        type: 'swap',
        amount: undefined,
        faucetId: 'faucet-1',
        outputNoteIds: undefined,
        transactionId: undefined,
        extraInputs: { orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, expiresAt: 1_700_000_120 }
      });

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-card')).toBeInTheDocument();
      expect(screen.queryByText('dexie-down')).not.toBeInTheDocument();
      expect(screen.queryByText('smthWentWrong')).not.toBeInTheDocument();
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
      mockGetTransactionById.mockResolvedValue({ ...baseSendTx });
      await renderAndLoad();

      expect(screen.queryByText(/historyDetailsFiatApprox/)).not.toBeInTheDocument();
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
      mockGetTransactionById.mockResolvedValue(consumeTx());
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
      mockGetTransactionById.mockResolvedValue(consumeTx({ status }));
      await renderAndLoad();

      expect(rowByLabel('consumed')).toBeUndefined();
      // And it must not degrade into "Created: 0" either — the note type alone
      // does not open the card.
      expect(rowByLabel('created')).toBeUndefined();
      expect(rowByLabel('noteTypeLabel')).toBeUndefined();
    });

    it('falls back to the scalar noteId on a legacy claim with no noteIds array', async () => {
      mockGetTransactionById.mockResolvedValue(consumeTx({ noteIds: undefined }));
      await renderAndLoad();

      expect(
        Array.from(rowByLabel('consumed')!.querySelectorAll('[data-testid="hash-chip"]')).map(c => c.textContent)
      ).toEqual(['note-1']);
    });

    it('omits the note-type row for a storage mode that is neither private nor public', async () => {
      mockGetTransactionById.mockResolvedValue(consumeTx({ noteType: 'P2ID' }));
      await renderAndLoad();
      expect(rowByLabel('noteTypeLabel')).toBeUndefined();
      expect(rowByLabel('consumed')).toBeDefined();
    });

    // A "Claim All" is bounded only by how many notes the user had waiting, so
    // an uncapped list can be hundreds of rows long.
    it('previews five notes behind a "+N more" tap and reveals the rest on click', async () => {
      const noteIds = Array.from({ length: 8 }, (_, i) => `note-${i}`);
      mockGetTransactionById.mockResolvedValue(consumeTx({ noteId: noteIds[0], noteIds }));
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
      mockGetTransactionById.mockResolvedValue(consumeTx({ noteId: noteIds[0], noteIds }));
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
      mockGetTransactionById.mockResolvedValue(
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
      mockGetTransactionById.mockResolvedValue(
        consumeTx({ amount: 20n, assetTotals: [{ faucetId: 'faucet-1', amount: 20n }] })
      );
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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 0,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([]));
      mockGetTransactionById.mockResolvedValue(
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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([]));
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusFilled');
      expect(screen.getByText('close')).toBeInTheDocument();
    });

    it('does not flicker between Loading and Not available while it retries', async () => {
      // `trackingLoading` gates the status word AND whether a whole row exists
      // in the notes list, so toggling it per retry mounted and unmounted that
      // row on every backoff step, reflowing the page each time.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId
        .mockResolvedValueOnce(null)
        // The retry hangs, so any per-attempt loading state would be visible.
        .mockReturnValue(new Promise(() => {}));
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();
      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('trackingUnavailable');

      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      await flush();

      expect(screen.getByTestId('swap-order-status')).toHaveTextContent('trackingUnavailable');
      expect(screen.getByTestId('swap-order-status')).not.toHaveTextContent('loading');
    });

    it('calls a partly-matched open order partially filled, not open', async () => {
      // 600 of 1000 matched on the DEX with the order still live. "Open" alone
      // understates it and the bar would be the only hint that anything landed.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 400n
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );
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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'reclaimed',
        currentDepth: 2,
        remainingOffered: 600n,
        remainingRequested: 600n
      });
      mockGetSwapSettlementNotes.mockResolvedValue({
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
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilledReclaimed');
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_400_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    });

    it('falls back to token metadata and reports an absent requested amount as unknown, not as zero', async () => {
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

    it('shows the active label and keeps polling until a terminal state', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId
        .mockResolvedValueOnce({
          orderId: '9',
          state: 'active',
          currentDepth: 1,
          remainingOffered: 1000n,
          // Nothing matched yet, so this is a plain Open order.
          remainingRequested: 1000n
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
      // A manual-consume order going Filled is precisely when the user has to
      // go and claim it: the counterparty matched the request, and the payback
      // notes are sitting unconsumed because nothing auto-consumes them. This
      // shortcut used to vanish at that exact moment.
      expect(screen.getByText('swapOpenPendingNotes')).toBeInTheDocument();
      expect(mockTrackOrderId).toHaveBeenCalledTimes(2);
    });

    it('drops the Pending Notes shortcut once the claim has been observed', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '9',
        state: 'filled',
        currentDepth: 3,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-x'], []));
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 9n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, autoConsume: false })
      );

      await renderAndLoad();

      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
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
          remainingOffered: 1000n,
          remainingRequested: 1000n
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
      // The on-chain lineage lags — it keeps reporting the order as still active
      // even though its own remainder shows the request fully matched...
      mockTrackOrderId.mockResolvedValue({
        orderId: '10',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      // ...but this wallet has already observed the settlement consume note.
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-x'], []));
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
        remainingOffered: 1000n,
        // Nothing was ever matched, so this is a plain reclaim.
        remainingRequested: 1000n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([], ['note-r']));
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
        remainingRequested: 0n
      });
      // Paybacks settled in one consume tick, the tip reclaimed in another — both
      // buckets are non-empty. The swap-row chip stamps "Settled" (funds received),
      // so this row must agree rather than showing "Reclaimed".
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-s'], ['note-r']));
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
      // Nothing is tracked, so the fill is unknown rather than zero.
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
      expect(mockTrackOrderId).not.toHaveBeenCalled();
    });

    it('renders an unknown-state receipt for a swap with entirely absent extraInputs', async () => {
      mockGetTransactionById.mockResolvedValue({ ...swapTx({}), extraInputs: undefined });
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

    it('keeps watching for later fills instead of freezing on the first one', async () => {
      // A multi-fill order settles again after the first note lands, and an
      // order placed while the user watches does not settle until it expires at
      // 120s. Stopping at the first note froze the receipt on fill 1 of n; a
      // 40s cap gave up a minute before the expiry batch it was waiting for.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 400n,
        remainingRequested: 400n
      });
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-1',
            transactionId: 'chain-1',
            noteIds: ['note-a'],
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
      expect(screen.getAllByTestId('hash-chip').map(chip => chip.textContent)).toContain('note-a');

      // A second fill settles while the receipt is open.
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a', 'note-b'],
        reclaimed: [],
        settledTransactions: [
          {
            id: 'consume-1',
            transactionId: 'chain-1',
            noteIds: ['note-a'],
            amount: 300n,
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

      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      await flush();

      expect(screen.getByText('swapFillNote_2')).toBeInTheDocument();
    });

    it('does not let a stale reload erase settlement rows already on screen', async () => {
      // The row reload and the settlement poll run concurrently, and the reload
      // wrote whatever it read unconditionally. A reload that queried the table
      // before the consume was written would therefore wipe rows the poll had
      // already published — and reset the poll's own progress with them.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 400n,
        remainingRequested: 400n
      });
      mockGetSwapSettlementNotes
        .mockResolvedValueOnce({
          settled: ['note-a'],
          reclaimed: [],
          settledTransactions: [
            {
              id: 'consume-1',
              transactionId: 'chain-1',
              noteIds: ['note-a'],
              amount: 300n,
              faucetId: 'req-faucet',
              completedAt: 1_700_000_100
            }
          ],
          reclaimedTransactions: []
        })
        // Every later read — including the one the reload interval makes — comes
        // back empty, as a read that raced the write would.
        .mockResolvedValue({ settled: [], reclaimed: [], settledTransactions: [], reclaimedTransactions: [] });
      mockGetTransactionById.mockResolvedValue({
        ...swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n }),
        // Queued keeps the 3s row-reload interval alive.
        status: 0
      });

      await renderAndLoad();
      expect(screen.getByText('swapFillNote_1')).toBeInTheDocument();

      await act(async () => {
        jest.advanceTimersByTime(6000);
      });
      await flush();

      expect(screen.getByText('swapFillNote_1')).toBeInTheDocument();
    });

    it('never scans for a receipt that was already settled when it was opened', async () => {
      // The scan is an unindexed read of the transactions table, and a receipt
      // opened after the fact has nothing to wait for. This is the counterweight
      // to the sibling-consume tail below: that tail must be earned by actually
      // watching the order unsettled, not handed to every old swap the user opens.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-a'], []));
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();
      const readsAfterLoad = mockGetSwapSettlementNotes.mock.calls.length;

      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      await flush();

      expect(mockGetSwapSettlementNotes.mock.calls.length).toBe(readsAfterLoad);
    });

    it('does not retract a known lineage state when a later poll comes back empty', async () => {
      // `trackOrderId` answers null for a transient sync hole as well as for an
      // untrackable order. Publishing that over a live 'active' retracted the
      // status to "Not available", unmounted the pending row and the progress
      // bar, and re-animated the bar from zero when the next poll succeeded.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId
        .mockResolvedValueOnce({
          orderId: '42',
          state: 'active',
          currentDepth: 1,
          remainingOffered: 600n,
          remainingRequested: 600n
        })
        .mockResolvedValue(null);
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();
      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilled');

      for (let i = 0; i < 4; i++) {
        await act(async () => {
          jest.advanceTimersByTime(4000);
        });
        await flush();
      }

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusPartiallyFilled');
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_400_1000_ ETH');
    });

    it('does not let a shorter settlement read take a fill row back off the screen', async () => {
      // Settlement only accumulates, so a read returning one of two completed
      // consumes is stale — a Dexie write in flight, or a sync rewriting rows.
      // Guarding only against an EMPTY read let a smaller non-empty snapshot
      // through, and the poller never repaired it because it publishes only what
      // reads differently from the last thing IT saw.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue(null);
      const consume = (id: string, note: string) => ({
        id,
        transactionId: `chain-${id}`,
        noteIds: [note],
        amount: 200n,
        faucetId: 'req-faucet',
        completedAt: 1_700_000_100
      });
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a', 'note-b'],
        reclaimed: [],
        settledTransactions: [consume('c1', 'note-a'), consume('c2', 'note-b')],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, autoConsume: false })
      );

      await renderAndLoad();
      expect(screen.getByText('swapFillNote_2')).toBeInTheDocument();

      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a'],
        reclaimed: [],
        settledTransactions: [consume('c1', 'note-a')],
        reclaimedTransactions: []
      });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          jest.advanceTimersByTime(3000);
        });
        await flush();
      }

      expect(screen.getByText('swapFillNote_2')).toBeInTheDocument();
    });

    it('picks up a re-attribution that leaves the note count unchanged', async () => {
      // `getSwapSettlementNotes` gives each note to the EARLIEST consume that
      // claimed it, so a consume completing out of order takes a note off the row
      // that was showing it and changes the amount attributed to the order —
      // without changing how many notes are known. Publishing only on a growing
      // count left the receipt reporting the superseded figure.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a'],
        reclaimed: [],
        settledTransactions: [
          { id: 'late-consume', transactionId: 'chain-2', noteIds: ['note-a'], amount: 300n, faucetId: 'req-faucet' }
        ],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();
      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_300_1000_ ETH');

      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a'],
        reclaimed: [],
        settledTransactions: [
          { id: 'early-consume', transactionId: 'chain-1', noteIds: ['note-a'], amount: 500n, faucetId: 'req-faucet' }
        ],
        reclaimedTransactions: []
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          jest.advanceTimersByTime(2000);
        });
        await flush();
      }

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_500_1000_ ETH');
    });

    it('does not scan for a terminal order whose notes only the user can claim', async () => {
      // Nothing is coming for a manual-consume order that already went terminal:
      // the wallet will not claim its notes on a schedule, so there is no event
      // to wait for. Reading "terminal but nothing recorded locally" as
      // still-waiting put a three-minute unindexed scan behind every such
      // receipt — and behind every restored history, which looks the same.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([]));
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, autoConsume: false })
      );

      await renderAndLoad();
      const readsAfterLoad = mockGetSwapSettlementNotes.mock.calls.length;

      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      await flush();

      expect(mockGetSwapSettlementNotes.mock.calls.length).toBe(readsAfterLoad);
    });

    it('still watches a terminal order the wallet is about to claim for itself', async () => {
      // The counterpart: with auto-consume on, a terminal order's paybacks are
      // claimed on the next reconcile tick, so the notes are moments away.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([]));
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-late']));
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      await flush();

      expect(screen.getByTestId('swap-settled-notes')).toHaveTextContent('note-late');
    });

    it('starts a fresh scan when a long-lived order finally reports terminal', async () => {
      // `expirySeconds` is per-row and can exceed anything this 2s poll could
      // outlast, so the receipt cannot simply set a longer deadline. The lineage
      // watch continues regardless, and its terminal transition earns the
      // settlement scan a new budget — otherwise an order that expired after the
      // cap showed its status but never its fill until the screen was reopened.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([]));
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, expirySeconds: 600 })
      );

      await renderAndLoad();

      // Well past the 90-poll (180s) settlement budget, still active.
      for (let i = 0; i < 120; i++) {
        await act(async () => {
          jest.advanceTimersByTime(2000);
        });
        await flush();
      }
      const readsWhileActive = mockGetSwapSettlementNotes.mock.calls.length;

      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([], ['note-after-expiry']));
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'reclaimed',
        currentDepth: 1,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });

      for (let i = 0; i < 5; i++) {
        await act(async () => {
          jest.advanceTimersByTime(3000);
        });
        await flush();
      }

      expect(mockGetSwapSettlementNotes.mock.calls.length).toBeGreaterThan(readsWhileActive);
      expect(screen.getByTestId('swap-reclaimed-notes')).toHaveTextContent('note-after-expiry');
    });

    it('lets the hero pill catch up when the order settles while the receipt is open', async () => {
      // The pill reads the persisted stamp so it agrees with the history list,
      // but a completed swap has no reload interval — so a receipt open across
      // its own settlement kept "Pending" above a section already listing the
      // fill. The row has to be re-read once this page can see the consume.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([]));
      const extraInputs = {
        expiresAt: 1_700_000_120,
        orderId: 42n,
        requestedFaucetId: 'req-faucet',
        requestedAmount: 1000n
      };
      const unstamped = { ...swapTx({}), extraInputs };
      mockGetTransactionById.mockResolvedValue(unstamped);

      await renderAndLoad();

      expect(screen.getByTestId('status-pill').getAttribute('data-swap-settlement')).toBe('pending');

      // The settlement consume completes; the background reconcile stamps the row.
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-late']));
      mockGetTransactionById.mockResolvedValue({
        ...unstamped,
        extraInputs: { ...extraInputs, settledAt: 1_700_000_300 }
      });

      // Stepped rather than one long jump: the note has to be published, which
      // mounts the re-read, before the re-read's own interval can fire.
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          jest.advanceTimersByTime(3000);
        });
        await flush();
      }

      expect(screen.getByTestId('status-pill').getAttribute('data-swap-settlement')).toBe('undefined');
    });

    it('does not spend the settlement budget on the row re-reads chasing the stamp', async () => {
      // The re-read above wants the ROW, but `loadTransaction` also scans for
      // settlement notes, and that scan is an unindexed pass over the whole
      // transactions table. Left on, twenty re-reads spent seven times the tail
      // budget the poller allows itself — a limit the surrounding code takes
      // considerable care to compute.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes([]));
      const extraInputs = { expiresAt: 1_700_000_120, orderId: 42n, requestedFaucetId: 'req-faucet' };
      // The stamp never lands, so the re-read runs to its full cap.
      mockGetTransactionById.mockResolvedValue({ ...swapTx({}), extraInputs });

      await renderAndLoad();
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-late']));
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      await flush();

      const afterSettlement = mockGetSwapSettlementNotes.mock.calls.length;
      // Two minutes of re-reads: 40 opportunities at the 3s interval.
      for (let i = 0; i < 40; i++) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          jest.advanceTimersByTime(3000);
        });
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }

      // The poller's own tail (5 polls) is the only thing still scanning.
      expect(mockGetSwapSettlementNotes.mock.calls.length - afterSettlement).toBeLessThanOrEqual(5);
      expect(mockGetTransactionById.mock.calls.length).toBeGreaterThan(5);
    });

    it('stops chasing a lineage that stays active after the settlement was observed', async () => {
      // Every poll takes the app-wide WASM lock, and on mobile/desktop this
      // screen stays mounted in the background — so an order whose lineage
      // never leaves 'active' must not poll for the lifetime of the app.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-a'], []));
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      // Well past the 15-poll (~30s) grace period.
      for (let i = 0; i < 40; i++) {
        await act(async () => {
          jest.advanceTimersByTime(2000);
        });
        await flush();
      }

      // Bounded on both sides: without the lower bound the watch could stop the
      // instant a settlement note appeared, and an order about to go terminal
      // would never pick up its final state.
      expect(mockTrackOrderId.mock.calls.length).toBeGreaterThanOrEqual(15);
      expect(mockTrackOrderId.mock.calls.length).toBeLessThanOrEqual(17);
    });

    it('lists the notes the suppressed settlement consumes claimed', async () => {
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a', 'note-b'],
        reclaimed: ['note-c'],
        settledTransactions: [
          { id: 'c-1', transactionId: 'ext-1', noteIds: ['note-a'], amount: undefined },
          { id: 'c-2', transactionId: 'ext-2', noteIds: ['note-b'], amount: undefined }
        ],
        reclaimedTransactions: [{ id: 'c-3', transactionId: 'ext-3', noteIds: ['note-c'], amount: undefined }]
      });
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

      await renderAndLoad();

      expect(mockGetSwapSettlementNotes).toHaveBeenCalledWith('tx-1');
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
            amount: undefined,
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

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_—_1000_ ETH');
      expect(screen.queryByTestId('swap-amount-progress-fill')).not.toBeInTheDocument();
    });

    it('still sums the fill when an unattributable consume is for the other side of the swap', async () => {
      // The offered-token tip comes back in its own consume and legitimately has
      // no bearing on the requested side, so it must not poison the total the way
      // an unattributable requested-token row does.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue(null);
      mockGetSwapSettlementNotes.mockResolvedValue({
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
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 400n,
        remainingRequested: 400n
      });
      mockGetTransactionById.mockResolvedValue(
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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      mockGetSwapSettlementNotes.mockResolvedValue({
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
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

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
            amount: 300n,
            faucetId: '',
            completedAt: 1_700_000_200
          }
        ],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'reclaimed',
        currentDepth: 1,
        remainingOffered: 600n,
        remainingRequested: 600n
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, autoConsume: false })
      );

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
      mockGetSwapSettlementNotes.mockResolvedValue({
        settled: ['note-a'],
        reclaimed: [],
        settledTransactions: [
          { id: 'local-uuid-2f8c', transactionId: undefined, noteIds: ['note-a'], amount: undefined }
        ],
        reclaimedTransactions: []
      });
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));

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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 1500n,
        remainingRequested: 1500n
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_0_1000_ ETH');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    });

    it('says nothing has been bundled only when the fill is actually known', async () => {
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

      await renderAndLoad();

      expect(screen.getByText('swapNoBundledNotes')).toBeInTheDocument();
    });

    it('withholds the "nothing bundled" claim from a receipt that cannot see the fill', async () => {
      // A restored wallet has no lineage and no tagged consumes, so it cannot
      // tell whether the order settled long ago. Denying it outright is worse
      // than saying nothing; the status line already reads "Not available".
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue(null);
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n })
      );

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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetTransactionById.mockResolvedValue(
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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'reclaimed',
        currentDepth: 1,
        remainingOffered: 1000n,
        remainingRequested: 1000n
      });
      mockGetTransactionById.mockResolvedValue(
        swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet', requestedAmount: 1000n, autoConsume: false })
      );

      await renderAndLoad();

      expect(screen.getByTestId('swap-order-status').textContent).toBe('orderStatusReclaimed');
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
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
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'active',
        currentDepth: 1,
        remainingOffered: 0n,
        remainingRequested: 400n
      });
      mockGetTransactionById.mockResolvedValue({
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
      mockGetTransactionById.mockResolvedValue({
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
      expect(mockTrackOrderId).not.toHaveBeenCalled();
      expect(screen.getByTestId('swap-order-status').textContent).toBe('trackingUnavailable');
      // A retry offers the whole swap again, so the receipt must not also be
      // offering its own in-card route out at the same time: the two action
      // groups are rendered by sibling, independently-gated conditionals.
      expect(screen.getByText('retry')).toBeInTheDocument();
      expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
      expect(screen.queryByText('close')).not.toBeInTheDocument();
    });

    it('omits the reclaimed row when the order only settled', async () => {
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-a'], []));
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
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-late'], []));
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

    it('picks up a sibling consume that lands after the order is already terminal', async () => {
      // Settlement bundles whatever has synced this tick, so a payback that syncs
      // later arrives in a SECOND consume — after the lineage has already gone
      // terminal. Treating the first observed note as completeness stopped the
      // scan there and left that fill off the receipt until the screen was
      // reopened.
      mockGetSwapTokenByFaucetId.mockReturnValue({ symbol: 'ETH', decimals: 8 });
      mockTrackOrderId.mockResolvedValue({
        orderId: '42',
        state: 'filled',
        currentDepth: 2,
        remainingOffered: 0n,
        remainingRequested: 0n
      });
      mockGetTransactionById.mockResolvedValue(swapTx({ orderId: 42n, requestedFaucetId: 'req-faucet' }));
      await renderAndLoad();

      // First consume lands while the page watches; the lineage is already terminal.
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-1'], []));
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      await flush();
      expect(screen.getByTestId('swap-settled-notes')).toHaveTextContent('note-1');

      // Its sibling lands two ticks later.
      mockGetSwapSettlementNotes.mockResolvedValue(settlementNotes(['note-1', 'note-2'], []));
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      await flush();

      expect(screen.getByTestId('swap-settled-notes')).toHaveTextContent('note-2');
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
      mockGetTransactionById.mockResolvedValue(failedSendTx({ error: TRANSACTION_STUCK_ERROR }));
      await renderAndLoad();

      expect(screen.getByTestId('history-retry-button')).toBeInTheDocument();
    });

    it('withholds Retry for a row the user cancelled by hand', async () => {
      mockGetTransactionById.mockResolvedValue(failedSendTx({ error: USER_CANCELLED_TRANSACTION_REASON }));
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
      mockGetTransactionById.mockResolvedValue(failedSendTx());
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
      mockGetTransactionById.mockResolvedValue(failedSendTx());
      mockRequeueFailedTransaction.mockRejectedValue(new Error('row is gone'));
      mockIsUnverifiableSendRetryError.mockReturnValue(false);
      await renderAndLoad();

      fireEvent.click(screen.getByText('retry'));
      await flush();

      expect(screen.queryByTestId('history-retry-anyway-button')).toBeNull();
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

  it.each([
    ['while depositing', 'Depositing', 1],
    ['once deposited', 'Deposited to lending', STATUS_COMPLETED],
    ['after a failure', 'Failed', 3]
  ])('points From/To outward %s', async (_label, displayMessage, status) => {
    // The collateral leaves the user's account (`accountId`) for the Epoch
    // allocator (`secondaryAccountId` = sendParams.recipientId). None of the
    // deposit's display messages is ever 'Sent', so a direction rule keyed on
    // `txType === 'send' || message === 'Sent'` rendered this exactly backwards.
    mockGetTransactionById.mockResolvedValue(earnDepositTx({}, { displayMessage, status }));
    await renderAndLoad();

    expect(rowByLabel('from')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-address', 'acct-A');
    expect(rowByLabel('to')!.querySelector('[data-testid="address-chip"]')).toHaveAttribute('data-address', 'acct-B');
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
