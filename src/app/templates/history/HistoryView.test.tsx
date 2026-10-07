import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { PageActiveContext, TabActiveContext } from 'app/layouts/page-active';
import { springs, tabBarSwap } from 'lib/animation';
import { resetActivityReadState } from 'lib/settings/activity-read';
import { navigate } from 'lib/woozie';

import HistoryView from './HistoryView';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import type { PendingActivityItem } from './PendingActivityCard';
import { getTransactionIconBackgroundColor } from './TransactionIcon';
import { bridgeInRowDisplay, bridgeRowDisplay, isBridgeInEntry, isFaucetRequest } from './transactionUtils';

// i18n: identity translator so `t(key)` returns the key verbatim, letting us
// assert on the raw translation keys the component passes in.
// A spy, so a case can read the arguments a title was built from.
const mockT = jest.fn((key: string, _options?: Record<string, unknown>) => key);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT })
}));

// The pending card wrapper's props, recorded by the framer-motion mock below. A layout animation
// is measured, never written to markup, so its mode cannot be asserted from the DOM alone.
const mockPendingWrapper: { props: Record<string, unknown> | null } = { props: null };

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
        ) => {
          if (rest['data-pending-note-id'] !== undefined) mockPendingWrapper.props = { layout, transition, ...rest };
          return (
            <div ref={ref} data-layout={String(layout)} data-transition={JSON.stringify(transition)} {...rest}>
              {children}
            </div>
          );
        }
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
    className,
    leading
  }: {
    icon: React.ReactNode;
    iconBg?: string;
    title: string;
    subtitle?: string;
    amount?: {
      value: string;
      symbol?: string;
      direction?: string;
      preformatted?: boolean;
      extra?: { key: string; value: string; symbol?: string }[];
    };
    status: string;
    onClick?: () => void;
    className?: string;
    leading?: React.ReactNode;
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
      data-amount-preformatted={amount?.preformatted ? 'yes' : 'no'}
      // Flattened as `key:value symbol|…` so both the contents AND the order
      // (the row renders them unsorted, first-seen) are assertable.
      data-amount-extra={(amount?.extra ?? []).map(l => `${l.key}:${l.value} ${l.symbol ?? ''}`).join('|')}
      data-status={status}
      data-clickable={onClick ? 'yes' : 'no'}
      onClick={onClick}
    >
      {leading}
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
  EmptyState: ({
    icon,
    title,
    description,
    surface,
    className,
    role,
    secondaryAction
  }: {
    icon: string;
    title: string;
    description?: string;
    surface?: string;
    className?: string;
    role?: string;
    secondaryAction?: { label: string; onClick: () => void };
  }) => (
    <div data-testid="empty-state" data-classname={className} data-surface={surface} role={role}>
      <span data-testid="icon" data-name={icon} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {secondaryAction && <button onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}
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

// isFaucetRequest: driven off a test-only `__faucet` marker so each entry can opt into the faucet
// branch independently, and, like the real one, true only for an entry that is a receive.
type MockFaucetEntry = { __faucet?: boolean; transactionIcon?: string; txType?: string };
jest.mock('./transactionUtils', () => ({
  isFaucetRequest: jest.fn(
    (entry: MockFaucetEntry) =>
      Boolean(entry.__faucet) && jest.requireActual('./transactionUtils').isReceiveEntry(entry)
  ),
  isBridgeInEntry: jest.fn(() => false),
  bridgeInRowDisplay: jest.fn(),
  bridgeRowDisplay: jest.fn(),
  // Smart Withdraw rows: mirror the real predicate so the earn branch of
  // `buildRowProps` is exercised with realistic values.
  isEarnWithdrawEntry: jest.fn((entry: { txType?: string }) => entry.txType === 'earn-withdraw'),
  // Smart Deposit settlement: mirror the real helper (unstamped ⇒ pending) so
  // the earn-deposit status branch is exercised with realistic values.
  earnDepositSettlementOf: jest.fn((entry: { earnDepositStatus?: string }) => entry.earnDepositStatus ?? 'pending'),
  isReceiveEntry: jest.requireActual('./transactionUtils').isReceiveEntry,
  formatMoneyAmount: jest.requireActual('./transactionUtils').formatMoneyAmount,
  // TransactionIcon (imported by HistoryView) reads the bridge slate from here at module load.
  TRANSACTION_COLORS: jest.requireActual('./transactionUtils').TRANSACTION_COLORS
}));

const mockBridgeRowDisplay = bridgeRowDisplay as jest.MockedFunction<typeof bridgeRowDisplay>;

// The props the view last handed the scroller, so a test can read the scroll parent and ask for a page
// when the real scroller would: after render, not during it.
type MockScrollerProps = {
  children: React.ReactNode;
  hasMore: boolean;
  loadMore: (page: number) => void;
  useWindow?: boolean;
  getScrollParent?: () => HTMLElement | null;
};
const mockScroller: { props?: MockScrollerProps } = {};
jest.mock('react-infinite-scroller', () => ({
  __esModule: true,
  default: (props: MockScrollerProps) => {
    mockScroller.props = props;
    return (
      <div data-testid="infinite-scroll" data-hasmore={String(props.hasMore)}>
        {props.children}
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
  mockScroller.props = undefined;
  (isFaucetRequest as jest.Mock).mockImplementation(
    (entry: MockFaucetEntry) =>
      Boolean(entry.__faucet) && jest.requireActual('./transactionUtils').isReceiveEntry(entry)
  );
  jest.mocked(isBridgeInEntry).mockReturnValue(false);
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

  it("draws a token's own empty card, dashed, when the history is one token's", () => {
    render(<HistoryView {...baseProps} entries={[]} fullHistory tokenId="token-1" />);
    expect(screen.queryByText('noOperationsFound')).toBeNull();
    expect(screen.getByText('tokenActivityEmptyTitle')).toBeInTheDocument();
    expect(screen.getByText('tokenActivityEmptyBody')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toHaveAttribute('data-surface', 'dashed');
  });

  it('keeps the plain no-operations card for a history that is not one token', () => {
    render(<HistoryView {...baseProps} entries={[]} fullHistory />);
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
    expect(screen.queryByText('tokenActivityEmptyTitle')).toBeNull();
    expect(screen.getByTestId('empty-state')).not.toHaveAttribute('data-surface', 'dashed');
  });

  describe('after a failed load', () => {
    const emptyModes: Array<[string, Partial<React.ComponentProps<typeof HistoryView>>]> = [
      ['the default list', {}],
      ['the centred Activity list', { centerEmptyState: true }],
      ["one token's full history", { tokenId: 'token-1', fullHistory: true }]
    ];

    it.each(emptyModes)(
      'says the load failed, with Retry, while the other read still loads, in %s',
      (_mode, modeProps) => {
        const onRetry = jest.fn();
        render(<HistoryView {...baseProps} {...modeProps} entries={[]} initialLoading loadError onRetry={onRetry} />);

        expect(screen.getByRole('alert')).toHaveTextContent('tokenActivityLoadError');
        fireEvent.click(screen.getByRole('button', { name: 'retry' }));
        expect(onRetry).toHaveBeenCalledTimes(1);
      }
    );

    it.each(emptyModes)('says the load failed, with Retry, instead of the empty card, in %s', (_mode, modeProps) => {
      const onRetry = jest.fn();
      render(<HistoryView {...baseProps} {...modeProps} entries={[]} loadError onRetry={onRetry} />);

      expect(screen.getByRole('alert')).toHaveTextContent('tokenActivityLoadError');
      expect(screen.queryByText('noOperationsFound')).toBeNull();
      expect(screen.queryByText('tokenActivityEmptyTitle')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'retry' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the summary list', {}],
      ['the Activity list', { fullHistory: true }],
      ["one token's list", { fullHistory: true, tokenId: 'token-1' }]
    ])('keeps the rows it has in %s, under an alert with Retry', (_mode, modeProps) => {
      const onRetry = jest.fn();
      render(
        <HistoryView {...baseProps} {...modeProps} entries={[makeEntry({ key: 'kept' })]} loadError onRetry={onRetry} />
      );

      expect(screen.getByRole('alert')).toHaveTextContent('tokenActivityLoadError');
      expect(screen.queryAllByTestId(/^(history-item|activity-row)$/)).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'retry' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the centred Activity card as it is, even with a token id', () => {
    render(<HistoryView {...baseProps} entries={[]} centerEmptyState tokenId="token-1" />);
    expect(screen.getByText('noOperationsFound')).toBeInTheDocument();
    expect(screen.queryByText('tokenActivityEmptyTitle')).toBeNull();
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
  // ActivityRow is mocked here, so this pins only what `Card asChild` adds: press feedback, and
  // no focus classes of its own. The focus ring and `select-none` come from the row's own native
  // button, and ActivityRow's tests pin them, with the real Card wrapped around it.
  it('gives a tappable row press feedback from the card, and leaves focus styling to the row', () => {
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
      inLabel: 'MIDEN',
      outLabel: 'USDC',
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

  // The money helper already formatted both amounts; the symbol inside the value must not be what keeps the row
  // from rounding 0.015123 ETH to 0.015 again.
  it('marks a bridge-in and a bridge-out amount preformatted', () => {
    jest.mocked(isBridgeInEntry).mockImplementation(entry => entry.txType === 'bridged-receive');
    mockBridgeRowDisplay.mockReturnValue({
      inSymbol: 'MIDEN',
      outSymbol: 'USDC',
      inLabel: 'MIDEN',
      outLabel: 'USDC',
      outAmount: '10.65',
      providerLabel: 'Epoch',
      network: 'Sepolia',
      status: 'confirmed'
    });
    jest.mocked(bridgeInRowDisplay).mockReturnValue({
      inSymbol: 'USDC',
      outSymbol: 'ETH',
      inLabel: 'USDC',
      outLabel: 'ETH',
      outAmount: '0.015123',
      providerLabel: 'Epoch',
      network: 'Miden',
      status: 'confirmed'
    });
    render(
      <HistoryView
        {...baseProps}
        entries={[
          makeEntry({ key: 'bridge-out', txType: 'bridged-send', txId: 'bridge-out-tx' }),
          makeEntry({ key: 'bridge-in', txType: 'bridged-receive', txId: 'bridge-in-tx' })
        ]}
        fullHistory
      />
    );

    const rowWithAmount = (value: string) =>
      screen.getAllByTestId('activity-row').find(row => row.getAttribute('data-amount-value') === value);
    expect(rowWithAmount('10.65 USDC')).toHaveAttribute('data-amount-preformatted', 'yes');
    expect(rowWithAmount('+0.015123 ETH')).toHaveAttribute('data-amount-preformatted', 'yes');
  });

  it('shows a bridge row under the labels its display gives, not its symbols', () => {
    jest.mocked(isBridgeInEntry).mockImplementation(entry => entry.txType === 'bridged-receive');
    mockBridgeRowDisplay.mockReturnValue({
      inSymbol: 'USDC',
      outSymbol: 'USDC',
      inLabel: 'Test Epoch USDC',
      outLabel: 'Test Epoch USDC',
      outAmount: '4.98',
      providerLabel: 'Epoch',
      network: 'Sepolia',
      status: 'confirmed'
    });
    jest.mocked(bridgeInRowDisplay).mockReturnValue({
      inSymbol: 'USDC',
      outSymbol: 'USDC',
      inLabel: 'Test Epoch USDC',
      outLabel: 'Test Epoch USDC',
      outAmount: '3',
      providerLabel: 'Epoch',
      network: 'Miden',
      status: 'confirmed'
    });
    render(
      <HistoryView
        {...baseProps}
        entries={[
          makeEntry({ key: 'bridge-out', txType: 'bridged-send', txId: 'bridge-out-tx' }),
          makeEntry({ key: 'bridge-in', txType: 'bridged-receive', txId: 'bridge-in-tx' })
        ]}
        fullHistory
      />
    );

    const values = screen.getAllByTestId('activity-row').map(row => row.getAttribute('data-amount-value'));
    expect(values).toEqual(expect.arrayContaining(['4.98 Test Epoch USDC', '+3 Test Epoch USDC']));
    expect(mockT).toHaveBeenCalledWith('bridgeRowTitle', { from: 'Test Epoch USDC', to: 'Test Epoch USDC' });
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
    // A faucet claim still in flight (no icon yet): the faucet glyph, a positive amount and the
    // "from" subtitle, plus a short address.
    makeEntry({
      key: 'faucet-in-flight',
      __faucet: true,
      txType: 'consume',
      secondaryAddress: 'shortaddr',
      amount: '1',
      token: 'MDN',
      txId: 'tx-faucet-in-flight',
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
      amount: '10.6555',
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
    // Already formatted by `earnWithdrawAmountFields`, so the row must not round it again.
    expect(row).toHaveAttribute('data-amount-preformatted', 'yes');
    expect(row).toHaveAttribute('data-status', 'delivering');
  });

  it('renders a position deposit with the Earn glyph and a negative amount', () => {
    renderFull();
    const row = rowByTitle('Depositing');
    expect(iconNameIn(row)).toBe('Earn');
    expect(row).toHaveAttribute('data-iconbg', 'bg-tx-earn');
    expect(row).toHaveAttribute('data-amount-value', '-10.6555');
    expect(row).toHaveAttribute('data-amount-direction', 'negative');
    // The amount typed, as its Review showed it: the row's 3-decimal pass would cut it to 10.655.
    expect(row).toHaveAttribute('data-amount-preformatted', 'yes');
  });

  it('renders a date separator per calendar day', () => {
    renderFull();
    // Two groups → two long-date headers; the accent weekday appears too.
    expect(screen.getByText('January 15, 2024')).toBeInTheDocument();
    expect(screen.getByText('January 16, 2024')).toBeInTheDocument();
    expect(screen.getByText('Monday')).toBeInTheDocument();
    expect(screen.getByText('Tuesday')).toBeInTheDocument();
  });

  it('draws each day as a quiet caption, with the year only when it is not this year', () => {
    render(<HistoryView {...baseProps} entries={entries} fullHistory dateStyle="caption" />);

    // The 2024 fixtures are not this year, so their captions carry it; no separate weekday header.
    const caption = screen.getByText('Monday, January 15, 2024');
    expect(caption).toHaveClass('text-caption-heading', 'text-muted');
    expect(screen.getByText('Tuesday, January 16, 2024')).toBeInTheDocument();
    expect(screen.queryByText('Monday')).not.toBeInTheDocument();
    expect(screen.queryByText('January 15, 2024')).not.toBeInTheDocument();
  });

  // A caption list sits under a section heading that already leaves 12px; the header list has only
  // the Activity tab's filters above it, so it opens 16px down.
  it('starts the first caption day flush under its heading', () => {
    render(<HistoryView {...baseProps} entries={entries} fullHistory dateStyle="caption" />);

    const firstDay = screen.getByText('Monday, January 15, 2024').closest('[data-layout]');
    expect(firstDay).not.toHaveClass('pt-4');
    expect(firstDay).toHaveClass('pt-0', 'py-2.5');
    expect(screen.getByText('Tuesday, January 16, 2024').closest('[data-layout]')).not.toHaveClass('pt-0');
  });

  it('keeps the first header day 16px under the filters', () => {
    renderFull();

    const firstDay = screen.getByText('January 15, 2024').closest('[data-layout]');
    expect(firstDay).toHaveClass('pt-4', 'py-3');
    expect(firstDay).not.toHaveClass('pt-0');
    expect(screen.getByText('January 16, 2024').closest('[data-layout]')).not.toHaveClass('pt-4');
  });

  it('leaves the year off the caption of a day in this year', () => {
    jest.useFakeTimers({ now: new Date(2024, 5, 1, 12) });
    try {
      render(<HistoryView {...baseProps} entries={entries} fullHistory dateStyle="caption" />);

      expect(screen.getByText('Monday, January 15')).toHaveClass('text-caption-heading', 'text-muted');
      expect(screen.getByText('Tuesday, January 16')).toBeInTheDocument();
      expect(screen.queryByText(/2024/)).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
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

  it('renders a not-confirmed row in the pending tone, even for a bridge, leaving cancelled and failed rows alone', () => {
    render(
      <HistoryView
        entries={[
          makeEntry({
            key: 'unconfirmed-send',
            transactionIcon: 'FAILED',
            isUnconfirmed: true,
            message: 'Transaction failed',
            txId: 'tx-unconfirmed',
            timestamp: DAY_A
          }),
          makeEntry({
            key: 'unconfirmed-bridge',
            txType: 'bridged-send',
            transactionIcon: 'FAILED',
            isUnconfirmed: true,
            message: 'Transaction failed',
            txId: 'tx-unconfirmed-bridge',
            timestamp: DAY_A
          }),
          makeEntry({
            key: 'still-cancelled',
            transactionIcon: 'FAILED',
            isCancelled: true,
            message: 'Cancelled',
            txId: 'tx-still-cancelled',
            timestamp: DAY_A
          }),
          makeEntry({
            key: 'still-failed',
            transactionIcon: 'FAILED',
            message: 'Transaction failed',
            txId: 'tx-still-failed',
            timestamp: DAY_A
          })
        ]}
        initialLoading={false}
        loadMore={jest.fn()}
        hasMore={false}
        fullHistory
      />
    );

    const unconfirmedRows = screen
      .getAllByTestId('activity-row')
      .filter(el => el.getAttribute('data-title') === 'notConfirmed');
    expect(unconfirmedRows).toHaveLength(2);
    for (const row of unconfirmedRows) {
      // Not the grey cancelled or red failed look (#1250): the pending tone, on both the
      // plain row and the bridge, which drops its own layout entirely.
      expect(row).toHaveAttribute('data-iconbg', 'bg-status-pending');
      expect(row).toHaveAttribute('data-status', 'unconfirmed');
      expect(row.querySelector('svg')).not.toBeNull();
    }
    // The bridge layout (bridgeRowDisplay) never ran for the unconfirmed bridge row.
    expect(mockBridgeRowDisplay).not.toHaveBeenCalled();

    expect(rowByTitle('cancelled')).toHaveAttribute('data-status', 'cancelled');
    const failedRow = screen
      .getAllByTestId('activity-row')
      .find(el => el.getAttribute('data-title') === 'Transaction failed')!;
    expect(failedRow).toHaveAttribute('data-status', 'failed');
    expect(failedRow).toHaveAttribute('data-iconbg', 'bg-[#CC5D5D]');
  });

  // A cancelled bridge-out falls through to the plain row, whose generic pass would round the typed amount again.
  it.each([
    ['the unscoped list', undefined],
    ['a token-scoped list', 'faucet-usdc']
  ])('shows a cancelled bridge-out amount as typed in %s', (_label, tokenId) => {
    render(
      <HistoryView
        {...baseProps}
        entries={[
          makeEntry({
            txType: 'bridged-send',
            transactionIcon: 'FAILED',
            isCancelled: true,
            message: 'Cancelled',
            amount: '1.234567',
            token: 'USDC',
            faucetId: 'faucet-usdc'
          })
        ]}
        fullHistory
        tokenId={tokenId}
      />
    );

    const row = rowByTitle('cancelled');
    expect(row).toHaveAttribute('data-amount-value', '1.234567');
    expect(row).toHaveAttribute('data-amount-preformatted', 'yes');
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

  it('renders every row as an outlined card on the page: a hairline edge, no fill', () => {
    renderFull();
    const rows = screen.getAllByTestId('activity-row');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(row => {
      expect(row).toHaveClass('bg-page', 'border', 'border-hairline', 'rounded-2xl', 'px-4', 'py-3');
      expect(row).not.toHaveClass('bg-fill');
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

  it('renders a faucet claim in flight with the faucet glyph and the "from" subtitle', () => {
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

  describe('unread', () => {
    beforeEach(() => {
      localStorage.clear();
      resetActivityReadState();
      // Before every fixture's timestamp, so the whole list arrives unread.
      jest.spyOn(Date, 'now').mockReturnValue(0);
    });
    afterEach(() => jest.restoreAllMocks());

    it('marks a row unread until its own detail is opened', () => {
      const { rerender } = renderFull();
      const row = rowByTitle('Received');
      expect(within(row).getByTestId('activity-row-unread')).toHaveClass('bg-notification');

      // Opening THAT row reads it. Opening the tab reads nothing, which is why the other rows
      // keep their dots.
      fireEvent.click(row);
      rerender(<HistoryView {...baseProps} entries={entries} fullHistory className="full-class" />);
      expect(within(rowByTitle('Received')).queryByTestId('activity-row-unread')).toBeNull();
      expect(screen.getAllByTestId('activity-row-unread').length).toBeGreaterThan(0);
    });

    it('leaves an existing history read on first run', () => {
      jest.spyOn(Date, 'now').mockReturnValue((DAY_B + 86_400) * 1000);
      resetActivityReadState();
      renderFull();

      expect(screen.queryByTestId('activity-row-unread')).toBeNull();
    });
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

// A claim in flight has no icon yet (its entry is built from the transaction row), so the
// direction comes from its type (#1102).
describe('HistoryView claims in flight', () => {
  const renderPending = (overrides: EntryOverrides) => {
    render(
      <HistoryView
        {...baseProps}
        entries={[
          makeEntry({
            key: 'pending',
            type: HistoryEntryType.PendingTransaction,
            message: 'Generating transaction',
            secondaryAddress: 'shortaddr',
            amount: '3',
            token: 'MDN',
            txId: 'tx-pending',
            ...overrides
          })
        ]}
        fullHistory
      />
    );
    return screen.getByTestId('activity-row');
  };

  it('reads an ordinary claim in flight as received from its sender', () => {
    const row = renderPending({ txType: 'consume' });
    expect(row).toHaveAttribute('data-subtitle', 'from: shortaddr');
    expect(row).toHaveAttribute('data-amount-direction', 'neutral');
  });

  it('keeps a send in flight reading "to" its recipient', () => {
    const row = renderPending({ txType: 'send' });
    expect(row).toHaveAttribute('data-subtitle', 'to: shortaddr');
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
    const ref: { current: HTMLDivElement | null } = { current: null };
    render(
      <HistoryView {...baseProps} entries={twoEntries} fullHistory hasMore loadMore={loadMore} scrollParentRef={ref} />
    );
    // Attached after render, as the page's ref is, so a scroll parent read during render comes back null.
    ref.current = parent;

    expect(screen.getByTestId('infinite-scroll')).toHaveAttribute('data-hasmore', 'true');
    const scroller = mockScroller.props;
    expect(Object.keys(scroller ?? {}).sort()).toEqual([
      'children',
      'getScrollParent',
      'hasMore',
      'loadMore',
      'useWindow'
    ]);
    expect(scroller?.useWindow).toBe(false);
    expect(scroller?.getScrollParent?.()).toBe(parent);
    expect(loadMore).not.toHaveBeenCalled();
    scroller?.loadMore(2);
    expect(loadMore.mock.calls).toEqual([[2]]);
    expect(within(screen.getByTestId('infinite-scroll')).getAllByTestId('activity-row')).toHaveLength(2);
  });

  it('tells the scroller when the history is exhausted', () => {
    render(
      <HistoryView
        {...baseProps}
        entries={twoEntries}
        fullHistory
        hasMore={false}
        scrollParentRef={{ current: document.createElement('div') }}
      />
    );
    expect(mockScroller.props?.hasMore).toBe(false);
  });

  it('renders the plain list (no InfiniteScroll) when scrollParentRef is absent', () => {
    render(<HistoryView {...baseProps} entries={twoEntries} fullHistory />);
    expect(screen.queryByTestId('infinite-scroll')).toBeNull();
    expect(screen.getAllByTestId('activity-row')).toHaveLength(2);
  });
});

describe('HistoryView Guardian ops', () => {
  it('paints a device-key rotation row like a guardian switch: the slate its detail page uses, the Guardian glyph', () => {
    const entries = [
      makeEntry({ key: 'switch', txType: 'switch-guardian', message: 'Guardian switched' }),
      makeEntry({ key: 'rotation', txType: 'replace-hot-key', message: 'Device key rotated' }),
      makeEntry({ key: 'threshold', txType: 'update-procedure-threshold', message: 'Account secured' })
    ];
    render(<HistoryView {...baseProps} entries={entries} fullHistory />);

    // TransactionIcon's slate (#777487) is the detail page's accent for all three.
    expect(getTransactionIconBackgroundColor(entries[1]!)).toBe('#777487');
    for (const title of ['Guardian switched', 'Device key rotated', 'Account secured']) {
      const row = rowByTitle(title);
      expect(row).toHaveAttribute('data-iconbg', 'bg-[#777487]');
      expect(row.querySelector('svg')).not.toBeNull();
      expect(within(row).queryByTestId('icon')).toBeNull();
    }
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

  it('titles and chips a rotation row by its verdict', () => {
    const rotation = { txType: 'switch-guardian' as const, newGuardianEndpoint: 'https://new.example/guardian' };
    const entries = [
      makeEntry({
        ...rotation,
        key: 'unconfirmed',
        message: 'Guardian switch submitted',
        guardianSwitchVerdict: 'submitted-unconfirmed'
      }),
      makeEntry({ ...rotation, key: 'confirmed', message: 'Guardian switched', guardianSwitchVerdict: 'confirmed' }),
      makeEntry({
        ...rotation,
        key: 'degraded',
        message: 'Guardian switched',
        guardianSwitchVerdict: 'completed-degraded'
      }),
      makeEntry({
        ...rotation,
        key: 'queued',
        message: 'Switching guardian',
        type: HistoryEntryType.PendingTransaction,
        guardianSwitchVerdict: 'in-flight'
      }),
      makeEntry({
        ...rotation,
        key: 'failed',
        message: 'Transaction failed',
        transactionIcon: 'FAILED',
        guardianSwitchVerdict: 'failed'
      })
    ];

    render(<HistoryView {...baseProps} entries={entries} fullHistory />);

    const [unconfirmed, confirmed, degraded, queued, failed] = screen.getAllByTestId('activity-row');
    expect(unconfirmed).toHaveAttribute('data-title', 'guardianSwitchSubmittedRowTitle');
    expect(unconfirmed).toHaveAttribute('data-status', 'guardianSwitchSubmitted');
    expect(confirmed).toHaveAttribute('data-title', 'guardianSwitchedRowTitle');
    expect(confirmed).toHaveAttribute('data-status', 'confirmed');
    expect(degraded).toHaveAttribute('data-title', 'guardianSwitchedRowTitle');
    expect(degraded).toHaveAttribute('data-status', 'confirmed');
    expect(queued).toHaveAttribute('data-title', 'Switching guardian');
    expect(queued).toHaveAttribute('data-status', 'pending');
    expect(failed).toHaveAttribute('data-title', 'Transaction failed');
    expect(failed).toHaveAttribute('data-status', 'failed');
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

it('moves a pending card with the rows beside it, and never animates its height', () => {
  // The card is the only child of a date group that is not a row, and it used to be the only one
  // that was not a Framer projection node either: it jumped to its new place on a filter change
  // while the `ActivityRow` inside it slid there. `layout="position"` puts it in the projection
  // tree with its neighbours. Position-only is load-bearing: the card's box grows when its
  // disclosure opens, and full `layout` would animate that — the height tween the card itself
  // just lost, moved one level up.
  const pending: PendingActivityItem = {
    note: {
      id: 'moving-note',
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
  render(
    <HistoryView
      fullHistory
      initialLoading={false}
      hasMore={false}
      loadMore={async () => {}}
      entries={[makeEntry({ key: 'settled', timestamp: DAY_A })]}
      pendingItems={[pending]}
      renderPendingItem={() => <span data-testid="pending-moving-row">Pending note</span>}
    />
  );

  const wrapperProps = mockPendingWrapper.props;
  expect(wrapperProps).not.toBeNull();
  expect(wrapperProps?.layout).toBe('position');
  expect(wrapperProps?.['data-pending-note-id']).toBe('moving-note');
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

// A link that narrows Activity's filter while its tab is hidden lands in the commit that shows the tab
// again (#1198): the date groups and pending cards that survive take their new places at once there,
// and slide on the settle spring on any other change.
describe('HistoryView - its tab shown again', () => {
  const pending: PendingActivityItem = {
    note: {
      id: 'swap-note',
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
  // A stable ref so InfiniteScroll mounts (mirrors how the real page passes one down); the mock
  // never reads `.current`, so a bare DOM node is enough.
  const scrollParentRef = { current: document.createElement('div') };
  const noMore = async () => {};
  const view = (
    shown: boolean,
    onScreen = true,
    hasMore = false,
    loadMore: (page: number) => Promise<void> = noMore
  ) => (
    <PageActiveContext.Provider value={onScreen}>
      <TabActiveContext.Provider value={shown}>
        <HistoryView
          fullHistory
          initialLoading={false}
          hasMore={hasMore}
          loadMore={loadMore}
          entries={[makeEntry({ key: 'settled', timestamp: DAY_A })]}
          pendingItems={[pending]}
          renderPendingItem={() => <span>Pending note</span>}
          scrollParentRef={scrollParentRef}
        />
      </TabActiveContext.Provider>
    </PageActiveContext.Provider>
  );
  const groupMoves = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-layout]'))
      .filter(node => !node.hasAttribute('data-pending-note-id'))
      .map(node => JSON.parse(node.getAttribute('data-transition') ?? 'null'));

  it('swaps only the layout of its date groups and pending cards in the commit that shows the tab again', () => {
    const { container, rerender } = render(view(true));
    rerender(view(false));
    rerender(view(true));

    const groups = groupMoves(container);
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach(transition => expect(transition).toEqual({ ...springs.settle, layout: tabBarSwap }));
    expect(mockPendingWrapper.props?.transition).toEqual({ ...springs.settle, layout: tabBarSwap });
  });

  it('slides them on the next change, and when a slide page uncovers the list', () => {
    const { container, rerender } = render(view(true));
    rerender(view(false));
    rerender(view(true));
    rerender(view(true));
    expect(groupMoves(container).length).toBeGreaterThan(0);
    groupMoves(container).forEach(transition => expect(transition).toEqual(springs.settle));
    expect(mockPendingWrapper.props?.transition).toEqual(springs.settle);

    rerender(view(true, false));
    rerender(view(true, true));
    expect(groupMoves(container).length).toBeGreaterThan(0);
    groupMoves(container).forEach(transition => expect(transition).toEqual(springs.settle));
    expect(mockPendingWrapper.props?.transition).toEqual(springs.settle);
  });

  it("defers the scroller's page request in the commit that shows the tab again, and passes the parent's loadMore through otherwise", async () => {
    const loadMore = jest.fn((_page: number) => Promise.resolve());
    const { rerender } = render(view(true, true, true, loadMore));
    expect(mockScroller.props?.loadMore).toBe(loadMore);
    rerender(view(false, true, true, loadMore));
    rerender(view(true, true, true, loadMore));

    mockScroller.props?.loadMore(3);
    expect(loadMore).not.toHaveBeenCalled();
    await act(async () => {});
    expect(loadMore.mock.calls).toEqual([[3]]);

    rerender(view(true, true, true, loadMore));
    expect(mockScroller.props?.loadMore).toBe(loadMore);
  });
});
