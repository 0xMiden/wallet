import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import HistoryView from './HistoryView';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { isFaucetRequest } from './transactionUtils';

// i18n: identity translator so `t(key)` returns the key verbatim, letting us
// assert on the raw translation keys the component passes in.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// ActivitySpinner is the initial-loading placeholder; stub it to a marker.
jest.mock('app/atoms/ActivitySpinner', () => ({
  ActivitySpinner: () => <div data-testid="activity-spinner" />
}));

// Icon: expose the requested glyph name + className so buildRowProps' icon
// selection (and the white-fill classes) can be asserted.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid="icon" data-name={name} data-classname={className ?? ''} />
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
    onClick
  }: {
    icon: React.ReactNode;
    iconBg?: string;
    title: string;
    subtitle?: string;
    amount?: { value: string; symbol?: string; direction?: string };
    status: { label: string; tone: string };
    onClick?: () => void;
  }) => (
    <div
      data-testid="activity-row"
      data-title={title}
      data-subtitle={subtitle ?? ''}
      data-iconbg={iconBg ?? ''}
      data-amount-value={amount?.value ?? ''}
      data-amount-symbol={amount?.symbol ?? ''}
      data-amount-direction={amount?.direction ?? ''}
      data-status-label={status.label}
      data-status-tone={status.tone}
      data-clickable={onClick ? 'yes' : 'no'}
      onClick={onClick}
    >
      {icon}
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
  bridgeRowDisplay: jest.fn()
}));

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
  it('renders the ActivitySpinner while initially loading with no entries', () => {
    render(<HistoryView {...baseProps} entries={[]} initialLoading />);
    expect(screen.getByTestId('activity-spinner')).toBeInTheDocument();
  });

  it('renders the centered empty state when centerEmptyState is set', () => {
    render(<HistoryView {...baseProps} entries={[]} centerEmptyState />);
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
    // Centered variant shows the ArrowUpDown glyph.
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'ArrowUpDown');
  });

  it('renders the summary (non-full) empty state with the m-4 layout class', () => {
    const { container } = render(<HistoryView {...baseProps} entries={[]} />);
    const heading = screen.getByText('noOperationsFound');
    expect(heading.tagName).toBe('H3');
    expect(container.querySelector('.m-4')).not.toBeNull();
    expect(container.querySelector('.mt-8')).toBeNull();
  });

  it('renders the full-history empty state with the mt-8 layout class', () => {
    const { container } = render(<HistoryView {...baseProps} entries={[]} fullHistory />);
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
    expect(container.querySelector('.mt-8')).not.toBeNull();
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
  // One render exercising every icon/title/subtitle/amount/status branch.
  const entries: IHistoryEntry[] = [
    // --- Day A group (first group → gets pt-4; set + push + push) ---
    // Faucet request: RECEIVE icon, long address without underscore.
    makeEntry({
      key: 'faucet',
      __faucet: true,
      transactionIcon: 'RECEIVE',
      secondaryAddress: 'mtst1abcdefghijklmnop',
      amount: 100n,
      token: 'MDN',
      txId: 'tx-faucet',
      timestamp: DAY_A
    }),
    // Failed via FAILED icon: underscore address, neutral amount sign.
    makeEntry({
      key: 'failed-icon',
      transactionIcon: 'FAILED',
      secondaryAddress: 'mtst1_underscoreaddress',
      amount: 5n,
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
      amount: 50n,
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
      amount: 20n,
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
      amount: 10n,
      message: 'swap ignored',
      txId: 'tx-swap-full',
      type: HistoryEntryType.ProcessingTransaction,
      timestamp: DAY_B
    }),
    // Mint: positive amount, no secondary address (subtitle undefined).
    makeEntry({
      key: 'mint',
      transactionIcon: 'MINT',
      amount: 7n,
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
      amount: 3n,
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
      amount: 1n,
      token: 'MDN',
      txId: 'tx-faucet-send',
      timestamp: DAY_B
    })
  ];

  const renderFull = () => render(<HistoryView {...baseProps} entries={entries} fullHistory className="full-class" />);

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
    expect(row).toHaveAttribute('data-status-tone', 'confirmed');
    expect(row).toHaveAttribute('data-status-label', 'confirmed');
  });

  it('renders the failed-by-icon row with neutral amount and underscore address', () => {
    renderFull();
    const row = rowByTitle('Failed by icon');
    expect(iconNameIn(row)).toBe('Close');
    expect(row).toHaveAttribute('data-iconbg', 'bg-status-negative');
    // Underscore address → slice(0,6)…slice(-7).
    expect(row).toHaveAttribute('data-subtitle', 'to: mtst1_…address');
    expect(row).toHaveAttribute('data-amount-value', '5');
    expect(row).toHaveAttribute('data-amount-direction', 'neutral');
    expect(row).toHaveAttribute('data-status-tone', 'failed');
    expect(row).toHaveAttribute('data-status-label', 'failed');
  });

  it('renders the failed-by-message row (no subtitle, no amount)', () => {
    renderFull();
    const row = rowByTitle('Transaction failed');
    expect(iconNameIn(row)).toBe('Close');
    expect(row).toHaveAttribute('data-subtitle', '');
    expect(row).toHaveAttribute('data-amount-value', '');
    expect(row).toHaveAttribute('data-status-tone', 'failed');
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
    expect(row).toHaveAttribute('data-status-tone', 'pending');
    expect(row).toHaveAttribute('data-status-label', 'pending');
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
    expect(row).toHaveAttribute('data-status-tone', 'pending');
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

  it('renders the default row (unknown icon, empty title, no amount, not clickable)', () => {
    renderFull();
    const row = rowByTitle('');
    expect(iconNameIn(row)).toBe('More');
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

describe('HistoryView infinite scroll wiring', () => {
  const twoEntries = [
    makeEntry({ key: 'a', message: 'A', txId: 'txa', transactionIcon: 'SEND', amount: 1n, token: 'MDN' }),
    makeEntry({ key: 'b', message: 'B', txId: 'txb', transactionIcon: 'SEND', amount: 2n, token: 'MDN' })
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
