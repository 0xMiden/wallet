import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ActivityPendingHistory } from './ActivityPendingHistory';
import type { PendingActivityItem } from './PendingActivityCard';

const mockAccept = jest.fn();
const mockAcceptMany = jest.fn();
const mockHide = jest.fn();
const mockRestore = jest.fn();
const mockConfirm = jest.fn();
const mockItems: PendingActivityItem[] = ['first', 'second', 'third'].map(id => ({
  note: {
    id,
    faucetId: 'faucet',
    amount: '1000000',
    senderAddress: id,
    isBeingClaimed: false,
    type: 'unknown',
    metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
  },
  status: 'pending'
}));
// Items the claims hook returns. A test that changes statuses between renders swaps in a new array,
// the way the hook publishes a change, so the memoized list sees it.
const mockState = { items: mockItems };
const mockHidden = { ids: new Set<string>(), loaded: true, failed: false, hide: mockHide, restore: mockRestore };
const mockHideNavbar = jest.fn();
let mockPathname = '/history';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useActivityClaims', () => ({
  useActivityClaims: () => ({
    items: mockState.items,
    accept: mockAccept,
    acceptMany: mockAcceptMany,
    account: { publicKey: 'account' }
  })
}));
jest.mock('app/hooks/useActivityHiddenNotes', () => ({ useActivityHiddenNotes: () => mockHidden }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => mockConfirm }));
jest.mock('lib/animation', () => ({
  springs: { standard: {} },
  durations: { extraSlow: 0 },
  useMotion: () => ({ duration: 0 })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn(), useLocation: () => ({ pathname: mockPathname }) }));
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({
  useHideNavbarWhileOpen: (open: boolean) => mockHideNavbar(open)
}));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('lib/i18n/numbers', () => ({ formatBigInt: () => '1', getAdaptiveDecimalPlaces: () => 3 }));
const mockHistoryRenders: Array<{ pendingItems: PendingActivityItem[]; renderPendingItem: unknown }> = [];
jest.mock('./History', () => ({
  __esModule: true,
  default: ({
    pendingItems,
    renderPendingItem
  }: {
    pendingItems: PendingActivityItem[];
    renderPendingItem: (item: PendingActivityItem) => React.ReactNode;
  }) => {
    mockHistoryRenders.push({ pendingItems, renderPendingItem });
    return (
      <div data-testid="timeline">
        {pendingItems.map(item => (
          <div key={item.note.id} data-pending-note-id={item.note.id}>
            {renderPendingItem(item)}
          </div>
        ))}
      </div>
    );
  }
}));
jest.mock('components/Loader', () => ({ Loader: () => <span data-testid="claim-spinner" /> }));
jest.mock('components/Button', () => ({
  ButtonVariant: { Secondary: 'secondary' },
  Button: ({
    title,
    variant,
    isLoading,
    size,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; isLoading?: boolean; size?: string }) => (
    <button {...props} data-size={size}>
      {children ?? (isLoading ? <span data-testid="claim-spinner" /> : title)}
    </button>
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/history';
  mockItems.forEach(item => {
    item.status = 'pending';
  });
  mockState.items = mockItems;
  mockHidden.ids = new Set();
  mockHistoryRenders.length = 0;
  mockConfirm.mockResolvedValue(true);
});

function expandCard(noteId: string): HTMLElement {
  const card = screen.getByTestId('timeline').querySelector(`[data-pending-note-id="${noteId}"]`);
  if (!(card instanceof HTMLElement)) throw new Error(`Missing card ${noteId}`);
  fireEvent.click(within(card).getByRole('button', { expanded: false }));
  return card;
}

it('requires confirmation before hiding a transfer', async () => {
  mockHidden.ids = new Set(['third']);
  render(<ActivityPendingHistory search="" filter="all" />);
  const card = expandCard('first');
  fireEvent.click(within(card).getByRole('button', { name: 'activityRejectTransfer' }));
  await waitFor(() => expect(mockHide).toHaveBeenCalledWith('first'));
  expect(mockConfirm).toHaveBeenCalledWith({
    title: 'activityRejectTransfer',
    children: 'activityRejectExplanation',
    confirmLabel: 'activityRejectTransfer',
    destructive: true
  });
});

it('leaves a transfer in place when the decline is cancelled', async () => {
  mockConfirm.mockResolvedValueOnce(false);
  render(<ActivityPendingHistory search="" filter="all" />);
  const card = expandCard('first');
  fireEvent.click(within(card).getByRole('button', { name: 'activityRejectTransfer' }));
  await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
  await act(async () => {});
  expect(mockHide).not.toHaveBeenCalled();
});

it('does not hide a transfer claimed while the decline dialog was open', async () => {
  let answer: (accepted: boolean) => void = () => {};
  mockConfirm.mockImplementationOnce(
    () =>
      new Promise<boolean>(resolve => {
        answer = resolve;
      })
  );
  const { rerender } = render(<ActivityPendingHistory search="" filter="all" />);
  const card = expandCard('first');
  fireEvent.click(within(card).getByRole('button', { name: 'activityRejectTransfer' }));
  await waitFor(() => expect(mockConfirm).toHaveBeenCalled());

  mockState.items = mockItems.map(item => (item.note.id === 'first' ? { ...item, status: 'claiming' as const } : item));
  rerender(<ActivityPendingHistory search="" filter="all" />);
  await act(async () => answer(true));
  expect(mockHide).not.toHaveBeenCalled();
});

it('hides pending notes when the activity filter excludes incoming transfers', () => {
  render(<ActivityPendingHistory search="" filter="sent" />);
  expect(screen.getByTestId('timeline')).toBeEmptyDOMElement();
});

it('shows Accept All on the pending tab and claims every listed note that can be accepted', () => {
  const [, , claimed] = mockItems;
  if (!claimed) throw new Error('Missing note fixtures');
  claimed.status = 'claimed';
  const { rerender } = render(<ActivityPendingHistory search="" filter="all" />);
  expect(screen.queryByRole('button', { name: 'acceptAll' })).not.toBeInTheDocument();
  rerender(<ActivityPendingHistory search="" filter="pending" />);
  fireEvent.click(screen.getByRole('button', { name: 'acceptAll' }));
  expect(mockAcceptMany).toHaveBeenCalledTimes(1);
  expect(mockAcceptMany.mock.calls[0]?.[0].map((note: { id: string }) => note.id)).toEqual(['first', 'second']);
});

it('pins Accept All below the list and hides the navbar while the pending tab has notes', () => {
  render(<ActivityPendingHistory search="" filter="pending" />);
  const button = screen.getByRole('button', { name: 'acceptAll' });
  // The footer is a sibling after the scroller, not a row inside it, so it stays at the bottom edge.
  const scroller = screen.getByTestId('timeline').closest('.overflow-y-auto');
  if (!scroller) throw new Error('The timeline is not inside the scroller');
  expect(scroller).not.toContainElement(button);
  expect(scroller.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(mockHideNavbar).toHaveBeenLastCalledWith(true);
});

it('gives the navbar back when a Pending search lists no transfer', () => {
  render(<ActivityPendingHistory search="zzz" filter="pending" />);
  expect(screen.queryByRole('button', { name: 'acceptAll' })).not.toBeInTheDocument();
  expect(mockHideNavbar).toHaveBeenLastCalledWith(false);
});

it('keeps the navbar on the other filters and when every note is claimed', () => {
  const { rerender } = render(<ActivityPendingHistory search="" filter="all" />);
  expect(mockHideNavbar).toHaveBeenLastCalledWith(false);
  mockItems.forEach(item => {
    item.status = 'claimed';
  });
  rerender(<ActivityPendingHistory search="" filter="pending" />);
  expect(screen.queryByRole('button', { name: 'acceptAll' })).not.toBeInTheDocument();
  expect(mockHideNavbar).toHaveBeenLastCalledWith(false);
});

it('keeps the navbar while the Activity tab is mounted under another tab', () => {
  // TabLayout keeps a visited tab mounted; the pending list must not hide the
  // navbar on the tab that is actually showing.
  mockPathname = '/';
  render(<ActivityPendingHistory search="" filter="pending" />);
  expect(screen.getByRole('button', { name: 'acceptAll' })).toBeInTheDocument();
  expect(mockHideNavbar).toHaveBeenLastCalledWith(false);
});

it('opens the same details and footer for a pending and a claimed note', () => {
  const [, , claimed] = mockItems;
  if (!claimed) throw new Error('Missing note fixtures');
  claimed.status = 'claimed';
  claimed.txId = 'tx-claimed';
  render(<ActivityPendingHistory search="" filter="all" />);
  const pendingCard = expandCard('first');
  expect(within(pendingCard).getByText('activityNotYetAccepted')).toBeInTheDocument();
  expect(within(pendingCard).getByRole('button', { name: 'activityAcceptTransfer' })).toBeInTheDocument();
  const claimedCard = expandCard('third');
  expect(within(claimedCard).getByText('activityTransferAccepted')).toBeInTheDocument();
  expect(within(claimedCard).getByRole('button', { name: 'activityTransferDetails' })).toBeInTheDocument();
  expect(within(claimedCard).queryByRole('button', { name: 'activityAcceptTransfer' })).not.toBeInTheDocument();
  delete claimed.txId;
});

it('lists only unclaimed notes under the pending filter', () => {
  const [, , claimed] = mockItems;
  if (!claimed) throw new Error('Missing note fixtures');
  claimed.status = 'claimed';
  render(<ActivityPendingHistory search="" filter="pending" />);
  const timeline = screen.getByTestId('timeline');
  expect(timeline.querySelector('[data-pending-note-id="first"]')).toBeInTheDocument();
  expect(timeline.querySelector('[data-pending-note-id="second"]')).toBeInTheDocument();
  expect(timeline.querySelector('[data-pending-note-id="third"]')).not.toBeInTheDocument();
});

it('hides checking and unavailable notes, then shows notes that can be accepted', () => {
  const [checking, unavailable] = mockItems;
  if (!checking || !unavailable) throw new Error('Missing note fixtures');
  checking.status = 'checking';
  unavailable.status = 'unavailable';
  const { container, rerender } = render(<ActivityPendingHistory search="" filter="all" />);
  expect(container.querySelector('[data-pending-note-id="first"]')).toBeNull();
  expect(container.querySelector('[data-pending-note-id="second"]')).toBeNull();
  expect(screen.queryByText('activityCheckingTransfer')).not.toBeInTheDocument();
  checking.status = 'pending';
  mockState.items = [...mockItems];
  rerender(<ActivityPendingHistory search="" filter="all" />);
  expect(container.querySelector('[data-pending-note-id="first"]')).not.toBeNull();
});

it('uses the full action area for the claim spinner', () => {
  const [claiming] = mockItems;
  if (!claiming) throw new Error('Missing note fixture');
  claiming.status = 'claiming';
  render(<ActivityPendingHistory search="" filter="all" />);
  const card = expandCard('first');
  expect(within(card).queryByRole('button', { name: 'activityRejectTransfer' })).not.toBeInTheDocument();
  expect(within(card).getAllByRole('button')).toHaveLength(2);
  expect(within(card).getByTestId('claim-spinner')).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'activityAcceptingTransfer' })).toBeInTheDocument();
  expect(within(card).queryByText('activityAcceptingTransfer')).not.toBeInTheDocument();
});

