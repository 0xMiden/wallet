import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import HistoryView from './HistoryView';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import type { PendingActivityItem } from './PendingActivityCard';
import { bridgeRowDisplay, isFaucetRequest } from './transactionUtils';

// i18n: identity translator so `t(key)` returns the key verbatim, letting us
// assert on the raw translation keys the component passes in.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Icon: expose the requested glyph name + size + className so buildRowProps'
// icon selection (the white-fill classes, and that every row asks for the
// same glyph size) can be asserted.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, size, className }: { name: string; size?: string; className?: string }) => (
    <span data-testid="icon" data-name={name} data-size={size ?? ''} data-classname={className ?? ''} />
  ),
  IconName: {
    Faucet: 'Faucet',
    Close: 'Close',
    Receive: 'Receive',
    Send: 'Send',
    Convert: 'Convert',
    Earn: 'Earn',
    More: 'More',
    ArrowUpDown: 'ArrowUpDown'
  }
}));

// The date group must animate position only: a full `layout` would scale it, and
// the row inside passes its radius as a class, which Framer cannot counter-scale.
// Surface the prop so a revert to bare `layout` fails here.
// Spread the real module rather than listing exports - this file reaches
// `useReducedMotion` indirectly via `useMotion(springs.settle)`, so a hand-listed
// factory that misses one export throws on every render.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  return {
    ...jest.requireActual('framer-motion'),
    useReducedMotion: () => false,
    motion: {
      div: ReactActual.forwardRef(
        (
          { children, layout, transition, ...rest }: Record<string, unknown> & { children?: React.ReactNode },
          ref: React.Ref<HTMLDivElement>
        ) => (
          <div ref={ref} data-layout={String(layout)} {...rest}>
            {children}
          </div>
        )
      )
    }
  };
});

// ActivityRow: flatten every visual prop buildRowProps produces onto data-*
// attributes so each branch's output is directly assertable, and forward
// onClick so the navigate wiring can be exercised.
jest.mock('components/ui', () => ({
  ActivityRow: ({
    icon,
    iconBg,
    title,
    subtitle,
    amount,
    status,
    onClick,
    className
  }: {
    icon: React.ReactNode;
    iconBg?: string;
    title: string;
    subtitle?: string;
    amount?: {
      value: string;
      symbol?: string;
      direction?: string;
      extra?: { key: string; value: string; symbol?: string }[];
    };
    status: string;
    onClick?: () => void;
    className?: string;
  }) => (
    <div
      data-testid="activity-row"
      className={className}
      data-title={title}
      data-subtitle={subtitle ?? ''}
      data-iconbg={iconBg ?? ''}
      data-amount-value={amount?.value ?? ''}
      data-amount-symbol={amount?.symbol ?? ''}
      data-amount-direction={amount?.direction ?? ''}
      // Flattened as `key:value symbol|…` so both the contents AND the order
      // (the row renders them unsorted, first-seen) are assertable.
      data-amount-extra={(amount?.extra ?? []).map(l => `${l.key}:${l.value} ${l.symbol ?? ''}`).join('|')}
      data-status={status}
      data-clickable={onClick ? 'yes' : 'no'}
      onClick={onClick}
    >
      {icon}
    </div>
  ),
  // The real card, so the surface it draws onto each row is asserted as rendered.
  Card: jest.requireActual('components/ui/Card').Card,
  // The initial-loading placeholder; stub it to a marker.
  Spinner: () => <div data-testid="activity-spinner" />
}));

// EmptyState: minimal stand-in — a heading for the title plus the same `icon`
// testid shape the row-icon mock above uses, so existing assertions
// (`getByTestId('icon')`, `getByText('noOperationsFound')` as an H3) hold.
// Imported from its own module path in the source (not the `components/ui`
// barrel mocked above), so it needs its own mock.
jest.mock('components/ui/EmptyState', () => ({
  EmptyState: ({ icon, title, className }: { icon: string; title: string; className?: string }) => (
    <div data-testid="empty-state" data-classname={className}>
      <span data-testid="icon" data-name={icon} />
      <h3>{title}</h3>
    </div>
  )
}));

// HistoryItem is the legacy summary-row; stub it to echo the props HistoryView
// threads through (key/fullHistory/lastEntry).
jest.mock('./HistoryItem', () => ({
  __esModule: true,
  default: ({
    entry,
    fullHistory,
    lastEntry
  }: {
    entry: { key: string };
    fullHistory?: boolean;
    lastEntry?: boolean;
  }) => (
    <div
      data-testid="history-item"
      data-key={entry.key}
      data-fullhistory={String(fullHistory)}
      data-last={String(lastEntry)}
    />
  )
}));

// isFaucetRequest: pure predicate driven off a test-only `__faucet` marker so
// each entry can opt into the faucet branch independently.
jest.mock('./transactionUtils', () => ({
  isFaucetRequest: jest.fn((entry: { __faucet?: boolean }) => Boolean(entry.__faucet)),
  isBridgeInEntry: jest.fn(() => false),
  bridgeInRowDisplay: jest.fn(),
  bridgeRowDisplay: jest.fn(),
  // Smart Withdraw rows: mirror the real predicate so the earn branch of
  // `buildRowProps` is exercised with realistic values.
  isEarnWithdrawEntry: jest.fn((entry: { txType?: string }) => entry.txType === 'earn-withdraw'),
  // Smart Deposit settlement: mirror the real helper (unstamped ⇒ pending) so
  // the earn-deposit status branch is exercised with realistic values.
  earnDepositSettlementOf: jest.fn((entry: { earnDepositStatus?: string }) => entry.earnDepositStatus ?? 'pending')
}));

const mockBridgeRowDisplay = bridgeRowDisplay as jest.MockedFunction<typeof bridgeRowDisplay>;

