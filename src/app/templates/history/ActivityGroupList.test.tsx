import React from 'react';

import { render, screen, within } from '@testing-library/react';

import { markActivityRead, resetActivityReadState } from 'lib/settings/activity-read';

import { ActivityGroupList } from './ActivityGroupList';
import { historyEntryUnreadKey } from './activityUnread';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';

const FAUCET = 'miden-native-faucet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'activityGroupPartialCount' ? `${options?.count}+` : key
  })
}));

jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetIdSync: () => FAUCET }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

// The rows navigate with the wallet's `Link`; a plain anchor is enough to read the destination.
jest.mock('lib/woozie', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  )
}));

// `formatDistanceToNowStrict` is the only thing the subtitle's "when" half comes from.
jest.mock('date-fns', () => ({
  ...jest.requireActual('date-fns'),
  formatDistanceToNowStrict: () => '2 hours'
}));

jest.mock('lib/i18n', () => ({ getDateFnsLocale: () => undefined }));

// The scroller only matters when a scroll parent is handed in; the list itself is what is tested.
jest.mock('react-infinite-scroller', () => ({
  __esModule: true,
  default: ({ children, hasMore }: { children: React.ReactNode; hasMore: boolean }) => (
    <div data-testid="infinite-scroll" data-has-more={String(hasMore)}>
      {children}
    </div>
  )
}));

let nextKey = 0;
const entry = (over: Partial<IHistoryEntry> = {}): IHistoryEntry => ({
  key: `entry-${++nextKey}`,
  address: 'me',
  timestamp: 1_000,
  message: 'Sent',
  type: HistoryEntryType.CompletedTransaction,
  txType: 'send',
  ...over
});

const renderList = (entries: IHistoryEntry[], over: Partial<React.ComponentProps<typeof ActivityGroupList>> = {}) =>
  render(
    <ActivityGroupList
      entries={entries}
      nameOf={() => undefined}
      initialLoading={false}
      hasMore={false}
      loadMore={jest.fn()}
      {...over}
    />
  );

const rows = () => screen.getAllByTestId('activity-group-row');

describe('ActivityGroupList — unread', () => {
  // Everything in the fixtures is dated after the seed, so a fresh install sees it all as unread.
  beforeEach(() => {
    localStorage.clear();
    resetActivityReadState();
    jest.spyOn(Date, 'now').mockReturnValue(0);
  });
  afterEach(() => jest.restoreAllMocks());

  const unreadRows = () => rows().filter(row => within(row).queryByTestId('list-row-unread'));

  it('marks a group unread while any of its entries is, and names it', () => {
    renderList([entry({ timestamp: 900, secondaryAddress: 'mtst1alice' })]);

    const dot = screen.getByTestId('list-row-unread');
    expect(dot).toHaveClass('bg-notification');
    expect(dot).toHaveTextContent('activityUnread');
  });

  it('keeps the dot while ONE child is still unread, and drops it when the last one is read', () => {
    const first = entry({ timestamp: 900, key: 'a', txId: 'a', secondaryAddress: 'mtst1alice' });
    const second = entry({ timestamp: 800, key: 'b', txId: 'b', secondaryAddress: 'mtst1alice' });

    const { rerender } = renderList([first, second]);
    expect(unreadRows()).toHaveLength(1);

    // Opening one child is not opening the group: the folder still holds something unread.
    markActivityRead(historyEntryUnreadKey(first), first.timestamp);
    rerender(
      <ActivityGroupList
        entries={[first, second]}
        nameOf={() => undefined}
        initialLoading={false}
        hasMore={false}
        loadMore={jest.fn()}
      />
    );
    expect(unreadRows()).toHaveLength(1);

    markActivityRead(historyEntryUnreadKey(second), second.timestamp);
    rerender(
      <ActivityGroupList
        entries={[first, second]}
        nameOf={() => undefined}
        initialLoading={false}
        hasMore={false}
        loadMore={jest.fn()}
      />
    );
    expect(unreadRows()).toHaveLength(0);
  });

  it('leaves an existing history read on first run, instead of a wall of dots', () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000_000);
    resetActivityReadState();

    renderList([entry({ timestamp: 900, secondaryAddress: 'mtst1alice' }), entry({ timestamp: 800, txType: 'swap' })]);

    expect(screen.queryByTestId('list-row-unread')).toBeNull();
  });
});

