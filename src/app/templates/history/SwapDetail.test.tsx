import React from 'react';

import { render, screen } from '@testing-library/react';

import type { SwapSettlementTransaction } from 'lib/miden/activity';

import type { IHistoryEntry } from './IHistoryEntry';
import { SwapDetail } from './SwapDetail';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
}));

// The formatter keeps its DECIMALS argument visible. The parent's suite stubs it
// as `String(amount)`, which silently accepts a row rendered at the wrong scale —
// the whole reason this file exists.
jest.mock('lib/shared/format', () => ({
  formatAmount: jest.fn((amount: bigint | number | string, decimals?: number) => `${amount}@${decimals ?? 'default'}`)
}));

const mockGetExplorerTxUrl = jest.fn();

jest.mock('lib/miden-chain/constants', () => ({
  getExplorerTxUrl: (...args: unknown[]) => mockGetExplorerTxUrl(...args)
}));

jest.mock('lib/animation', () => ({
  springs: { standard: {} },
  useMotion: () => ({})
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => <span data-testid="icon" />,
  IconName: { ArrowRight: 'ArrowRight' }
}));

jest.mock('components/Button', () => ({
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => <button onClick={onClick}>{title}</button>,
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' }
}));

jest.mock('../HashChip', () => ({
  __esModule: true,
  default: ({ hash }: { hash: string }) => <span data-testid="hash-chip">{hash}</span>
}));

jest.mock('./DetailCard', () => ({
  DetailCard: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  DetailRow: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div data-testid="detail-row" data-label={label}>
      {children}
    </div>
  ),
  ExternalLinkValue: ({ displayValue, href }: { displayValue: React.ReactNode; href: string }) => (
    <a data-testid="external-link" href={href}>
      {displayValue}
    </a>
  ),
  StatusPill: () => <div data-testid="status-pill" />
}));

jest.mock('./TransactionIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="tx-icon" />
}));

jest.mock('./TransactionFailureCard', () => ({
  TransactionFailureCard: () => <div data-testid="failure-card" />
}));

jest.mock('./transactionUtils', () => ({
  ...jest.requireActual('./transactionUtils'),
  formatDate: (timestamp: number | string) => `formatted:${timestamp}`
}));

const REQUESTED_FAUCET = '0xfaucetrequested';
const OFFERED_FAUCET = '0xfaucetoffered';

const entry = {
  status: 2,
  amount: 500n,
  token: 'MID',
  timestamp: 1_700_000_000,
  txType: 'swap'
} as unknown as IHistoryEntry;

const consume = (over: Partial<SwapSettlementTransaction> = {}): SwapSettlementTransaction => ({
  id: 'local-row-1',
  transactionId: '0xchain1',
  noteIds: ['0xnote1'],
  amount: 685n,
  faucetId: REQUESTED_FAUCET,
  completedAt: 1_700_000_100,
  ...over
});

const renderDetail = (over: Partial<React.ComponentProps<typeof SwapDetail>> = {}) =>
  render(
    <SwapDetail
      entry={entry}
      requestedAmount={1000n}
      requestedDecimals={8}
      requestedSymbol="ETH"
      requestedFaucetId={REQUESTED_FAUCET}
      filledAmount={400n}
      orderState="active"
      trackingLoading={false}
      settledTransactions={[]}
      reclaimedTransactions={[]}
      fromAccount={<span>me</span>}
      showActions={false}
      onDismiss={jest.fn()}
      {...over}
    />
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockGetExplorerTxUrl.mockImplementation((txId: string) => `https://explorer.test/tx/${txId}`);
});

