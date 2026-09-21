import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { NoteWithMetadata } from 'app/pages/Receive/PendingTab';

import { PendingActivityCard, type PendingActivityItem, type PendingActivityStatus } from './PendingActivityCard';

const mockNavigate = jest.fn();

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/animation', () => ({
  springs: { standard: {}, settle: {} },
  useMotion: () => ({ duration: 0 }),
  usePreset: () => ({ transition: { duration: 0 } })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: (path: string) => mockNavigate(path) }));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <svg data-testid={`icon-${name}`} />,
  IconName: { Receive: 'receive', ChevronDown: 'chevron-down' }
}));
jest.mock('lib/i18n/numbers', () => ({ formatBigInt: () => '1', getAdaptiveDecimalPlaces: () => 3 }));

const note: NoteWithMetadata = {
  id: 'note-1',
  faucetId: 'faucet',
  amount: '1000000',
  senderAddress: 'mtst1senderaddress0000',
  isBeingClaimed: false,
  type: 'unknown',
  metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
};

const renderCard = (status: PendingActivityStatus, over: Partial<PendingActivityItem> = {}) => {
  const item: PendingActivityItem = { note, status, ...over };
  return render(<PendingActivityCard item={item} onAccept={jest.fn()} onReject={jest.fn()} />);
};

describe('PendingActivityCard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps the row a named control whatever its status', () => {
    for (const status of ['pending', 'claimed'] as const) {
      const { unmount } = renderCard(status, { txId: 'tx-1' });
      expect(screen.getByRole('button', { name: /received/i })).toBeInTheDocument();
      unmount();
    }
  });

  describe('an open note', () => {
    it('is a toggle with a chevron that folds the detail rows', () => {
      renderCard('pending');

      const toggle = screen.getByRole('button', { expanded: false });
      expect(screen.getByTestId('icon-chevron-down')).toBeInTheDocument();
      expect(screen.queryByText('activityNotYetAccepted')).toBeNull();

      fireEvent.click(toggle);
      expect(screen.getByRole('button', { expanded: true })).toBe(toggle);
      expect(screen.getByText('activityNotYetAccepted')).toBeInTheDocument();
    });

    it('draws Decline and Accept as the app own pill buttons, with nothing overridden', () => {
      renderCard('pending');

      for (const name of ['activityRejectTransfer', 'activityAcceptTransfer']) {
        const button = screen.getByRole('button', { name });
        // The shared CTA size and radius, not a squared-off panel with its shape argued away.
        expect(button).toHaveClass('h-12', 'rounded-full', 'text-cta');
        expect(button.className).not.toContain('!');
        expect(button.className).not.toContain('text-sm');
      }
    });

    it('keeps the action row static, so a filter change cannot replay a width animation', () => {
      // The footer used to expand Decline from 0 to 40% inside an `AnimatePresence`, which
      // replayed on every remount — and switching the Activity filter remounts every card.
      renderCard('pending');

      const decline = screen.getByRole('button', { name: 'activityRejectTransfer' });
      expect(decline).toHaveClass('w-2/5');
      // No animated wrapper left to replay: the button sits directly in the static footer row.
      expect(decline.parentElement).toHaveClass('flex', 'gap-2.5');
      expect(decline.parentElement?.className).not.toContain('overflow-hidden');
    });

    it('shows the claim in progress as the button own loading state rather than as disabled', () => {
      renderCard('claiming');

      const accept = screen.getByRole('button', { name: 'claiming' });
      expect(accept).not.toBeDisabled();
      expect(accept).toHaveAttribute('aria-busy', 'true');
      expect(screen.queryByRole('button', { name: 'activityRejectTransfer' })).toBeNull();
    });
  });

  describe('an accepted transfer', () => {
    it('is not this component at all: the card has no accepted state', () => {
      // `ActivityPendingHistory` drops a claimed item from the card list and `History` stops
      // standing its consume row down, so an accepted transfer is drawn by the SAME row component
      // as every other settled transaction — which brings its own navigation to the detail page.
      // Nothing here special-cases it.
      const { container } = renderCard('claimed', { txId: 'tx-1' });

      expect(container.querySelector('[data-pending-status="claimed"]')).toBeTruthy();
      expect(screen.queryByText('activityTransferDetails')).toBeNull();
      expect(screen.queryByTestId('pending-activity-row-status')).toHaveTextContent('pending');
    });
  });
});