it('offers Restore under the Pending filter while declined transfers can still be accepted', () => {
  const [, failed] = mockItems;
  if (!failed) throw new Error('Missing note fixtures');
  failed.status = 'failed';
  mockHidden.ids = new Set(['first', 'second', 'gone']);
  const { rerender } = render(<ActivityPendingHistory search="" filter="all" />);
  expect(screen.queryByRole('button', { name: 'activityRestoreTransfers' })).not.toBeInTheDocument();

  rerender(<ActivityPendingHistory search="" filter="pending" />);
  expect(screen.getByTestId('timeline').querySelector('[data-pending-note-id="first"]')).toBeNull();
  expect(screen.getByText('activityHiddenTransfers')).toBeInTheDocument();
  const restoreButton = screen.getByRole('button', { name: 'activityRestoreTransfers' });
  // The canonical `sm` size replaces the old manual px-3/py-2/text-xs override.
  expect(restoreButton).toHaveAttribute('data-size', 'sm');
  expect(restoreButton.className).not.toMatch(/\btext-xs\b|\bpy-2\b/);
  fireEvent.click(restoreButton);
  expect(mockRestore).toHaveBeenCalledTimes(1);
});

it('does not offer Restore when every declined transfer is gone or already claimed', () => {
  const [, , claimed] = mockItems;
  if (!claimed) throw new Error('Missing note fixtures');
  claimed.status = 'claimed';
  mockHidden.ids = new Set(['third', 'gone']);
  render(<ActivityPendingHistory search="" filter="pending" />);
  expect(screen.queryByRole('button', { name: 'activityRestoreTransfers' })).not.toBeInTheDocument();
});