// InfiniteScroll: render children inline, invoke getScrollParent so the
// `() => scrollParentRef.current` closure is exercised, and expose a button
// that drives loadMore.
jest.mock('react-infinite-scroller', () => ({
  __esModule: true,
  default: ({
    children,
    loadMore,
    hasMore,
    getScrollParent
  }: {
    children: React.ReactNode;
    loadMore: (page: number) => void;
    hasMore: boolean;
    getScrollParent?: () => unknown;
  }) => {
    const parent = getScrollParent?.();
    return (
      <div data-testid="infinite-scroll" data-hasmore={String(hasMore)} data-hasparent={String(Boolean(parent))}>
        <button data-testid="load-more" onClick={() => loadMore(2)}>
          load
        </button>
        {children}
      </div>
    );
  }
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

// Two distinct calendar days (midday to stay clear of TZ midnight boundaries).
const DAY_A = Math.floor(new Date(2024, 0, 15, 12, 0, 0).getTime() / 1000);
const DAY_B = Math.floor(new Date(2024, 0, 16, 12, 0, 0).getTime() / 1000);

type EntryOverrides = Partial<IHistoryEntry> & { __faucet?: boolean };

let keyCounter = 0;
const makeEntry = (overrides: EntryOverrides): IHistoryEntry => {
  keyCounter += 1;
  return {
    key: `k${keyCounter}`,
    address: 'addr',
    timestamp: DAY_A,
    message: '',
    type: HistoryEntryType.CompletedTransaction,
    txType: 'send',
    ...overrides
  } as IHistoryEntry;
};

const rowByTitle = (title: string) =>
  screen.getAllByTestId('activity-row').find(el => el.getAttribute('data-title') === title)!;

const iconNameIn = (row: HTMLElement) => within(row).getByTestId('icon').getAttribute('data-name');

beforeEach(() => {
  jest.clearAllMocks();
  keyCounter = 0;
  (isFaucetRequest as jest.Mock).mockImplementation((entry: { __faucet?: boolean }) => Boolean(entry.__faucet));
});

const noop = jest.fn();
const baseProps = {
  initialLoading: false,
  loadMore: noop,
  hasMore: false
};

describe('HistoryView empty state', () => {
  it('renders the loading Spinner while initially loading with no entries', () => {
    render(<HistoryView {...baseProps} entries={[]} initialLoading />);
    expect(screen.getByTestId('activity-spinner')).toBeInTheDocument();
  });

  it('renders the Activity-tab empty state flush under the filters, not vertically centered', () => {
    const { container } = render(<HistoryView {...baseProps} entries={[]} centerEmptyState />);
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
    // Centered variant shows the ArrowUpDown glyph.
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'ArrowUpDown');
    // Same top offset as the first date group (`pt-4`) — no vertical centering
    // or oversized spacer (`items-center`/`justify-center`/`pt-16`/`flex-1`).
    expect(container.querySelector('.pt-4')).not.toBeNull();
    expect(container.querySelector('.pt-16')).toBeNull();
    expect(container.querySelector('.items-center')).toBeNull();
    expect(container.querySelector('.justify-center')).toBeNull();
  });

  it('renders the summary (non-full) empty state with the m-4 layout class', () => {
    const { container } = render(<HistoryView {...baseProps} entries={[]} />);
    const heading = screen.getByText('noOperationsFound');
    expect(heading.tagName).toBe('H3');
    expect(container.querySelector('.m-4')).not.toBeNull();
    expect(container.querySelector('.mt-8')).toBeNull();
  });

  it('renders the full-history empty state flush under its section header', () => {
    const { container } = render(<HistoryView {...baseProps} entries={[]} fullHistory />);
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
    expect(container.querySelector('.mt-8')).toBeNull();
    expect(container.querySelector('.m-4')).toBeNull();
  });
});

describe('HistoryView summary (non-full) list', () => {
  it('renders one HistoryItem per entry, flagging only the last one', () => {
    const entries = [makeEntry({ key: 'first' }), makeEntry({ key: 'last' })];
    render(<HistoryView {...baseProps} entries={entries} className="summary-class" />);

    const items = screen.getAllByTestId('history-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-key', 'first');
    expect(items[0]).toHaveAttribute('data-last', 'false');
    expect(items[0]).toHaveAttribute('data-fullhistory', 'undefined');
    expect(items[1]).toHaveAttribute('data-key', 'last');
    expect(items[1]).toHaveAttribute('data-last', 'true');
  });
});

describe('HistoryView full-history rows (buildRowProps branches)', () => {
  // The row is a div with role=button and no tabIndex, so it cannot take focus. It gets press
  // feedback and nothing that claims focus behaviour: a ring that can never render, and
  // `select-none`, which would stop the activity text being selectable.
  it('gives a tappable row press feedback without claiming focus behaviour it cannot deliver', () => {
    render(
      <HistoryView
        entries={[makeEntry({ key: 'tappable', txId: 'tx-tappable' })]}
        initialLoading={false}
        loadMore={jest.fn()}
        hasMore={false}
        fullHistory
      />
    );

    const row = screen.getAllByTestId('activity-row')[0]!;
    expect(row.className).toContain('hover:bg-fill-pressed');
    expect(row.className).toContain('active:bg-fill-pressed');
    expect(row.className).not.toContain('focus-visible:ring-2');
    expect(row.className).not.toContain('select-none');
  });

  it('uses failed styling for a failed bridge row', () => {
    mockBridgeRowDisplay.mockReturnValue({
      inSymbol: 'MIDEN',
      outSymbol: 'USDC',
      outAmount: '10',
      providerLabel: 'AggLayer',
      network: 'Sepolia',
      status: 'failed'
    });
    render(
      <HistoryView
        {...baseProps}
        entries={[makeEntry({ key: 'bridge-failed', txType: 'bridged-send', txId: 'bridge-tx' })]}
        fullHistory
      />
    );

    const row = rowByTitle('bridgeRowTitle');
    expect(iconNameIn(row)).toBe('Close');
    expect(row).toHaveAttribute('data-iconbg', 'bg-status-negative');
    expect(row).toHaveAttribute('data-status', 'failed');
  });

  // One render exercising every icon/title/subtitle/amount/status branch.
  const entries: IHistoryEntry[] = [
    // --- Day A group (first group → gets pt-4; set + push + push) ---
    // Faucet request: RECEIVE icon, long address without underscore.
    makeEntry({
      key: 'faucet',
      __faucet: true,
      transactionIcon: 'RECEIVE',
      secondaryAddress: 'mtst1abcdefghijklmnop',
      amount: '100',
      token: 'MDN',
      txId: 'tx-faucet',
      timestamp: DAY_A
    }),
    // Failed via FAILED icon: underscore address, neutral amount sign.
    makeEntry({
      key: 'failed-icon',
      transactionIcon: 'FAILED',
      secondaryAddress: 'mtst1_underscoreaddress',
      amount: '5',
      token: 'MDN',
      message: 'Failed by icon',
      txId: 'tx-failed-icon',
      timestamp: DAY_A
    }),
    // Failed via message (icon is SEND but message === 'Transaction failed'),
    // no secondary address, no amount.
    makeEntry({
      key: 'failed-msg',
      transactionIcon: 'SEND',
      message: 'Transaction failed',
      txId: 'tx-failed-msg',
      timestamp: DAY_A
    }),

    // --- Day B group (second group → no pt-4; set + pushes) ---
    // Receive: short address (<=12 → returned as-is), positive amount.
    makeEntry({
      key: 'receive',
      transactionIcon: 'RECEIVE',
      secondaryAddress: '0x1234',
      amount: '50',
      token: 'MDN',
      message: 'Received',
      txId: 'tx-receive',
      timestamp: DAY_B
    }),
    // Send: negative amount, pending status.
    makeEntry({
      key: 'send',
      transactionIcon: 'SEND',
      secondaryAddress: 'mtst1longsendaddressnoUnderscore',
      amount: '20',
      token: 'MDN',
      message: 'Sent',
      txId: 'tx-send',
      type: HistoryEntryType.PendingTransaction,
      timestamp: DAY_B
    }),
    // Swap with both sides + requested amount: swap title, DEX subtitle,
    // requested-side amount, processing → pending.
    makeEntry({
      key: 'swap-full',
      transactionIcon: 'SWAP',
      txType: 'swap',
      token: 'MDN',
      requestedToken: 'ETH',
      requestedAmount: '0.5',
      amount: '10',
      message: 'swap ignored',
      txId: 'tx-swap-full',
      type: HistoryEntryType.ProcessingTransaction,
      timestamp: DAY_B
    }),
    // Mint: positive amount, no secondary address (subtitle undefined).
    makeEntry({
      key: 'mint',
      transactionIcon: 'MINT',
      amount: '7',
      token: 'MDN',
      message: 'Minted',
      txId: 'tx-mint',
      timestamp: DAY_B
    }),
    // Default: undefined icon (→ DEFAULT), empty message (→ '' title),
    // no amount, no txId (→ no onClick).
    makeEntry({
      key: 'default',
      transactionIcon: undefined,
      message: '',
      timestamp: DAY_B
    }),
    // Swap missing requestedToken/requestedAmount: title falls back to message,
    // amount falls back to entry.amount (neutral sign).
    makeEntry({
      key: 'swap-partial',
      transactionIcon: 'SWAP',
      txType: 'swap',
      token: 'MDN',
      amount: '3',
      message: 'swap fallback',
      txId: 'tx-swap-partial',
      timestamp: DAY_B
    }),
    // Swap missing token (left side of the && chain) — title falls back to
    // message, no amount at all.
    makeEntry({
      key: 'swap-notoken',
      transactionIcon: 'SWAP',
      txType: 'swap',
      requestedToken: 'ETH',
      message: 'swap notoken',
      txId: 'tx-swap-notoken',
      timestamp: DAY_B
    }),
    // Faucet whose icon is NOT receive: covers the `icon==='RECEIVE' || faucet`
    // right-hand branch for the "from" subtitle, plus a short address.
    makeEntry({
      key: 'faucet-send',
      __faucet: true,
      transactionIcon: 'SEND',
      secondaryAddress: 'shortaddr',
      amount: '1',
      token: 'MDN',
      txId: 'tx-faucet-send',
      timestamp: DAY_B
    }),
    // Smart Withdraw in flight: dedicated title/subtitle, positive amount and a
    // phase-driven status chip.
    makeEntry({
      key: 'earn-withdraw',
      txType: 'earn-withdraw',
      transactionIcon: undefined,
      earnWithdrawPhase: 'delivering',
      amount: '2',
      token: 'USDC',
      txId: 'tx-earn-withdraw',
      timestamp: DAY_B
    }),
    // Position deposit: DEFAULT icon, tagged with the Earn glyph and a negative amount.
    makeEntry({
      key: 'earn-deposit',
      txType: 'earn-deposit',
      transactionIcon: undefined,
      amount: '5',
      token: 'USDC',
      message: 'Depositing',
      txId: 'tx-earn-deposit',
      timestamp: DAY_B
    })
  ];

  const renderFull = () => render(<HistoryView {...baseProps} entries={entries} fullHistory className="full-class" />);

  it('animates each date group position only, so a removed row cannot scale the group', () => {
    const { container } = renderFull();

    const groups = container.querySelectorAll('[data-layout]');
    expect(groups.length).toBeGreaterThan(0);
    // Exact value on both sides: bare `layout` is `layout={true}` and stringifies
    // to 'true', so a not-'position' check alone would prove nothing.
    groups.forEach(group => expect(group).toHaveAttribute('data-layout', 'position'));
  });

  it('renders the Smart Withdraw row with its phase chip and positive amount', () => {
    renderFull();
    const row = rowByTitle('earnWithdrawRowTitle');
    expect(iconNameIn(row)).toBe('Earn');
    expect(row).toHaveAttribute('data-iconbg', 'bg-tx-earn');
    expect(row).toHaveAttribute('data-subtitle', 'earnWithdrawRowVia');
    expect(row).toHaveAttribute('data-amount-value', '+2');
    expect(row).toHaveAttribute('data-amount-symbol', 'USDC');
    expect(row).toHaveAttribute('data-amount-direction', 'positive');
    expect(row).toHaveAttribute('data-status', 'delivering');
  });

  it('renders a position deposit with the Earn glyph and a negative amount', () => {
    renderFull();
    const row = rowByTitle('Depositing');
    expect(iconNameIn(row)).toBe('Earn');
    expect(row).toHaveAttribute('data-iconbg', 'bg-tx-earn');
    expect(row).toHaveAttribute('data-amount-value', '-5');
    expect(row).toHaveAttribute('data-amount-direction', 'negative');
  });

  it('renders a date separator per calendar day', () => {
    renderFull();
    // Two groups → two long-date headers; the accent weekday appears too.
    expect(screen.getByText('January 15, 2024')).toBeInTheDocument();
    expect(screen.getByText('January 16, 2024')).toBeInTheDocument();
    expect(screen.getByText('Monday')).toBeInTheDocument();
    expect(screen.getByText('Tuesday')).toBeInTheDocument();
  });

  it('renders the faucet row (RECEIVE icon)', () => {
    renderFull();
    const row = rowByTitle('faucetRequestTitle');
    expect(iconNameIn(row)).toBe('Faucet');
    expect(row).toHaveAttribute('data-iconbg', 'bg-tx-faucet');
    expect(row).toHaveAttribute('data-subtitle', 'from: mtst1a…mnop');
    expect(row).toHaveAttribute('data-amount-value', '+100');
    expect(row).toHaveAttribute('data-amount-symbol', 'MDN');
    expect(row).toHaveAttribute('data-amount-direction', 'positive');
    expect(row).toHaveAttribute('data-status', 'confirmed');
  });

  it('sizes the faucet glyph the same as a sent/received row', () => {
    renderFull();
    const faucetSize = within(rowByTitle('faucetRequestTitle')).getByTestId('icon').getAttribute('data-size');
    const receivedSize = within(rowByTitle('Received')).getByTestId('icon').getAttribute('data-size');
    const sentSize = within(rowByTitle('Sent')).getByTestId('icon').getAttribute('data-size');
    expect(faucetSize).toBe('sm');
    expect(faucetSize).toBe(receivedSize);
    expect(faucetSize).toBe(sentSize);
  });

  it('renders the failed-by-icon row with neutral amount and underscore address', () => {
    renderFull();
    const row = rowByTitle('Failed by icon');
    // Failed rows use the raw failed-cross SVG (not the Icon component).
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row).toHaveAttribute('data-iconbg', 'bg-[#CC5D5D]');
    // Underscore address → slice(0,6)…slice(-7).
    expect(row).toHaveAttribute('data-subtitle', 'to: mtst1_…address');
    expect(row).toHaveAttribute('data-amount-value', '5');
    expect(row).toHaveAttribute('data-amount-direction', 'neutral');
    expect(row).toHaveAttribute('data-status', 'failed');
  });

  it('renders the failed-by-message row (no subtitle, no amount)', () => {
    renderFull();
    const row = rowByTitle('Transaction failed');
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row).toHaveAttribute('data-subtitle', '');
    expect(row).toHaveAttribute('data-amount-value', '');
    expect(row).toHaveAttribute('data-status', 'failed');
  });

  it('renders a user-cancelled row with grey styling and a cancelled status, even for a bridge', () => {
    render(
      <HistoryView
        entries={[
          makeEntry({
            key: 'cancelled-send',
            transactionIcon: 'FAILED',
            isCancelled: true,
            message: 'Cancelled',
            txId: 'tx-cancelled',
            timestamp: DAY_A
          }),
          makeEntry({
            key: 'cancelled-bridge',
            txType: 'bridged-send',
            transactionIcon: 'FAILED',
            isCancelled: true,
            message: 'Cancelled',
            txId: 'tx-cancelled-bridge',
            timestamp: DAY_A
          })
        ]}
        initialLoading={false}
        loadMore={jest.fn()}
        hasMore={false}
        fullHistory
      />
    );
    const rows = screen.getAllByTestId('activity-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Cancelled rows (incl. cancelled bridges) drop the bridge layout and
      // render the grey cancelled treatment.
      expect(row).toHaveAttribute('data-title', 'cancelled');
      expect(row).toHaveAttribute('data-iconbg', 'bg-gray-400');
      expect(row).toHaveAttribute('data-status', 'cancelled');
      expect(row.querySelector('svg')).not.toBeNull();
    }
  });

  it('renders the receive row with a short (<=12) address returned verbatim', () => {
    renderFull();
    const row = rowByTitle('Received');
    expect(iconNameIn(row)).toBe('Receive');
    expect(row).toHaveAttribute('data-iconbg', 'bg-tx-received');
    expect(row).toHaveAttribute('data-subtitle', 'from: 0x1234');
    expect(row).toHaveAttribute('data-amount-value', '+50');
    expect(row).toHaveAttribute('data-amount-direction', 'positive');
  });

  it('renders the send row with a negative amount and pending status', () => {
    renderFull();
    const row = rowByTitle('Sent');
    expect(iconNameIn(row)).toBe('Send');
    expect(row).toHaveAttribute('data-iconbg', 'bg-tx-sent');
    // Long address without underscore → slice(0,6)…slice(-4).
    expect(row).toHaveAttribute('data-subtitle', 'to: mtst1l…core');
    expect(row).toHaveAttribute('data-amount-value', '-20');
    expect(row).toHaveAttribute('data-amount-direction', 'negative');
    expect(row).toHaveAttribute('data-status', 'pending');
  });

  it('renders the full swap row: swap title, DEX subtitle, requested-side amount', () => {
    renderFull();
    const row = rowByTitle('swap MDN → ETH');
    expect(iconNameIn(row)).toBe('Convert');
    expect(row).toHaveAttribute('data-iconbg', 'bg-tx-swap');
    expect(row).toHaveAttribute('data-subtitle', 'viaInProtocolDex');
    expect(row).toHaveAttribute('data-amount-value', '0.5');
    expect(row).toHaveAttribute('data-amount-symbol', 'ETH');
    expect(row).toHaveAttribute('data-amount-direction', 'neutral');
    // Processing transaction → pending pill.
    expect(row).toHaveAttribute('data-status', 'pending');
  });

  it('renders the mint row with no subtitle and a positive amount', () => {
    renderFull();
    const row = rowByTitle('Minted');
    expect(iconNameIn(row)).toBe('Earn');
    expect(row).toHaveAttribute('data-iconbg', 'bg-tx-earn');
    expect(row).toHaveAttribute('data-subtitle', '');
    expect(row).toHaveAttribute('data-amount-value', '+7');
    expect(row).toHaveAttribute('data-amount-direction', 'positive');
  });

  it('renders every row on the shared fill card, with no border', () => {
    renderFull();
    const rows = screen.getAllByTestId('activity-row');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(row => {
      expect(row).toHaveClass('bg-fill', 'rounded-2xl', 'px-4', 'py-3');
      expect(row.className.split(/\s+/).some(c => /^border(-|$)/.test(c))).toBe(false);
      expect(row).not.toHaveClass('bg-white');
    });
  });

  it('gives a tappable row pressed feedback and leaves a plain row without it', () => {
    renderFull();
    expect(rowByTitle('Received')).toHaveClass('active:bg-fill-pressed');
    expect(rowByTitle('')).not.toHaveClass('active:bg-fill-pressed');
  });

  it('renders the default row (unknown icon, empty title, no amount, not clickable)', () => {
    renderFull();
    const row = rowByTitle('');
    expect(iconNameIn(row)).toBe('More');
    // On `page` with an `ink` glyph, so the circle stays visible on the card's `fill`.
    expect(row).toHaveAttribute('data-iconbg', 'bg-page');
    expect(within(row).getByTestId('icon')).toHaveAttribute('data-classname', 'text-ink');
    expect(row).toHaveAttribute('data-amount-value', '');
    // No txId → onClick is undefined.
    expect(row).toHaveAttribute('data-clickable', 'no');
  });

  it('falls back to message + entry.amount for a swap missing the requested side', () => {
    renderFull();
    const row = rowByTitle('swap fallback');
    expect(iconNameIn(row)).toBe('Convert');
    expect(row).toHaveAttribute('data-subtitle', 'viaInProtocolDex');
    expect(row).toHaveAttribute('data-amount-value', '3');
    expect(row).toHaveAttribute('data-amount-direction', 'neutral');
  });

  it('falls back to message for a swap missing the offered token', () => {
    renderFull();
    const row = rowByTitle('swap notoken');
    expect(row).toHaveAttribute('data-subtitle', 'viaInProtocolDex');
    // No entry.amount and no requestedAmount → no amount at all.
    expect(row).toHaveAttribute('data-amount-value', '');
  });

  it('renders a faucet row whose icon is not RECEIVE, still using the "from" subtitle', () => {
    renderFull();
    // Two faucet rows share the title; pick the one with the short address.
    const row = screen
      .getAllByTestId('activity-row')
      .find(el => el.getAttribute('data-subtitle') === 'from: shortaddr')!;
    expect(row).toBeTruthy();
    expect(iconNameIn(row)).toBe('Faucet');
    expect(row).toHaveAttribute('data-amount-value', '+1');
  });

  it('navigates to the details page when a row with a txId is clicked', () => {
    renderFull();
    fireEvent.click(rowByTitle('Received'));
    expect(navigate).toHaveBeenCalledWith('/history-details/tx-receive');
  });
});

