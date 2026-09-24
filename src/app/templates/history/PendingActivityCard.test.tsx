import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { markActivityRead, resetActivityReadState } from 'lib/settings/activity-read';

import { PendingActivityCard, type PendingActivityItem, type PendingActivityStatus } from './PendingActivityCard';

const mockNavigate = jest.fn();

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// The presets, with the transition of each tagged so the card's CHOICE of transition is readable.
// `reducedMotionTransition` keeps its real shape: it is what the card falls back to, and the tests
// below tell the two apart by name, not by duration.
const MOCK_REVEAL_TRANSITION = { type: 'spring', preset: 'reveal' };
jest.mock('lib/animation', () => ({
  springs: { standard: {}, settle: {} },
  useMotion: () => ({ duration: 0 }),
  usePreset: (name: string) => ({
    initial: { height: 0, opacity: 0 },
    animate: { height: 'auto', opacity: 1 },
    exit: { height: 0, opacity: 0 },
    transition: name === 'reveal' ? MOCK_REVEAL_TRANSITION : { duration: 0 }
  }),
  reducedMotionTransition: { duration: 0.001 }
}));
// framer-motion, real, with `motion.div` wrapped so the disclosure's props can be read. A
// transition is handed to Framer, never written to the DOM, and WHICH transition the card picked
// is the whole subject of these tests. The disclosure is the only `motion.div` here carrying an
// `id` (it is the target of the toggle's `aria-controls`).
const mockDisclosure: { props: Record<string, unknown> | null } = { props: null };
jest.mock('framer-motion', () => {
  const actual = jest.requireActual<typeof import('framer-motion')>('framer-motion');
  const react: typeof import('react') = require('react');
  const Div = react.forwardRef<HTMLDivElement, Record<string, unknown>>(function MockMotionDiv(props, ref) {
    if (props.id !== undefined) mockDisclosure.props = props;
    return react.createElement(actual.motion.div, { ...props, ref });
  });
  const motion = new Proxy(actual.motion, {
    get: (target, key) => (key === 'div' ? Div : Reflect.get(target, key))
  });
  return { ...actual, motion };
});
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/woozie', () => ({ navigate: (path: string) => mockNavigate(path) }));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <svg data-testid={`icon-${name}`} />,
  IconName: { Receive: 'receive', ChevronDown: 'chevron-down' }
}));
jest.mock('lib/i18n/numbers', () => ({ formatBigInt: () => '1', getAdaptiveDecimalPlaces: () => 3 }));

const note: ClaimableNoteWithMetadata = {
  id: 'note-1',
  faucetId: 'faucet',
  amount: '1000000',
  senderAddress: 'mtst1senderaddress0000',
  isBeingClaimed: false,
  type: 'unknown',
  metadata: { name: 'Token', symbol: 'TOK', decimals: 6 }
};

const renderCard = (
  status: PendingActivityStatus,
  over: Partial<PendingActivityItem> = {},
  onAccept: (note: ClaimableNoteWithMetadata) => void = jest.fn()
) => {
  const item: PendingActivityItem = { note, status, ...over };
  return render(<PendingActivityCard item={item} onAccept={onAccept} onReject={jest.fn()} />);
};

