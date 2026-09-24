import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ActivityGroupedHistory } from './ActivityGroupedHistory';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import type { PendingActivityItem } from './PendingActivityCard';

const entry = (over: Partial<IHistoryEntry> = {}): IHistoryEntry => ({
  key: 'entry-1',
  address: 'me',
  timestamp: 1_000,
  message: 'Sent',
  type: HistoryEntryType.CompletedTransaction,
  txType: 'send',
  ...over
});

// The loaded entries this view rolls up, plus the props it hands `History`.
const loaded: IHistoryEntry[] = [];
let historyProps: Record<string, unknown> = {};
// Set by a case that needs History's own filtering rather than the stub below.
let mockRealHistory = false;
const mockLatest: IHistoryEntry[] = [];
// What the stubbed History reports about paging.
const mockView = { hasMore: false };

jest.mock('./History', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    historyProps = props;
    if (mockRealHistory) {
      const Real = jest.requireActual('./History').default;
      return <Real {...props} />;
    }
    const render = props.renderEntries as (view: unknown) => React.ReactNode;
    return (
      <div data-testid="history">
        {render({ entries: loaded, initialLoading: false, hasMore: mockView.hasMore, loadMore: jest.fn() })}
      </div>
    );
  }
}));

// The list itself has its own suite; here it only has to report what it was handed.
jest.mock('./ActivityGroupList', () => ({
  ActivityGroupList: (props: {
    entries: IHistoryEntry[];
    nameOf: (address: string) => string | undefined;
    hasMore: boolean;
    searchQuery?: string;
  }) => (
    <div
      data-testid="group-list"
      data-count={String(props.entries.length)}
      data-has-more={String(props.hasMore)}
      data-keys={props.entries.map(e => e.key).join(',')}
      data-search={props.searchQuery ?? ''}
      data-alice={props.nameOf('MTST1ALICE') ?? ''}
      data-stranger={props.nameOf('mtst1stranger') ?? ''}
      data-blank={String(props.nameOf('mtst1blank'))}
    />
  )
}));

const contacts = {
  value: [
    { address: 'mtst1alice', name: 'Alice' },
    { address: 'mtst1blank', name: '   ' }
  ] as Array<{ address: string; name: string }>
};
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contacts.value, contacts: contacts.value })
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: (key: unknown[]) => ({
    data: key[0] === 'latest-transactions' ? mockLatest : [],
    isLoading: false,
    mutate: jest.fn()
  })
}));
jest.mock('lib/miden/activity', () => ({
  cancelTransactionById: jest.fn(),
  getCompletedTransactions: jest.fn(),
  getUncompletedTransactions: jest.fn(),
  isCancellableTransaction: () => false,
  isUserCancelledTransaction: () => false,
  suppressedLinkedConsumeIds: jest.fn(),
  USER_CANCELLED_TRANSACTION_REASON: 'cancelled'
}));

