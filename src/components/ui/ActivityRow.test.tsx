import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import ActivityRowDefault, { ActivityRow } from './ActivityRow';
import { Card } from './Card';

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// i18n: echo the key plus its interpolated values, so the overflow count can be
// asserted as data rather than as whatever copy `andMoreAssets` currently holds.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${Object.values(opts).join(',')}` : key)
  })
}));

const baseStatus = 'confirmed' as const;

const renderRow = (props: Partial<React.ComponentProps<typeof ActivityRow>> = {}) =>
  render(<ActivityRow icon={<svg data-testid="glyph" />} title="Sent MIDEN" status={baseStatus} {...props} />);

describe('ActivityRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports the same component as default and named', () => {
    expect(ActivityRowDefault).toBe(ActivityRow);
  });

  it('renders the icon, title, and default neutral icon background', () => {
    const { container } = renderRow();

    expect(screen.getByTestId('glyph')).toBeTruthy();
    expect(screen.getByText('Sent MIDEN')).toBeTruthy();
    // default iconBg = 'bg-fill'
    expect(container.querySelector('.bg-fill')).not.toBeNull();
  });

  it('renders the icon tile round, not the retired square token', () => {
    const { container } = renderRow();

    expect(container.querySelector('.bg-fill')?.className).toContain('rounded-full');
    expect(container.querySelector('.rounded-10')).toBeNull();
  });

  it('renders the subtitle in the muted token rather than opacity-50', () => {
    render(<ActivityRow icon={<svg />} title="Sent MIDEN" subtitle="to mtst1aqg...940z" status={baseStatus} />);

    const subtitle = screen.getByText('to mtst1aqg...940z');
    expect(subtitle.className).toContain('text-muted');
    expect(subtitle.className).not.toContain('opacity-50');
  });

  it('renders the timestamp in the gray-secondary token, not a raw hex literal', () => {
    render(<ActivityRow icon={<svg />} title="Sent MIDEN" timestamp="Just now" />);

    const timestamp = screen.getByText('Just now');
    expect(timestamp.className).toContain('text-gray-secondary');
    expect(timestamp.className).not.toContain('text-[#8E8E93]');
  });

  it('applies a custom iconBg and outer className', () => {
    const { container } = renderRow({ iconBg: 'bg-receive-green', className: 'my-extra-class' });

    expect(container.querySelector('.bg-receive-green')).not.toBeNull();
    expect(container.querySelector('.bg-fill')).toBeNull();
    expect(container.querySelector('.my-extra-class')).not.toBeNull();
  });

  it('takes a row card surface from Card, whose padding replaces its own', () => {
    render(
      <Card asChild padding="row">
        <ActivityRow icon={<svg />} title="Sent MIDEN" status={baseStatus} testId="row" />
      </Card>
    );

    const row = screen.getByTestId('row');
    expect(row).toHaveClass('bg-fill', 'rounded-2xl', 'px-4', 'py-3');
    expect(row).not.toHaveClass('py-4');
    expect(row.className.split(/\s+/).some(c => /^border(-|$)/.test(c))).toBe(false);
  });

  it('renders the subtitle when provided and omits it when absent', () => {
    const { rerender } = render(
      <ActivityRow icon={<svg />} title="Sent MIDEN" subtitle="to mtst1aqg...940z" status={baseStatus} />
    );
    expect(screen.getByText('to mtst1aqg...940z')).toBeTruthy();

    rerender(<ActivityRow icon={<svg />} title="Sent MIDEN" status={baseStatus} />);
    expect(screen.queryByText('to mtst1aqg...940z')).toBeNull();
  });

  it('omits the amount block entirely when no amount is passed', () => {
    renderRow();
    // No amount span present; only the status label text
    expect(screen.getByText('confirmed')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  describe('amount rendering and formatDisplayAmount', () => {
    it('renders a plain finite amount with a symbol', () => {
      renderRow({ amount: { value: '123.456789', symbol: 'MIDEN', direction: 'neutral' } });

      // ROUND_DOWN to 3 dp
      expect(screen.getByText('123.456')).toBeTruthy();
      // symbol rendered with a leading space
      expect(screen.getByText('MIDEN')).toBeTruthy();
    });

    it('expands precision instead of truncating a small non-zero amount to zero', () => {
      renderRow({ amount: { value: '0.00012345', symbol: 'MIDEN' } });

      expect(screen.getByText('0.00012')).toBeTruthy();
    });

    it('preserves a leading + sign and formats the remainder', () => {
      renderRow({ amount: { value: '+50.5', direction: 'positive' } });

      expect(screen.getByText('+50.5')).toBeTruthy();
    });

    it('returns non-finite values verbatim (sign absent)', () => {
      renderRow({ amount: { value: 'not-a-number' } });

      expect(screen.getByText('not-a-number')).toBeTruthy();
    });

    it('returns non-finite values verbatim even with a leading + sign', () => {
      renderRow({ amount: { value: '+abc' } });

      expect(screen.getByText('+abc')).toBeTruthy();
    });

    it('omits the symbol span when no symbol is provided', () => {
      renderRow({ amount: { value: '10' } });

      expect(screen.getByText('10')).toBeTruthy();
      expect(screen.queryByText('MIDEN')).toBeNull();
    });

    it('applies the positive amount color', () => {
      renderRow({ amount: { value: '+5', direction: 'positive' } });
      expect(screen.getByText('+5').className).toContain('text-positive-ink');
    });

    it('applies the negative amount color', () => {
      renderRow({ amount: { value: '-5', direction: 'negative' } });
      expect(screen.getByText('-5').className).toContain('text-negative-ink');
    });

    it('applies the explicit neutral amount color', () => {
      renderRow({ amount: { value: '5', direction: 'neutral' } });
      expect(screen.getByText('5').className).toContain('text-ink');
    });

    it('defaults to the neutral amount color when direction is undefined', () => {
      renderRow({ amount: { value: '7' } });
      expect(screen.getByText('7').className).toContain('text-ink');
    });

    it.each(['positive', 'negative'] as const)(
      'inks a %s amount with the AA status ink, never the raw status fill (#90BA89 was 2.19:1)',
      direction => {
        renderRow({ amount: { value: '9', direction } });
        const className = screen.getByText('9').className;
        expect(className).toContain(`text-${direction}-ink`);
        expect(className).not.toMatch(/text-status-/);
      }
    );
  });

  // A batch claim reads "+20 A, +10 B" on one line. The line is finite and the
  // claim is not (anyone can send the account notes), so past a couple of assets
  // the amount column starves the title beside it and the rest must collapse.
  describe('batch-claim extra assets', () => {
    const extraOf = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ key: `faucet-${i}`, value: `+${i + 1}`, symbol: `T${i}` }));

    it('renders each extra asset inline after the primary amount, separated and same-coloured', () => {
      renderRow({
        testId: 'row',
        amount: { value: '+20', symbol: 'AAA', direction: 'positive', extra: extraOf(2) }
      });

      const amount = screen.getByTestId('row-amount');
      // One flat line: primary first, then each extra in the given order.
      expect(amount.textContent).toBe('+20 AAA, +1 T0, +2 T1');
      // Extras inherit the primary's direction colour — a claim's secondary
      // assets arrived too, so rendering them neutral would read as "unchanged".
      expect(screen.getByText('+1').className).toContain('text-positive-ink');
      expect(screen.queryByTestId('row-amount-extra-overflow')).toBeNull();
    });

    it('addresses each extra by an indexed test id (two faucets can format identically)', () => {
      // A repeated test id makes `getByTestId` ambiguous, and two faucets CAN
      // produce the same "10 Unknown" text, so index is the only handle.
      renderRow({
        testId: 'row',
        amount: {
          value: '+20',
          symbol: 'AAA',
          extra: [
            { key: 'faucet-b', value: '+10', symbol: 'Unknown' },
            { key: 'faucet-c', value: '+10', symbol: 'Unknown' }
          ]
        }
      });

      expect(screen.getByTestId('row-amount-extra-0').textContent).toBe(', +10 Unknown');
      expect(screen.getByTestId('row-amount-extra-1').textContent).toBe(', +10 Unknown');
    });

    it('caps the inline list at two and counts the remainder', () => {
      renderRow({ testId: 'row', amount: { value: '+20', symbol: 'AAA', extra: extraOf(5) } });

      // First two render; the other three collapse.
      expect(screen.getByTestId('row-amount-extra-0')).toBeInTheDocument();
      expect(screen.getByTestId('row-amount-extra-1')).toBeInTheDocument();
      expect(screen.queryByTestId('row-amount-extra-2')).toBeNull();
      expect(screen.getByTestId('row-amount-extra-overflow').textContent).toBe(', andMoreAssets:3');
    });

    it('renders no separator or overflow when there are no extras', () => {
      renderRow({ testId: 'row', amount: { value: '+20', symbol: 'AAA' } });

      expect(screen.getByTestId('row-amount').textContent).toBe('+20 AAA');
      expect(screen.queryByTestId('row-amount-extra-0')).toBeNull();
      expect(screen.queryByTestId('row-amount-extra-overflow')).toBeNull();
    });

    it('formats each extra value through the shared display formatter', () => {
      renderRow({
        testId: 'row',
        amount: { value: '+20', symbol: 'AAA', extra: [{ key: 'f', value: '+1.23456789', symbol: 'BBB' }] }
      });

      // ROUND_DOWN to 3 dp, exactly like the primary amount.
      expect(screen.getByTestId('row-amount-extra-0').textContent).toBe(', +1.234 BBB');
    });

    // An asset whose decimals never resolved is named without a quantity. The
    // row must not leave the gap where the number would have been.
    it('names an extra with no quantity without a stray space', () => {
      renderRow({
        testId: 'row',
        amount: { value: '+20', symbol: 'AAA', extra: [{ key: 'f', value: '', symbol: 'Unknown' }] }
      });

      expect(screen.getByTestId('row-amount-extra-0').textContent).toBe(', Unknown');
    });

    it('names a primary with no quantity without a stray space', () => {
      renderRow({ testId: 'row', amount: { value: '', symbol: 'Unknown' } });

      expect(screen.getByTestId('row-amount').textContent).toBe('Unknown');
    });
  });

  describe('status badge', () => {
    it.each([
      ['confirmed', 'bg-positive-tint', 'text-positive-tint-ink'],
      ['pending', 'bg-pending-tint', 'text-pending-tint-ink'],
      ['failed', 'bg-negative-tint', 'text-negative-tint-ink'],
      ['cancelled', 'bg-fill-pressed', 'text-ink'],
      ['reclaimed', 'bg-fill-pressed', 'text-ink']
    ] as const)('draws %s as the compact StatusBadge on its own tint', (status, tint, ink) => {
      renderRow({ status, testId: 'row' });

      const badge = screen.getByTestId('row-status');
      expect(badge).toHaveTextContent(status);
      // The 20px `sm` badge, never bare colored text on the row's `fill`.
      expect(badge).toHaveClass('h-5', 'rounded-full', tint, ink);
      expect(badge.className).not.toMatch(/text-status-/);
    });

    it('is not a live region: a list of rows must not announce every change', () => {
      renderRow({ status: 'pending', testId: 'row' });
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('omits the status badge entirely when no status is passed', () => {
      render(<ActivityRow icon={<svg />} title="Sent MIDEN" testId="row" />);

      expect(screen.queryByTestId('row-status')).toBeNull();
    });
  });

  it('renders the timestamp when provided', () => {
    renderRow({ timestamp: '2:14 PM' });
    expect(screen.getByText('2:14 PM')).toBeInTheDocument();
  });

  describe('onClick / interaction', () => {
    it('exposes a button role, fires haptics then onClick when clicked', () => {
      const onClick = jest.fn();
      renderRow({ onClick });

      const button = screen.getByRole('button');
      expect(button.className).toContain('cursor-pointer');

      fireEvent.click(button);

      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('has no button role and does not fire haptics when onClick is absent', () => {
      const { container } = renderRow();

      expect(screen.queryByRole('button')).toBeNull();
      // clicking the row is a no-op
      fireEvent.click(container.firstChild as HTMLElement);
      expect(hapticLight).not.toHaveBeenCalled();
      // the interactive classes are not applied
      expect((container.firstChild as HTMLElement).className).not.toContain('cursor-pointer');
    });
  });
});