describe('HistoryView token-scoped swap rows', () => {
  const swapEntry = makeEntry({
    key: 'swap-scoped',
    transactionIcon: 'SWAP',
    txType: 'swap',
    token: 'MDN',
    faucetId: 'offered-faucet',
    requestedToken: 'ETH',
    requestedFaucetId: 'requested-faucet',
    requestedAmount: '0.5',
    amount: '10',
    txId: 'tx-swap-scoped'
  });

  const renderScoped = (tokenId?: string) =>
    render(<HistoryView {...baseProps} entries={[swapEntry]} fullHistory tokenId={tokenId} />);

  it('signs the offered side negative on the offered token page', () => {
    renderScoped('offered-faucet');
    const row = screen.getByTestId('activity-row');
    expect(row).toHaveAttribute('data-amount-value', '-10');
    expect(row).toHaveAttribute('data-amount-symbol', 'MDN');
    expect(row).toHaveAttribute('data-amount-direction', 'negative');
  });

  it('signs the requested side positive on the requested token page', () => {
    renderScoped('requested-faucet');
    const row = screen.getByTestId('activity-row');
    expect(row).toHaveAttribute('data-amount-value', '+0.5');
    expect(row).toHaveAttribute('data-amount-symbol', 'ETH');
    expect(row).toHaveAttribute('data-amount-direction', 'positive');
  });

  it('keeps the unsigned requested side on the unscoped activity list', () => {
    renderScoped(undefined);
    const row = screen.getByTestId('activity-row');
    expect(row).toHaveAttribute('data-amount-value', '0.5');
    expect(row).toHaveAttribute('data-amount-direction', 'neutral');
  });

  it('falls back to the unscoped rendering when the token matches neither side', () => {
    renderScoped('unrelated-faucet');
    const row = screen.getByTestId('activity-row');
    expect(row).toHaveAttribute('data-amount-value', '0.5');
    expect(row).toHaveAttribute('data-amount-direction', 'neutral');
  });

  it('falls through when the scoped side has no amount to show', () => {
    const noOffered = makeEntry({
      key: 'swap-no-offered',
      transactionIcon: 'SWAP',
      txType: 'swap',
      token: 'MDN',
      faucetId: 'offered-faucet',
      requestedToken: 'ETH',
      requestedFaucetId: 'requested-faucet',
      requestedAmount: '0.5',
      amount: undefined,
      txId: 'tx-swap-no-offered'
    });
    render(<HistoryView {...baseProps} entries={[noOffered]} fullHistory tokenId="offered-faucet" />);
    const row = screen.getByTestId('activity-row');
    expect(row).toHaveAttribute('data-amount-value', '0.5');
    expect(row).toHaveAttribute('data-amount-direction', 'neutral');
  });
});