it('hands the timeline the same pending items and renderer when a render changes no pending item', () => {
  const { rerender } = render(<ActivityPendingHistory search="" filter="all" />);
  rerender(<ActivityPendingHistory search="" filter="all" />);
  expect(mockHistoryRenders).toHaveLength(2);
  const [first, second] = mockHistoryRenders;
  expect(second?.pendingItems).toBe(first?.pendingItems);
  expect(second?.renderPendingItem).toBe(first?.renderPendingItem);
});

it('keeps cached, unconfirmed notes out of Accept All and off the card actions', () => {
  const [cached] = mockItems;
  if (!cached) throw new Error('Missing note fixtures');
  const confirmed = cached.note;
  cached.note = { ...confirmed, fromCache: true };
  try {
    render(<ActivityPendingHistory search="" filter="pending" />);
    fireEvent.click(screen.getByRole('button', { name: 'acceptAll' }));
    expect(mockAcceptMany.mock.calls[0]?.[0].map((note: { id: string }) => note.id)).toEqual(['second', 'third']);
    const card = expandCard('first');
    expect(within(card).getByRole('button', { name: 'activityAcceptTransfer' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: 'activityRejectTransfer' })).toBeDisabled();
  } finally {
    cached.note = confirmed;
  }
});

it('draws each pending transfer as an outlined card on the page', () => {
  render(<ActivityPendingHistory search="" filter="all" />);
  const card = screen.getByTestId('timeline').querySelector('[data-pending-note-id="first"] article');
  if (!(card instanceof HTMLElement)) throw new Error('Missing pending card');
  expect(card).toHaveClass('bg-page', 'border', 'border-hairline', 'rounded-2xl', 'overflow-hidden');
  expect(card).not.toHaveClass('bg-fill');
  expect(card).not.toHaveClass('bg-white');
});