describe('SwapDetail amounts', () => {
  it('prints every amount at the scale of the token it belongs to', () => {
    renderDetail({ settledTransactions: [consume()] });

    // The requested side — total, fill and the per-row receipt — is denominated
    // in the requested token, so all three must carry ITS decimals. Falling back
    // to the wallet's default scale misstates funds by orders of magnitude, and
    // a formatter stub that drops the argument cannot see the difference.
    expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_400@8_1000@8_ ETH');
    expect(screen.getByText('swapReceivedAmount_685@8_ ETH')).toBeInTheDocument();
  });

  it('withholds a row amount it cannot attribute to the requested token', () => {
    // A consume's `amount` covers only its first input note's faucet, and an
    // expiry bundle carries the offered tip alongside the requested paybacks.
    renderDetail({
      settledTransactions: [
        consume({ id: 'other-side', faucetId: OFFERED_FAUCET }),
        // Half-written row: queued with a blank faucet, completed unstamped.
        consume({ id: 'unstamped', faucetId: '' }),
        consume({ id: 'no-amount', amount: undefined })
      ]
    });

    expect(screen.queryByText(/^swapReceivedAmount/)).not.toBeInTheDocument();
  });

  it('says nothing rather than zero when a side is unknown', () => {
    renderDetail({ requestedAmount: undefined, filledAmount: undefined });

    expect(screen.getByTestId('swap-order-amount-filled').textContent).toBe('swapAmountProgress_—_—_ ETH');
    expect(screen.queryByText(/^swapProgressPercent/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByTestId('swap-amount-progress-fill')).not.toBeInTheDocument();
  });
});

describe('SwapDetail progress', () => {
  it.each([
    [0n, 0],
    [1n, 0.1],
    [500n, 50],
    [999n, 99.9],
    [1000n, 100],
    // Over-fill cannot happen on a real lineage, but the bar must not overflow.
    [1500n, 100]
  ])('reports %s of 1000 as %s%%', (filled, expected) => {
    renderDetail({ filledAmount: filled });

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(expected));
  });

  it('keeps a tiny fill visible instead of rounding it away to nothing', () => {
    // Truncating division reports anything under a tenth of a percent as a flat
    // 0, which would draw an empty bar and "0%" beside a receipt row confirming
    // funds arrived. A floor keeps the two from contradicting each other.
    renderDetail({ requestedAmount: 10_000_000n, filledAmount: 1n });

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0.1');
    expect(screen.getByText('swapProgressPercent_0.1')).toBeInTheDocument();
  });
});

describe('SwapDetail status line', () => {
  const status = () => screen.getByTestId('swap-order-status');

  it.each([
    ['active', 1000n, 0n, 'orderStatusActive', 'text-status-pending'],
    ['active', 1000n, 400n, 'orderStatusPartiallyFilled', 'text-status-pending'],
    ['filled', 1000n, 1000n, 'orderStatusFilled', 'text-status-positive'],
    // A settle-tagged expiry bundle is how most partial fills end, so "Filled"
    // in green over a 40% fill is the single most misleading thing this line
    // could say.
    ['filled', 1000n, 400n, 'orderStatusPartiallyFilled', 'text-status-pending'],
    ['reclaimed', 1000n, 0n, 'orderStatusReclaimed', 'text-text-secondary-token'],
    ['reclaimed', 1000n, 400n, 'orderStatusPartiallyFilledReclaimed', 'text-text-secondary-token']
  ])('labels %s with %s filled as %s in %s', (orderState, requested, filled, label, tone) => {
    renderDetail({
      orderState: orderState as 'active' | 'filled' | 'reclaimed',
      requestedAmount: requested,
      filledAmount: filled
    });

    expect(status().textContent).toBe(label);
    // Tone asserted alongside the label: a reclaimed order rendered in the
    // positive colour reads as a success at a glance, whatever the words say.
    expect(status()).toHaveClass(tone);
  });

  it('distinguishes a lineage still loading from one that never answered', () => {
    renderDetail({ orderState: null, trackingLoading: true });
    expect(status().textContent).toBe('loading');
    expect(status()).toHaveClass('text-text-tertiary-token');

    renderDetail({ orderState: null, trackingLoading: false });
    expect(screen.getAllByTestId('swap-order-status')[1]!.textContent).toBe('trackingUnavailable');
  });

  it('cannot be told a fill is partial against the amounts it is showing', () => {
    // `isPartialFill` used to be a prop, so a caller could assert a partial fill
    // on a receipt whose own progress line read "— of 1000". It is now derived
    // from the two amounts rendered right above it.
    renderDetail({ orderState: 'filled', requestedAmount: undefined, filledAmount: undefined });

    expect(status().textContent).toBe('orderStatusFilled');
  });
});