// A "Claim All" is filed under its FIRST note's faucet while sweeping up every
// other faucet, so the row has to say what else arrived — and must not say it on
// a page scoped to a token the claim never touched.
describe('HistoryView batch-claim extra assets', () => {
  const claimEntry = (overrides: Partial<IHistoryEntry> = {}) =>
    makeEntry({
      key: 'claim',
      transactionIcon: 'RECEIVE',
      txType: 'consume',
      message: 'Claimed',
      faucetId: 'faucet-a',
      amount: '20',
      token: 'AAA',
      extraAmounts: [
        { faucetId: 'faucet-b', amount: '10', token: 'BBB' },
        { faucetId: 'faucet-c', amount: '5', token: 'CCC' }
      ],
      txId: 'tx-claim',
      ...overrides
    });

  const renderClaim = (tokenId?: string, overrides: Partial<IHistoryEntry> = {}) => {
    render(<HistoryView {...baseProps} entries={[claimEntry(overrides)]} fullHistory tokenId={tokenId} />);
    return screen.getByTestId('activity-row');
  };

  it('appends every secondary asset, signed and in order, on the unscoped list', () => {
    const row = renderClaim(undefined);
    expect(row).toHaveAttribute('data-amount-value', '+20');
    expect(row).toHaveAttribute('data-amount-symbol', 'AAA');
    expect(row).toHaveAttribute('data-amount-extra', 'faucet-b:+10 BBB|faucet-c:+5 CCC');
  });

  it('shows only the scoped faucet total on that token page, never a foreign asset', () => {
    // Listing "+10 BBB" on token C's page states a balance change that never
    // touched C — the same reason a swap row is signed by side when scoped.
    const row = renderClaim('faucet-c');
    expect(row).toHaveAttribute('data-amount-value', '+5');
    expect(row).toHaveAttribute('data-amount-symbol', 'CCC');
    expect(row).toHaveAttribute('data-amount-extra', '');
  });

  it('keeps the row faucet total, with no extras, on the primary token page', () => {
    const row = renderClaim('faucet-a');
    expect(row).toHaveAttribute('data-amount-value', '+20');
    expect(row).toHaveAttribute('data-amount-symbol', 'AAA');
    expect(row).toHaveAttribute('data-amount-extra', '');
  });

  it('omits the extras entirely for a single-asset claim', () => {
    const row = renderClaim(undefined, { extraAmounts: undefined });
    expect(row).toHaveAttribute('data-amount-value', '+20');
    expect(row).toHaveAttribute('data-amount-extra', '');
  });

  it('signs the extras like the primary amount on an outgoing row', () => {
    const row = renderClaim(undefined, { transactionIcon: 'SEND', txType: 'send' });
    expect(row).toHaveAttribute('data-amount-value', '-20');
    expect(row).toHaveAttribute('data-amount-extra', 'faucet-b:-10 BBB|faucet-c:-5 CCC');
  });

  // `ConsumeTransaction` leaves `amount` undefined when the FIRST note's value is
  // unknown, and a zero total is a real total. Gating the extras on a headline
  // the batch may legitimately lack would blank every asset the claim collected.
  it('promotes the first secondary asset when the claim has no headline amount', () => {
    const row = renderClaim(undefined, { amount: undefined, token: undefined });
    expect(row).toHaveAttribute('data-amount-value', '+10');
    expect(row).toHaveAttribute('data-amount-symbol', 'BBB');
    expect(row).toHaveAttribute('data-amount-extra', 'faucet-c:+5 CCC');
  });

  it('keeps a zero primary total and its extras', () => {
    const row = renderClaim(undefined, { amount: '0' });
    expect(row).toHaveAttribute('data-amount-value', '+0');
    expect(row).toHaveAttribute('data-amount-symbol', 'AAA');
    expect(row).toHaveAttribute('data-amount-extra', 'faucet-b:+10 BBB|faucet-c:+5 CCC');
  });

  it('still scopes correctly when there is no headline amount', () => {
    const row = renderClaim('faucet-c', { amount: undefined, token: undefined });
    expect(row).toHaveAttribute('data-amount-value', '+5');
    expect(row).toHaveAttribute('data-amount-symbol', 'CCC');
    expect(row).toHaveAttribute('data-amount-extra', '');
  });

  // An extra whose faucet never resolved carries no amount: its decimals are
  // unknown, and the unknown-token fallback's 6 would render an 18-decimal token
  // 10^12 too large. The asset is still named — a claim that swept it up did
  // happen — it just goes unquantified.
  it('names an unquantified secondary asset without inventing a number', () => {
    const row = renderClaim(undefined, {
      extraAmounts: [
        { faucetId: 'faucet-b', amount: undefined, token: 'Unknown' },
        { faucetId: 'faucet-c', amount: '5', token: 'CCC' }
      ]
    });
    expect(row).toHaveAttribute('data-amount-value', '+20');
    expect(row).toHaveAttribute('data-amount-extra', 'faucet-b: Unknown|faucet-c:+5 CCC');
  });

  // The headline is the row's one prominent number, so a quantified line wins
  // the promotion even when an unquantified one precedes it.
  it('promotes a quantified line over an unquantified one', () => {
    const row = renderClaim(undefined, {
      amount: undefined,
      token: undefined,
      extraAmounts: [
        { faucetId: 'faucet-b', amount: undefined, token: 'Unknown' },
        { faucetId: 'faucet-c', amount: '5', token: 'CCC' }
      ]
    });
    expect(row).toHaveAttribute('data-amount-value', '+5');
    expect(row).toHaveAttribute('data-amount-symbol', 'CCC');
    expect(row).toHaveAttribute('data-amount-extra', 'faucet-b: Unknown');
  });

  // The discriminating case for keying promotion on the TOKEN rather than the
  // amount: the primary is NAMED but unquantified, so it still owns the
  // headline. Promoting the quantified secondary would file the row under
  // faucet A while reading as a credit of C.
  it('keeps a named but unquantified primary in the headline', () => {
    const row = renderClaim(undefined, {
      amount: undefined,
      token: 'AAA',
      extraAmounts: [{ faucetId: 'faucet-c', amount: '5', token: 'CCC' }]
    });
    expect(row).toHaveAttribute('data-amount-value', '');
    expect(row).toHaveAttribute('data-amount-symbol', 'AAA');
    expect(row).toHaveAttribute('data-amount-extra', 'faucet-c:+5 CCC');
  });

  // A single-faucet row whose scale is unknown has no extras to fall back on.
  // Skipping the amount block entirely would drop the asset's NAME too, leaving
  // a row that says nothing about what moved.
  it('names a lone asset that has no trustworthy number', () => {
    const row = renderClaim(undefined, { amount: undefined, token: 'Unknown', extraAmounts: undefined });
    expect(row).toHaveAttribute('data-amount-value', '');
    expect(row).toHaveAttribute('data-amount-symbol', 'Unknown');
  });

  // Nothing to promote but the unquantified line itself. Rendering no amount at
  // all would erase every asset the claim collected, so the row names the asset
  // and shows no number.
  it('renders a claim whose every asset is unquantified', () => {
    const row = renderClaim(undefined, {
      amount: undefined,
      token: undefined,
      extraAmounts: [{ faucetId: 'faucet-b', amount: undefined, token: 'Unknown' }]
    });
    expect(row).toHaveAttribute('data-amount-value', '');
    expect(row).toHaveAttribute('data-amount-symbol', 'Unknown');
    expect(row).toHaveAttribute('data-amount-extra', '');
  });

  // A token page scoped to the unresolvable faucet: same rule, one line.
  it('shows the scoped faucet unquantified rather than at a guessed scale', () => {
    const row = renderClaim('faucet-b', {
      extraAmounts: [{ faucetId: 'faucet-b', amount: undefined, token: 'Unknown' }]
    });
    expect(row).toHaveAttribute('data-amount-value', '');
    expect(row).toHaveAttribute('data-amount-symbol', 'Unknown');
  });
});