describe('PendingActivityCard', () => {
  // Resolving a `height: auto` keyframe makes Framer measure the element, which calls
  // `window.scrollTo` — unimplemented in jsdom, and noisy rather than fatal. Stub it away.
  beforeAll(() => Object.defineProperty(window, 'scrollTo', { value: () => {}, writable: true }));
  beforeEach(() => jest.clearAllMocks());
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    resetActivityReadState();
  });

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

    it('unfolds and folds the section on the reveal preset when the toggle is pressed', () => {
      // Brian's ask: tapping the chevron animates, both ways. The motion is the design system's
      // `reveal` — height 0 ↔ auto plus opacity — taken from `usePreset`, so no duration is written
      // at the call site and reduced motion is already handled. `exit` is asserted alongside
      // `initial`/`animate`: the fold away is half of what was asked for, and it is configured at
      // the same moment as the unfold rather than on the click that closes it.
      renderCard('pending');
      const toggle = screen.getByRole('button', { expanded: false });

      fireEvent.click(toggle);

      const details = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      expect(details).not.toBeNull();
      expect(details).toContainElement(screen.getByText('amount'));
      expect(details?.className ?? '').toContain('overflow-hidden');
      expect(mockDisclosure.props?.transition).toEqual(MOCK_REVEAL_TRANSITION);
      expect(mockDisclosure.props?.initial).toEqual({ height: 0, opacity: 0 });
      expect(mockDisclosure.props?.animate).toEqual({ height: 'auto', opacity: 1 });
      expect(mockDisclosure.props?.exit).toEqual({ height: 0, opacity: 0 });

      // Closing keeps the spring: a fold away is a tap too.
      fireEvent.click(toggle);
      expect(screen.getByRole('button', { expanded: false })).toBe(toggle);
      expect(mockDisclosure.props?.transition).toEqual(MOCK_REVEAL_TRANSITION);
    });

    it('does not animate a card the list rebuilt, only one the user pressed', () => {
      // Switching the Activity filter renders a different list, so a card comes back as a FRESH
      // mount — the case `AnimatePresence initial={false}` could not cover, because it suppresses
      // the entry animation only for children present when it first mounts. The gate is per-mount
      // state instead: a rebuilt card starts closed, so it draws no section at all and cannot
      // inherit the tap that opened the card it replaced.
      const first = renderCard('pending');
      fireEvent.click(screen.getByRole('button', { expanded: false }));
      expect(mockDisclosure.props?.transition).toEqual(MOCK_REVEAL_TRANSITION);
      first.unmount();

      mockDisclosure.props = null;
      const { container } = renderCard('pending');

      expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
      expect(screen.queryByText('activityNotYetAccepted')).toBeNull();
      // Nothing for an entry animation to act on, and nothing mid-flight: no disclosure was
      // rendered, and the chevron mounts at its resting transform rather than tweening to it.
      expect(mockDisclosure.props).toBeNull();
      const chevron = screen.getByTestId('icon-chevron-down').parentElement;
      expect(chevron).toHaveStyle({ transform: 'none' });
      for (const styled of Array.from(container.querySelectorAll('[style]'))) {
        expect(styled.getAttribute('style')).not.toMatch(/height|opacity/);
      }
    });

    it('drops the motion while a claim is in flight, mid-tween if need be', () => {
      // "Just not when loading". A claim re-renders the card as its status walks checking →
      // claiming, and the transition is re-read on every one of those renders rather than latched
      // when the animation started — so an open section that was unfolding when the claim landed
      // finishes instantly instead of riding the spring out under a changing card.
      const item: PendingActivityItem = { note, status: 'pending' };
      const { rerender } = render(<PendingActivityCard item={item} onAccept={jest.fn()} onReject={jest.fn()} />);
      fireEvent.click(screen.getByRole('button', { expanded: false }));
      expect(mockDisclosure.props?.transition).toEqual(MOCK_REVEAL_TRANSITION);

      rerender(<PendingActivityCard item={{ note, status: 'claiming' }} onAccept={jest.fn()} onReject={jest.fn()} />);

      expect(mockDisclosure.props?.transition).toEqual({ duration: 0.001 });
      // The section itself is untouched — only how it moves changes.
      expect(screen.getByText('amount')).toBeInTheDocument();
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

      const accept = screen.getByRole('button', { name: 'activityAcceptingTransfer' });
      expect(accept).not.toBeDisabled();
      expect(accept).toHaveAttribute('aria-busy', 'true');
      expect(screen.queryByRole('button', { name: 'activityRejectTransfer' })).toBeNull();
    });
  });

  describe('unread', () => {
    it('arrives unread and says so, not by colour alone', () => {
      renderCard('pending');

      const dot = screen.getByTestId('pending-activity-unread');
      expect(dot).toHaveClass('bg-notification');
      expect(screen.getByRole('button', { expanded: false })).toHaveAccessibleName(/activityUnread/);
    });

    it('clears when the transfer is accepted — the decision, not a glance, settles it', () => {
      const onAccept = jest.fn();
      const { rerender } = renderCard('pending', {}, onAccept);

      fireEvent.click(screen.getByRole('button', { name: /activityAcceptTransfer/ }));
      expect(onAccept).toHaveBeenCalledWith(note);

      rerender(<PendingActivityCard item={{ note, status: 'claiming' }} onAccept={onAccept} onReject={jest.fn()} />);
      expect(screen.queryByTestId('pending-activity-unread')).toBeNull();
    });

    it('stays read once it has been declined elsewhere', () => {
      markActivityRead('note:note-1', Number.NaN);
      renderCard('pending');

      expect(screen.queryByTestId('pending-activity-unread')).toBeNull();
    });
  });

  describe('an accepted transfer', () => {
    it('is not this component at all: the card has no accepted state', () => {
      // `ActivityPendingHistory` drops a claimed item from the card list and `History` stops
      // standing its consume row down, so an accepted transfer is drawn by the SAME row component
      // as every other settled transaction — which brings its own navigation to the detail page.
      // Nothing here special-cases it, and the unread mark travels with that row.
      const { container } = renderCard('claimed', { txId: 'tx-1' });

      expect(container.querySelector('[data-pending-status="claimed"]')).toBeTruthy();
      expect(screen.queryByText('activityTransferDetails')).toBeNull();
      expect(screen.queryByTestId('pending-activity-row-status')).toHaveTextContent('pending');
    });
    it('explains the wait in the shared notice: one type size, upright, clear of the buttons', () => {
      const recallable: PendingActivityItem = {
        note: { ...note, recallableAtMs: Date.UTC(2026, 0, 2) },
        status: 'pending'
      };
      render(<PendingActivityCard item={recallable} onAccept={jest.fn()} onReject={jest.fn()} />);
      fireEvent.click(screen.getByRole('button', { expanded: false }));

      const notice = screen.getByTestId('pending-activity-hint');
      expect(notice).toHaveAttribute('data-tone', 'neutral');
      expect(notice).toHaveAttribute('role', 'status');
      // Both lines at 13px: the explanation bold in the tone's ink, the deadline under it in the
      // quieter one. One size, two weights — not 14px over 12px, and not a page-local grey band.
      const explanation = notice.querySelector('[data-slot="title"]');
      const deadline = notice.querySelector('[data-slot="body"]');
      expect(explanation).toHaveTextContent('activityNotYetAccepted');
      expect(explanation).toHaveClass('text-label');
      expect(deadline).toHaveTextContent(/^noteReturnsToSenderBy/);
      expect(deadline).toHaveClass('text-caption', 'text-muted');
      expect(notice.className).not.toContain('italic');
      expect(notice.className).not.toContain('text-center');
      // The block sits in the card's own margin with room under it, so it no longer shares an
      // edge with the action row.
      expect(notice.parentElement).toHaveClass('px-4', 'py-3');
    });
    it('turns the notice negative, and says so in words, when the claim failed', () => {
      renderCard('failed');
      fireEvent.click(screen.getByRole('button', { expanded: false }));

      const notice = screen.getByTestId('pending-activity-hint');
      expect(notice).toHaveAttribute('data-tone', 'negative');
      expect(notice).toHaveAttribute('role', 'alert');
      expect(notice).toHaveTextContent('noteClaimFailedRetry');
      // Nothing subordinate to say, so there is no empty second line under it.
      expect(notice.querySelector('[data-slot="body"]')).toBeNull();
    });
    it('draws Decline and Accept as the app own pill buttons, at the row action size', () => {
      renderCard('pending');

      for (const name of ['activityRejectTransfer', 'activityAcceptTransfer']) {
        const button = screen.getByRole('button', { name });
        // The shared `sm` size — the same one the Pending list's Accept All uses — not the 48px
        // page CTA, which took over a card whose whole row above it is 40px, and not a
        // squared-off panel with its shape argued away.
        expect(button).toHaveClass('h-9', 'rounded-full', 'text-cta-sm');
        expect(button).not.toHaveClass('h-12', 'text-cta');
        expect(button.className).not.toContain('!');
        expect(button.className).not.toContain('text-sm');
      }
      // The footer's bottom padding came down with them, so a shorter button leaves no band of
      // empty space under the card.
      expect(screen.getByRole('button', { name: 'activityRejectTransfer' }).parentElement).toHaveClass('pb-3');
    });
  });
});