describe('SwapDetail note rows', () => {
  it('numbers the fills and times each one in seconds', () => {
    renderDetail({ settledTransactions: [consume(), consume({ id: 'row-2', noteIds: ['0xnote2'] })] });

    expect(screen.getByText('swapFillNote_1')).toBeInTheDocument();
    expect(screen.getByText('swapFillNote_2')).toBeInTheDocument();
    // Persisted stamps are unix SECONDS; reading them as ms dates a fill to 1970.
    const expected = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(1_700_000_100 * 1000));
    expect(screen.getAllByText(`swapConsumedAt_${expected}`)).toHaveLength(2);
  });

  it('omits the time for a row whose stamp was never written', () => {
    renderDetail({ settledTransactions: [consume({ completedAt: 0 }), consume({ id: 'r2', completedAt: undefined })] });

    expect(screen.queryByText(/^swapConsumedAt/)).not.toBeInTheDocument();
  });

  it('shows a pending row only while the order can still be matched', () => {
    const { unmount } = renderDetail({ orderState: 'active' });
    expect(screen.getByText('swapOpenFill')).toBeInTheDocument();
    unmount();

    renderDetail({ orderState: 'filled' });
    expect(screen.queryByText('swapOpenFill')).not.toBeInTheDocument();
  });

  it('only denies that anything was bundled when the fill is actually known', () => {
    const { unmount } = renderDetail({ orderState: 'filled' });
    expect(screen.getByText('swapNoBundledNotes')).toBeInTheDocument();
    unmount();

    // With no lineage and no rows, "nothing has been bundled" is a confident
    // denial the receipt cannot support — and is plainly false for an order that
    // settled before the wallet was restored.
    renderDetail({ orderState: null, trackingLoading: false, filledAmount: undefined });
    expect(screen.queryByText('swapNoBundledNotes')).not.toBeInTheDocument();
  });
});

describe('SwapDetail explorer links', () => {
  it('links a consume by its chain id', () => {
    renderDetail({ settledTransactions: [consume()] });

    expect(screen.getByTestId('external-link')).toHaveAttribute('href', 'https://explorer.test/tx/0xchain1');
  });

  it('will not pass off a local row id as an on-chain identity', () => {
    // Before completion a consume has only its Dexie UUID. Linking that produced
    // a dead explorer link for a transaction the chain has never heard of.
    const { container } = renderDetail({ settledTransactions: [consume({ transactionId: undefined })] });

    expect(screen.queryByTestId('external-link')).not.toBeInTheDocument();
    // Still shown, just not as something the explorer can be asked about.
    expect(container.querySelector('[data-label="consumeTxId"]')).toHaveTextContent('local-row-1');
    expect(mockGetExplorerTxUrl).not.toHaveBeenCalled();
  });

  it('degrades to a plain hash on a build with no explorer', () => {
    mockGetExplorerTxUrl.mockReturnValue(undefined);
    renderDetail({ settledTransactions: [consume()] });

    expect(screen.queryByTestId('external-link')).not.toBeInTheDocument();
  });
});

describe('SwapDetail actions', () => {
  it('always offers a way off the screen when it owns the action bar', () => {
    // An order that reached the DEX has no cancel path, so this must not borrow
    // the destructive label — and there is no order state in which leaving the
    // screen stops being available.
    renderDetail({ showActions: true, orderState: 'filled' });

    expect(screen.getByText('close')).toBeInTheDocument();
    expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
  });

  it('offers the claim route only when given somewhere to go', () => {
    const onOpenPendingNotes = jest.fn();
    renderDetail({ showActions: true, onOpenPendingNotes });

    screen.getByText('swapOpenPendingNotes').click();
    expect(onOpenPendingNotes).toHaveBeenCalledTimes(1);
  });

  it('yields the action bar entirely when the parent owns it', () => {
    renderDetail({ showActions: false, onOpenPendingNotes: jest.fn() });

    expect(screen.queryByText('close')).not.toBeInTheDocument();
    expect(screen.queryByText('swapOpenPendingNotes')).not.toBeInTheDocument();
  });
});
