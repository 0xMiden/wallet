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
        {render({ entries: loaded, initialLoading: false, hasMore: false, loadMore: jest.fn() })}
      </div>
    );
  }
}));

// The list itself has its own suite; here it only has to report what it was handed.
jest.mock('./ActivityGroupList', () => ({
  ActivityGroupList: (props: { entries: IHistoryEntry[]; nameOf: (address: string) => string | undefined }) => (
    <div
      data-testid="group-list"
      data-count={String(props.entries.length)}
      data-keys={props.entries.map(e => e.key).join(',')}
      data-alice={props.nameOf('MTST1ALICE') ?? ''}
      data-stranger={props.nameOf('mtst1stranger') ?? ''}
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
const mockClaims: { items: PendingActivityItem[] } = { items: [] };
const mockHidden = { ids: new Set<string>(), loaded: true, failed: false, hide: mockHide, restore: jest.fn() };
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
    isLoadingNotes: false
  })
}));
jest.mock('app/hooks/useActivityHiddenNotes', () => ({ useActivityHiddenNotes: () => mockHidden }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => mockConfirm }));
jest.mock('lib/animation', () => ({ springs: { standard: {} }, durations: {}, useMotion: () => ({ duration: 0 }) }));
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
    mockClaims.items = [];
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

  it("hands History the claims, so a claimed note's consume row is not a group row", () => {
    mockRealHistory = true;
    const claimed = claim('note-claimed', 'claimed');
    mockClaims.items = [claimed];
    mockLatest.push(
      entry({ key: 'consume-claimed', txType: 'consume', consumedNoteIds: ['note-claimed'] }),
      entry({ key: 'send-1' })
    );
    render(<ActivityGroupedHistory search="" />);

    expect(historyProps.pendingItems).toEqual([claimed]);
    expect(screen.getByTestId('group-list')).toHaveAttribute('data-keys', 'send-1');
  });

  it('rolls up the loaded entries and passes the search straight through', () => {
    loaded.push(entry(), entry({ key: 'entry-2' }));
    render(<ActivityGroupedHistory search="usdc" programId="prog-1" />);

    expect(screen.getByTestId('group-list')).toHaveAttribute('data-count', '2');
    expect(historyProps.searchQuery).toBe('usdc');
    expect(historyProps.programId).toBe('prog-1');
    expect(historyProps.address).toBe('0xme');
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
  });
});
