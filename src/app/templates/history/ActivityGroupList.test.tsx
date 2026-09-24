import React from 'react';

import { render, screen } from '@testing-library/react';

import { ActivityGroupList } from './ActivityGroupList';
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

// Undefined leaves the real labels in place; a test sets sentinels to prove whose map the rows read.
const mockLabels: { value?: Record<string, string> } = {};
jest.mock('./activityGroups', () => {
  const actual = jest.requireActual('./activityGroups');
  return {
    ...actual,
    get ACTIVITY_GROUP_LABELS() {
      return mockLabels.value ?? actual.ACTIVITY_GROUP_LABELS;
    }
  };
});

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

/** One entry for each category group. */
const CATEGORY_ENTRIES = () => [
  entry({ timestamp: 900, txType: 'swap' }),
  entry({ timestamp: 800, txType: 'switch-guardian' }),
  entry({ timestamp: 700, txType: 'consume', transactionIcon: 'RECEIVE', faucetId: FAUCET, secondaryAddress: FAUCET }),
  entry({ timestamp: 600, txType: 'execute' })
];

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

  it('titles each category row from the shared label map', () => {
    mockLabels.value = { swap: 'label-swap', faucet: 'label-faucet', guardian: 'label-guardian', other: 'label-other' };
    try {
      renderList(CATEGORY_ENTRIES());

      for (const kind of ['swap', 'faucet', 'guardian', 'other']) {
        expect(screen.getByText(`label-${kind}`)).toBeTruthy();
      }
    } finally {
      mockLabels.value = undefined;
    }
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

  describe('search', () => {
    const ALICE = 'mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqqaaaa';
    const BOB = 'mtst1zzzzzzzzzzzzzzzzzzzzzzzzzzzzbbbb';
    const searchable = () => [
      entry({ timestamp: 900, secondaryAddress: ALICE }),
      entry({ timestamp: 800, secondaryAddress: BOB, token: 'USDC' }),
      entry({ timestamp: 700, txType: 'swap', message: 'Swapped' })
    ];
    const nameOf = (address: string) => (address === ALICE ? 'Alice' : undefined);
    const shownIds = () => rows().map(row => row.getAttribute('data-group-id'));

    it("keeps a group found only by its contact's name", () => {
      renderList(searchable(), { nameOf, searchQuery: ' ALI ' });
      expect(shownIds()).toEqual([ALICE]);
    });

    it('keeps a group found only by its category label', () => {
      renderList(searchable(), { nameOf, searchQuery: 'GroupSwaps' });
      expect(shownIds()).toEqual(['swap']);
    });

    it("keeps a group one of whose entries matches, by the entry's token", () => {
      renderList(searchable(), { nameOf, searchQuery: 'usdc' });
      expect(shownIds()).toEqual([BOB]);
    });

    it('shows the empty state when no group matches', () => {
      renderList(searchable(), { nameOf, searchQuery: 'zzzz-nothing' });
      expect(screen.queryByTestId('activity-group-row')).toBeNull();
      expect(screen.getByText('noOperationsFound')).toBeTruthy();
    });
  });
});