describe('HistoryView infinite scroll wiring', () => {
  const twoEntries = [
    makeEntry({ key: 'a', message: 'A', txId: 'txa', transactionIcon: 'SEND', amount: '1', token: 'MDN' }),
    makeEntry({ key: 'b', message: 'B', txId: 'txb', transactionIcon: 'SEND', amount: '2', token: 'MDN' })
  ];

  it('wraps the list in InfiniteScroll when a scrollParentRef is provided', () => {
    const parent = document.createElement('div');
    const loadMore = jest.fn();
    render(
      <HistoryView
        {...baseProps}
        entries={twoEntries}
        fullHistory
        hasMore
        loadMore={loadMore}
        scrollParentRef={{ current: parent }}
      />
    );

    const scroller = screen.getByTestId('infinite-scroll');
    expect(scroller).toHaveAttribute('data-hasmore', 'true');
    // getScrollParent() resolved to the provided ref's current element.
    expect(scroller).toHaveAttribute('data-hasparent', 'true');

    fireEvent.click(screen.getByTestId('load-more'));
    expect(loadMore).toHaveBeenCalledWith(2);
  });

  it('renders the plain list (no InfiniteScroll) when scrollParentRef is absent', () => {
    render(<HistoryView {...baseProps} entries={twoEntries} fullHistory />);
    expect(screen.queryByTestId('infinite-scroll')).toBeNull();
    expect(screen.getAllByTestId('activity-row')).toHaveLength(2);
  });
});

