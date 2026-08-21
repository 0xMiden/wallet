import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import ActivityRowDefault, { ActivityRow } from './ActivityRow';

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

const baseStatus = { label: 'Confirmed', tone: 'confirmed' as const };

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
    // default iconBg = 'bg-gray-50'
    expect(container.querySelector('.bg-gray-50')).not.toBeNull();
  });

  it('applies a custom iconBg and outer className', () => {
    const { container } = renderRow({ iconBg: 'bg-receive-green', className: 'my-extra-class' });

    expect(container.querySelector('.bg-receive-green')).not.toBeNull();
    expect(container.querySelector('.bg-gray-50')).toBeNull();
    expect(container.querySelector('.my-extra-class')).not.toBeNull();
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
    expect(screen.getByText('Confirmed')).toBeTruthy();
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
      expect(screen.getByText('+5').className).toContain('text-status-positive');
    });

    it('applies the negative amount color', () => {
      renderRow({ amount: { value: '-5', direction: 'negative' } });
      expect(screen.getByText('-5').className).toContain('text-status-negative');
    });

    it('applies the explicit neutral amount color', () => {
      renderRow({ amount: { value: '5', direction: 'neutral' } });
      expect(screen.getByText('5').className).toContain('text-text-primary-token');
    });

    it('defaults to the neutral amount color when direction is undefined', () => {
      renderRow({ amount: { value: '7' } });
      expect(screen.getByText('7').className).toContain('text-text-primary-token');
    });
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
      expect(screen.getByText('+1').className).toContain('text-status-positive');
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
  });

  describe('status tone styling', () => {
    it.each([
      ['confirmed', 'bg-status-positive', 'text-status-positive'],
      ['pending', 'bg-status-pending', 'text-status-pending'],
      ['failed', 'bg-status-negative', 'text-status-negative']
    ] as const)('renders the %s tone dot and text classes', (tone, dotClass, textClass) => {
      const { container } = renderRow({ status: { label: tone, tone } });

      expect(container.querySelector(`.${dotClass}`)).not.toBeNull();
      // status label span carries the text tone class
      expect(screen.getByText(tone).className).toContain(textClass);
    });

    it('greys out a cancelled row', () => {
      const { container } = renderRow({ status: { label: 'Cancelled', tone: 'cancelled' } });

      expect(container.querySelector('.bg-gray-400')).not.toBeNull();
      expect(screen.getByText('Cancelled').className).toContain('text-gray-500');
    });

    it('omits the status line entirely when no status is passed', () => {
      render(<ActivityRow icon={<svg />} title="Sent MIDEN" />);

      expect(screen.queryByText('Confirmed')).toBeNull();
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
