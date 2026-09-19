import React from 'react';

import { render, screen } from '@testing-library/react';

import enMessages from '../../../public/_locales/en/en.json';
import { Status, STATUS_BADGE, StatusBadge } from './StatusBadge';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` })
}));

let mockReduceMotion: boolean | null = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduceMotion
}));

beforeEach(() => {
  mockReduceMotion = false;
});

const STATUSES = Object.keys(STATUS_BADGE) as Status[];

const TONE_CLASSES = {
  positive: ['bg-positive-tint', 'text-positive-ink'],
  pending: ['bg-pending-tint', 'text-pending-ink'],
  negative: ['bg-negative-tint', 'text-negative-ink'],
  neutral: ['bg-fill-pressed', 'text-ink']
} as const;

const dotOf = (badge: HTMLElement) => badge.querySelector('[aria-hidden="true"]');

describe('StatusBadge', () => {
  it.each([
    ['pending', 'pending', 'pending'],
    ['inProgress', 'inProgress', 'pending'],
    ['confirmed', 'confirmed', 'positive'],
    ['failed', 'failed', 'negative'],
    ['cancelled', 'cancelled', 'neutral'],
    ['reclaimed', 'reclaimed', 'neutral'],
    ['claimed', 'activityTransferClaimed', 'positive'],
    ['redeeming', 'earnWithdrawStatusRedeeming', 'pending'],
    ['delivering', 'earnWithdrawStatusDelivering', 'pending'],
    ['received', 'received', 'positive'],
    ['open', 'orderStatusActive', 'pending'],
    ['filled', 'orderStatusFilled', 'positive'],
    ['partiallyFilled', 'orderStatusPartiallyFilled', 'pending'],
    ['partiallyFilledReclaimed', 'orderStatusPartiallyFilledReclaimed', 'neutral'],
    ['loading', 'loading', 'neutral'],
    ['unavailable', 'trackingUnavailable', 'neutral'],
    ['online', 'online', 'positive'],
    ['offline', 'guardianOfflineLabel', 'negative'],
    ['needsAttention', 'guardianNeedsAttentionLabel', 'negative'],
    ['checking', 'guardianCheckingLabel', 'neutral'],
    ['notConnected', 'guardianNotConnectedLabel', 'neutral']
  ] as const)('%s reads "%s" in the %s tone', (status, labelKey, tone) => {
    render(<StatusBadge status={status} data-testid="badge" />);
    const badge = screen.getByTestId('badge');

    expect(badge).toHaveTextContent(`t:${labelKey}`);
    expect(badge).toHaveClass(...TONE_CLASSES[tone]);
    // The word is the accessible name; the dot is decoration.
    expect(dotOf(badge)).toHaveClass('h-1.5', 'w-1.5', 'rounded-full', 'bg-current');
  });

  it('covers every status in the table above', () => {
    expect(STATUSES).toHaveLength(21);
  });

  it.each(STATUSES)('labels %s with a key that exists in the English catalog', status => {
    expect(enMessages).toHaveProperty(STATUS_BADGE[status].labelKey);
  });

  it('never paints bare colored text: every tone sits on a tint or a pressed fill', () => {
    for (const status of STATUSES) {
      const { unmount } = render(<StatusBadge status={status} data-testid="badge" />);
      expect(screen.getByTestId('badge').className).toMatch(
        /\bbg-(positive-tint|pending-tint|negative-tint|fill-pressed)\b/
      );
      unmount();
    }
  });

  describe('sizes', () => {
    it('sm (the default) is the 20px row badge with 12px semibold text', () => {
      render(<StatusBadge status="confirmed" data-testid="badge" />);
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('h-5', 'px-2', 'gap-1', 'text-xs', 'font-semibold', 'rounded-full');
      expect(badge).not.toHaveClass('font-bold');
    });

    it('md is the 24px detail-header pill', () => {
      render(<StatusBadge status="confirmed" size="md" data-testid="badge" />);
      const badge = screen.getByTestId('badge');
      expect(badge).toHaveClass('h-6', 'px-2', 'gap-1', 'text-xs', 'font-bold', 'rounded-full');
      expect(badge).not.toHaveClass('h-5');
    });
  });

  describe('pending pulse', () => {
    it.each(STATUSES.filter(status => STATUS_BADGE[status].tone === 'pending'))(
      'pulses the %s dot when motion is allowed',
      status => {
        render(<StatusBadge status={status} data-testid="badge" />);
        expect(dotOf(screen.getByTestId('badge'))).toHaveAttribute('data-pulsing', 'true');
      }
    );

    it('holds the pending dot still under reduced motion', () => {
      mockReduceMotion = true;
      render(<StatusBadge status="pending" data-testid="badge" />);
      expect(dotOf(screen.getByTestId('badge'))).toHaveAttribute('data-pulsing', 'false');
    });

    it.each(STATUSES.filter(status => STATUS_BADGE[status].tone !== 'pending'))('never pulses %s', status => {
      render(<StatusBadge status={status} data-testid="badge" />);
      expect(dotOf(screen.getByTestId('badge'))).not.toHaveAttribute('data-pulsing');
    });
  });

  describe('live', () => {
    it('is a polite live region only when asked', () => {
      const { rerender } = render(<StatusBadge status="pending" data-testid="badge" />);
      expect(screen.queryByRole('status')).toBeNull();

      rerender(<StatusBadge status="pending" live data-testid="badge" />);
      const region = screen.getByRole('status');
      expect(region).toBe(screen.getByTestId('badge'));
      expect(region).toHaveTextContent('t:pending');
    });
  });

  it('takes layout classes from the caller', () => {
    render(<StatusBadge status="failed" className="mt-2" data-testid="badge" />);
    expect(screen.getByTestId('badge')).toHaveClass('mt-2', 'bg-negative-tint');
  });
});