describe('HistoryView Guardian switch audit trail', () => {
  it('shows custom provider hosts for every transaction status', () => {
    const entries = [
      makeEntry({
        key: 'queued-switch',
        txType: 'switch-guardian',
        message: 'Switching guardian',
        previousGuardianEndpoint: 'https://old.example/path',
        newGuardianEndpoint: 'https://new.example/guardian',
        type: HistoryEntryType.PendingTransaction
      }),
      makeEntry({
        key: 'processing-switch',
        txType: 'switch-guardian',
        message: 'Switching guardian',
        previousGuardianEndpoint: 'https://old.example/path',
        newGuardianEndpoint: 'https://new.example/guardian',
        type: HistoryEntryType.ProcessingTransaction
      }),
      makeEntry({
        key: 'completed-switch',
        txType: 'switch-guardian',
        message: 'Guardian switched',
        previousGuardianEndpoint: 'https://old.example/path',
        newGuardianEndpoint: 'https://new.example/guardian'
      }),
      makeEntry({
        key: 'failed-switch',
        txType: 'switch-guardian',
        message: 'Transaction failed',
        transactionIcon: 'FAILED',
        previousGuardianEndpoint: 'https://old.example/path',
        newGuardianEndpoint: 'https://new.example/guardian'
      })
    ];

    render(<HistoryView {...baseProps} entries={entries} fullHistory />);

    for (const row of screen.getAllByTestId('activity-row')) {
      expect(row).toHaveAttribute('data-subtitle', 'old.example → new.example');
    }
    expect(screen.getAllByTestId('activity-row')[0]).toHaveAttribute('data-status', 'pending');
    expect(screen.getAllByTestId('activity-row')[1]).toHaveAttribute('data-status', 'pending');
    expect(screen.getAllByTestId('activity-row')[2]).toHaveAttribute('data-status', 'confirmed');
    expect(screen.getAllByTestId('activity-row')[3]).toHaveAttribute('data-status', 'failed');
    for (const row of screen.getAllByTestId('activity-row').slice(0, 3)) {
      expect(row).toHaveAttribute('data-iconbg', 'bg-[#777487]');
      expect(row.querySelector('svg')).not.toBeNull();
    }
    expect(screen.getAllByTestId('activity-row')[3]).toHaveAttribute('data-iconbg', 'bg-[#CC5D5D]');
  });

  it('renders legacy rows with an unknown source and the recorded destination', () => {
    const entry = makeEntry({
      txType: 'switch-guardian',
      message: 'Guardian switched',
      newGuardianEndpoint: 'https://destination.example'
    });
    render(<HistoryView {...baseProps} entries={[entry]} fullHistory />);

    expect(screen.getByTestId('activity-row')).toHaveAttribute('data-subtitle', 'unknown → destination.example');
  });
});