describe('ActivityGroupList', () => {
  it('spins while the first page is still loading', () => {
    const { container } = renderList([], { initialLoading: true });
    expect(screen.queryByTestId('activity-group-list')).toBeNull();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('shows the empty state once the first page has landed with nothing in it', () => {
    renderList([]);
    expect(screen.getByText('noOperationsFound')).toBeTruthy();
    expect(screen.queryByTestId('activity-group-list')).toBeNull();
  });

  it('renders one row per group, newest first, each linking to its own page', () => {
    renderList([
      entry({ timestamp: 900, secondaryAddress: 'mtst1alice' }),
      entry({ timestamp: 800, txType: 'swap', token: 'MIDEN', requestedToken: 'USDC' }),
      entry({ timestamp: 700, secondaryAddress: 'mtst1alice' })
    ]);

    const listed = rows();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toHaveAttribute('data-group-id', 'mtst1alice');
    expect(listed[0]).toHaveAttribute('href', '/activity/group/address/mtst1alice');
    expect(listed[1]).toHaveAttribute('data-group-kind', 'swap');
    expect(listed[1]).toHaveAttribute('href', '/activity/group/swap');
  });

  it('names a known counterparty and ellipsises an unknown address', () => {
    renderList(
      [
        entry({ timestamp: 900, secondaryAddress: 'mtst1aliceaddress0000' }),
        entry({ timestamp: 800, secondaryAddress: 'mtst1strangeraddress0' })
      ],
      { nameOf: address => (address === 'mtst1aliceaddress0000' ? 'Alice' : undefined) }
    );

    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('mtst1s…ess0')).toBeTruthy();
  });

  it('names each category group', () => {
    renderList([
      entry({ timestamp: 900, txType: 'swap' }),
      entry({ timestamp: 800, txType: 'switch-guardian' }),
      entry({
        timestamp: 700,
        txType: 'consume',
        transactionIcon: 'RECEIVE',
        faucetId: FAUCET,
        secondaryAddress: FAUCET
      }),
      entry({ timestamp: 600, txType: 'execute' })
    ]);

    expect(screen.getByText('activityGroupSwaps')).toBeTruthy();
    expect(screen.getByText('activityGroupGuardian')).toBeTruthy();
    expect(screen.getByText('activityGroupFaucet')).toBeTruthy();
    expect(screen.getByText('activityGroupOther')).toBeTruthy();
  });

  it('gives every kind of group the same 40px round mark, tinted by kind', () => {
    renderList([
      entry({ timestamp: 900, secondaryAddress: 'mtst1aliceaddress0000' }),
      entry({ timestamp: 800, txType: 'swap' }),
      entry({ timestamp: 700, txType: 'switch-guardian' }),
      entry({
        timestamp: 600,
        txType: 'consume',
        transactionIcon: 'RECEIVE',
        faucetId: FAUCET,
        secondaryAddress: FAUCET
      }),
      entry({ timestamp: 500, txType: 'execute' })
    ]);

    // The contact keeps its initials avatar; the four category groups each get the circle they
    // were missing, so the title column starts at the same x on every row.
    expect(screen.getAllByTestId('contact-avatar')).toHaveLength(1);
    const marks = screen.getAllByTestId('activity-group-avatar');
    expect(marks.map(mark => mark.getAttribute('data-group-kind'))).toEqual(['swap', 'guardian', 'faucet', 'other']);
    for (const mark of [...marks, ...screen.getAllByTestId('contact-avatar')]) {
      const circle = mark.firstElementChild;
      expect(circle).toHaveClass('rounded-full', 'h-10', 'w-10');
    }
  });

  it('paints each category mark in the colour the flat feed gives that kind of row', () => {
    renderList([
      entry({ timestamp: 900, txType: 'swap' }),
      entry({ timestamp: 800, txType: 'switch-guardian' }),
      entry({
        timestamp: 700,
        txType: 'consume',
        transactionIcon: 'RECEIVE',
        faucetId: FAUCET,
        secondaryAddress: FAUCET
      }),
      entry({ timestamp: 600, txType: 'execute' })
    ]);

    const colorOf = (kind: string) => {
      const mark = screen.getAllByTestId('activity-group-avatar').find(m => m.dataset.groupKind === kind);
      return mark?.firstElementChild?.getAttribute('style');
    };
    expect(colorOf('swap')).toContain('var(--tx-swap)');
    expect(colorOf('faucet')).toContain('var(--tx-faucet)');
    // The slate `HistoryView` already paints a guardian row with (jsdom prints it as rgb).
    expect(colorOf('guardian')).toContain('rgb(119, 116, 135)');
    expect(colorOf('other')).toContain('var(--tx-other)');
  });

  it("reads the latest event and how long ago it was as the row's subtitle", () => {
    renderList([
      entry({ timestamp: 900, message: 'Sent', amount: '1', token: 'MIDEN', secondaryAddress: 'mtst1alice' }),
      entry({ timestamp: 100, message: 'Received', amount: '5', token: 'MIDEN', secondaryAddress: 'mtst1alice' })
    ]);

    expect(screen.getByText('Sent 1 MIDEN · 2 hours')).toBeTruthy();
  });

  it('names an asset whose scale is unknown without inventing a number for it', () => {
    renderList([entry({ message: 'Received', token: 'XYZ', secondaryAddress: 'mtst1alice' })]);
    expect(screen.getByText('Received XYZ · 2 hours')).toBeTruthy();
  });

  it('states a swap by its pair and a cancelled row as cancelled', () => {
    renderList([
      entry({ timestamp: 900, txType: 'swap', token: 'MIDEN', requestedToken: 'USDC' }),
      entry({ timestamp: 800, secondaryAddress: 'mtst1alice', isCancelled: true })
    ]);

    expect(screen.getByText('swap MIDEN → USDC · 2 hours')).toBeTruthy();
    expect(screen.getByText('cancelled · 2 hours')).toBeTruthy();
  });

  it('badges a group that still has something in flight, and counts it', () => {
    renderList([
      entry({ timestamp: 900, type: HistoryEntryType.PendingTransaction, secondaryAddress: 'mtst1alice' }),
      entry({ timestamp: 800, secondaryAddress: 'mtst1alice' }),
      entry({ timestamp: 700, txType: 'swap' })
    ]);

    const [withPending, settled] = rows();
    expect(withPending).toHaveAttribute('data-group-pending', '1');
    expect(withPending).toHaveAttribute('data-group-count', '2');
    expect(screen.getAllByTestId('activity-group-pending')).toHaveLength(1);
    expect(settled).toHaveAttribute('data-group-pending', '0');
  });

  it('shows a settled count plainly once the history is exhausted', () => {
    renderList([entry({ secondaryAddress: 'mtst1alice' }), entry({ secondaryAddress: 'mtst1alice' })], {
      hasMore: false
    });
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('marks a count as partial while more pages can still arrive', () => {
    renderList([entry({ secondaryAddress: 'mtst1alice' }), entry({ secondaryAddress: 'mtst1alice' })], {
      hasMore: true,
      scrollParentRef: { current: null }
    });
    expect(screen.getByText('2+')).toBeTruthy();
  });

  it('pages the list as the user scrolls when it has a scroll parent', () => {
    renderList([entry({ secondaryAddress: 'mtst1alice' })], { hasMore: true, scrollParentRef: { current: null } });
    expect(screen.getByTestId('infinite-scroll')).toHaveAttribute('data-has-more', 'true');
  });

  it('skips the scroller entirely without one', () => {
    renderList([entry({ secondaryAddress: 'mtst1alice' })]);
    expect(screen.queryByTestId('infinite-scroll')).toBeNull();
    expect(screen.getByTestId('activity-group-list')).toBeTruthy();
  });

  it('draws the rows plain on the page, not as a card around the whole list', () => {
    renderList([entry({ secondaryAddress: 'mtst1alice' }), entry({ txType: 'swap' })]);

    const list = screen.getByTestId('activity-group-list');
    // The `plain` surface: rows on the page's own margin, hairlines the full width of it.
    expect(list).toHaveClass('[&>*]:px-0', '[&>*]:before:left-0');
    // None of the boxed surfaces: no rounded corner, no border, no grey fill.
    expect(list).not.toHaveClass('rounded-2xl');
    expect(list).not.toHaveClass('border');
    expect(list).not.toHaveClass('bg-fill');
    expect(list).not.toHaveClass('bg-page');
  });
});
