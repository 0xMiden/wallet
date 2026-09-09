import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
const mockHidden = { ids: new Set<string>(), loaded: true, failed: false, hide: mockHide, restore: mockRestore };

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useActivityClaims', () => ({
  useActivityClaims: () => ({
    items: mockItems,
    accept: mockAccept,
    acceptMany: mockAcceptMany,
    account: { publicKey: 'account' }
  })
}));
jest.mock('app/hooks/useActivityHiddenNotes', () => ({ useActivityHiddenNotes: () => mockHidden }));
jest.mock('app/hooks/useNetworkFeeEstimate', () => ({ useNetworkFeeEstimate: () => '0.01 MIDEN' }));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => mockConfirm }));
jest.mock('lib/animation', () => ({
  springs: { standard: {} },
  durations: { extraSlow: 0 },
  useMotion: () => ({ duration: 0 })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: {} }));
jest.mock('lib/i18n/numbers', () => ({ formatBigInt: () => '1', getAdaptiveDecimalPlaces: () => 3 }));
jest.mock('./History', () => ({
  __esModule: true,
  default: ({
    pendingItems,
    renderPendingItem
  }: {
    pendingItems: PendingActivityItem[];
    renderPendingItem: (item: PendingActivityItem) => React.ReactNode;
  }) => (
    <div data-testid="timeline">
      {pendingItems.map(item => (
        <div key={item.note.id} data-pending-note-id={item.note.id}>
          {renderPendingItem(item)}
        </div>
      ))}
    </div>
  )
}));
jest.mock('components/Loader', () => ({ Loader: () => <span data-testid="claim-spinner" /> }));
jest.mock('components/Button', () => ({
  ButtonVariant: { Secondary: 'secondary' },
  Button: ({
    title,
    variant,
    isLoading,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; isLoading?: boolean }) => (
    <button {...props}>{children ?? (isLoading ? <span data-testid="claim-spinner" /> : title)}</button>
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockItems.forEach(item => {
    item.status = 'pending';
  });
  mockHidden.ids = new Set();
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
  expect(mockConfirm).toHaveBeenCalledWith({ title: 'activityRejectTransfer', children: 'activityRejectExplanation' });
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
  expect(within(card).queryByText('claiming')).not.toBeInTheDocument();
});