// A completed swap row is the one trace of the whole order, so its badge follows settlement.
describe('HistoryView swap settlement status', () => {
  it.each([
    ['pending', 'pending'],
    ['reclaimed', 'reclaimed'],
    [undefined, 'confirmed']
  ] as const)('reads %s settlement as the %s status', (swapSettlement, status) => {
    const entry = makeEntry({
      txType: 'swap',
      token: 'MDN',
      requestedToken: 'ETH',
      requestedAmount: '0.5',
      amount: '10',
      message: 'swap settled',
      swapSettlement
    });
    render(<HistoryView {...baseProps} entries={[entry]} fullHistory />);
    expect(screen.getByTestId('activity-row')).toHaveAttribute('data-status', status);
  });
});

// A Smart Deposit row goes database-Completed as soon as the Miden collateral
// note lands — but the position only exists once the solver-fulfilled Sepolia
// lending leg settles, so the chip must track THAT leg, not the row status.
describe('HistoryView earn-deposit status chip', () => {
  const renderDeposit = (overrides: Partial<IHistoryEntry> = {}) => {
    const entry = makeEntry({
      txType: 'earn-deposit',
      message: 'Depositing',
      amount: '5',
      token: 'USDC',
      ...overrides
    });
    render(<HistoryView {...baseProps} entries={[entry]} fullHistory />);
    return rowByTitle('Depositing');
  };

  it('reads pending while the lending leg is unsettled', () => {
    const row = renderDeposit({ earnDepositStatus: 'pending' });
    expect(row).toHaveAttribute('data-status', 'pending');
  });

  it('defaults an unstamped leg to pending rather than Confirmed', () => {
    const row = renderDeposit();
    expect(row).toHaveAttribute('data-status', 'pending');
  });

  it('reads failed when the lending leg failed', () => {
    const row = renderDeposit({ earnDepositStatus: 'failed' });
    expect(row).toHaveAttribute('data-status', 'failed');
  });

  it('falls through to Confirmed once the lending leg settles', () => {
    const row = renderDeposit({ earnDepositStatus: 'confirmed' });
    expect(row).toHaveAttribute('data-status', 'confirmed');
  });

  it('lets a Miden-side failure win over a pending lending leg', () => {
    // The earn-deposit branch is checked AFTER cancelled/failed/pending, so the
    // real failure is what the user sees.
    const row = renderDeposit({ transactionIcon: 'FAILED', earnDepositStatus: 'pending' });
    expect(row).toHaveAttribute('data-status', 'failed');
  });

  it('lets a cancellation win over a pending lending leg', () => {
    const entry = makeEntry({ txType: 'earn-deposit', message: 'Depositing', isCancelled: true });
    render(<HistoryView {...baseProps} entries={[entry]} fullHistory />);
    const row = rowByTitle('cancelled');
    expect(row).toHaveAttribute('data-status', 'cancelled');
  });

  it('lets a still-processing row win over the lending leg', () => {
    const row = renderDeposit({ type: HistoryEntryType.PendingTransaction, earnDepositStatus: 'failed' });
    expect(row).toHaveAttribute('data-status', 'pending');
  });
  // date-fns THROWS on an Invalid Date, so one unusable timestamp used to take
  // the whole list down rather than just its own row. `Number.isFinite` alone is
  // not enough — 1e300 is finite and still overflows the Date range.
  describe('an unusable timestamp', () => {
    it.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['out of Date range', 1e300]
    ])('still renders the row when the timestamp is %s', (_label, timestamp) => {
      expect(() => render(<HistoryView {...baseProps} entries={[makeEntry({ timestamp })]} />)).not.toThrow();

      expect(screen.getAllByTestId('history-item')).toHaveLength(1);
    });
  });
});