const mockAccept = jest.fn();
const mockHide = jest.fn();
const mockConfirm = jest.fn();
const mockRestore = jest.fn();
const mockClaims: { items: PendingActivityItem[]; isLoadingNotes: boolean } = { items: [], isLoadingNotes: false };
const mockHidden = { ids: new Set<string>(), loaded: true, failed: false, hide: mockHide, restore: mockRestore };
const claim = (id: string, status: PendingActivityItem['status']): PendingActivityItem => ({
  note: {
    id,
    faucetId: 'faucet',
    amount: '1000000',
    senderAddress: 'mtst1sender',
    isBeingClaimed: false,
    type: 'unknown',
    metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
  },
  status
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useActivityClaims', () => ({
  useActivityClaims: () => ({
    items: mockClaims.items,
    accept: mockAccept,
    acceptMany: jest.fn(),
    account: { publicKey: '0xme' },
    isLoadingNotes: mockClaims.isLoadingNotes
  })
}));
jest.mock('app/hooks/useActivityHiddenNotes', () => ({ useActivityHiddenNotes: () => mockHidden }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => mockConfirm }));
// The real History reaches the `components/ui` barrel through HistoryView, and the barrel's
// WaveDots reads `easings` at module load.
jest.mock('lib/animation', () => ({
  springs: { standard: {} },
  durations: {},
  easings: {},
  reducedMotionTransition: {},
  useMotion: () => ({ duration: 0 }),
  // C9's pending card takes its disclosure motion from the `reveal` preset.
  usePreset: () => ({ initial: {}, animate: {}, exit: {}, transition: { duration: 0 } })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn(), useLocation: () => ({ pathname: '/history' }) }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('lib/i18n/numbers', () => ({ formatBigInt: () => '1', getAdaptiveDecimalPlaces: () => 3 }));
jest.mock('components/Button', () => ({
  ButtonVariant: { Secondary: 'secondary' },
  Button: ({
    title,
    variant,
    isLoading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    isLoading?: boolean;
  }) => <button {...props}>{title}</button>
}));

describe('ActivityGroupedHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loaded.length = 0;
    historyProps = {};
    mockRealHistory = false;
    mockLatest.length = 0;
    mockView.hasMore = false;
    mockClaims.items = [];
    mockClaims.isLoadingNotes = false;
    mockHidden.ids = new Set();
    mockConfirm.mockResolvedValue(true);
  });

  it('draws an incoming transfer above the groups, with Accept and Decline', async () => {
    mockClaims.items = [claim('note-1', 'pending')];
    render(<ActivityGroupedHistory search="" />);

    const card = screen.getByTestId('activity-group-claims').querySelector('[data-pending-note-id="note-1"]');
    if (!(card instanceof HTMLElement)) throw new Error('Missing claim card');
    expect(
      card.compareDocumentPosition(screen.getByTestId('group-list')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'activityAcceptTransfer' }));
    expect(mockAccept).toHaveBeenCalledWith(mockClaims.items[0]?.note);

    fireEvent.click(within(card).getByRole('button', { name: 'activityRejectTransfer' }));
    await waitFor(() => expect(mockHide).toHaveBeenCalledWith('note-1'));
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'activityRejectTransfer' }));
  });

  it('offers Restore above the claim cards while a declined transfer can still be accepted', () => {
    mockClaims.items = [claim('note-declined', 'pending'), claim('note-open', 'pending')];
    mockHidden.ids = new Set(['note-declined']);
    render(<ActivityGroupedHistory search="" />);

    expect(screen.getByText('activityHiddenTransfers')).toBeInTheDocument();
    const restore = screen.getByRole('button', { name: 'activityRestoreTransfers' });
    expect(
      restore.compareDocumentPosition(screen.getByTestId('activity-group-claims')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(restore);
    expect(mockRestore).toHaveBeenCalledTimes(1);
  });

  it('offers no Restore when no declined transfer can still be accepted', () => {
    mockClaims.items = [claim('note-declined', 'claimed')];
    mockHidden.ids = new Set(['note-declined', 'gone']);
    render(<ActivityGroupedHistory search="" />);

    expect(screen.queryByRole('button', { name: 'activityRestoreTransfers' })).toBeNull();
  });

  it('shows the claims loading while incoming notes are still being read', () => {
    const { rerender } = render(<ActivityGroupedHistory search="" />);
    expect(screen.queryByRole('progressbar')).toBeNull();

    mockClaims.isLoadingNotes = true;
    rerender(<ActivityGroupedHistory search="" />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it("hands History the claims, so a claiming note's consume row is not a group row", () => {
    mockRealHistory = true;
    const claiming = claim('note-claiming', 'claiming');
    mockClaims.items = [claiming];
    mockLatest.push(
      entry({ key: 'consume-claiming', txType: 'consume', consumedNoteIds: ['note-claiming'] }),
      entry({ key: 'send-1' })
    );
    render(<ActivityGroupedHistory search="" />);

    expect(historyProps.pendingItems).toEqual([claiming]);
    expect(screen.getByTestId('group-list')).toHaveAttribute('data-keys', 'send-1');
  });

  it("keeps a claiming note's consume row out of the groups while a search hides its card", () => {
    mockRealHistory = true;
    const claiming = claim('note-claiming', 'claiming');
    mockClaims.items = [claiming];
    mockLatest.push(
      entry({ key: 'consume-claiming', txType: 'consume', consumedNoteIds: ['note-claiming'] }),
      entry({ key: 'send-1' })
    );
    render(<ActivityGroupedHistory search="zzzz-nothing" />);

    expect(historyProps.pendingItems).toEqual([claiming]);
    expect(screen.queryByTestId('activity-group-claims')).toBeNull();
    expect(screen.getByTestId('group-list')).toHaveAttribute('data-keys', 'send-1');
  });

  it('rolls up the loaded entries and searches the groups rather than the entries', () => {
    loaded.push(entry(), entry({ key: 'entry-2' }));
    render(<ActivityGroupedHistory search="usdc" programId="prog-1" />);

    expect(screen.getByTestId('group-list')).toHaveAttribute('data-count', '2');
    expect(historyProps.searchQuery).toBeUndefined();
    expect(screen.getByTestId('group-list')).toHaveAttribute('data-search', 'usdc');
    expect(historyProps.programId).toBe('prog-1');
    expect(historyProps.address).toBe('0xme');
  });

  it("gives the groups final counts, since History's first read already holds the whole history", () => {
    mockView.hasMore = true;
    render(<ActivityGroupedHistory search="" />);

    expect(screen.getByTestId('group-list')).toHaveAttribute('data-has-more', 'false');
  });

  it('narrows by nothing else: grouping the whole history is what this view filters by', () => {
    render(<ActivityGroupedHistory search="" />);

    expect(historyProps.filter).toBeUndefined();
    expect(historyProps.predicate).toBeUndefined();
  });

  it('keeps the rows still in flight, so a group can report them', () => {
    loaded.push(entry({ type: HistoryEntryType.PendingTransaction }), entry({ key: 'entry-2' }));
    render(<ActivityGroupedHistory search="" />);

    expect(screen.getByTestId('group-list')).toHaveAttribute('data-count', '2');
  });

  it('resolves a counterparty to its contact, whatever the case, and ignores a blank name', () => {
    render(<ActivityGroupedHistory search="" />);

    const list = screen.getByTestId('group-list');
    expect(list).toHaveAttribute('data-alice', 'Alice');
    expect(list).toHaveAttribute('data-stranger', '');
    expect(list).toHaveAttribute('data-blank', 'undefined');
  });
});