it('places pending notes between transactions by inclusion date in the same date groups', () => {
  const pending: PendingActivityItem = {
    note: {
      id: 'pending-note',
      faucetId: 'faucet',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: 'unknown',
      receivedAt: DAY_A + 60,
      metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
    },
    status: 'pending'
  };
  const { container } = render(
    <HistoryView
      fullHistory
      initialLoading={false}
      hasMore={false}
      loadMore={async () => {}}
      entries={[makeEntry({ key: 'newest', timestamp: DAY_B }), makeEntry({ key: 'oldest', timestamp: DAY_A })]}
      pendingItems={[pending]}
      renderPendingItem={() => <span data-testid="pending-date-row">Pending note</span>}
    />
  );
  const rows = [...container.querySelectorAll('[data-testid="activity-row"], [data-testid="pending-date-row"]')];
  expect(rows.map(row => row.getAttribute('data-testid'))).toEqual([
    'activity-row',
    'pending-date-row',
    'activity-row'
  ]);
  expect(screen.getAllByText('January 15, 2024')).toHaveLength(1);
  expect(screen.getAllByText('January 16, 2024')).toHaveLength(1);
});

it('keeps an undated note visible without assigning a false date', () => {
  const pending: PendingActivityItem = {
    note: {
      id: 'undated-note',
      faucetId: 'faucet',
      amount: '100',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: 'unknown',
      metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
    },
    status: 'pending'
  };
  render(
    <HistoryView
      fullHistory
      initialLoading={false}
      hasMore={false}
      loadMore={async () => {}}
      entries={[]}
      pendingItems={[pending]}
      renderPendingItem={() => <span>Pending note</span>}
    />
  );
  expect(screen.getByText('activityDateUnavailable')).toBeInTheDocument();
  expect(screen.getByText('Pending note')).toBeInTheDocument();
});
