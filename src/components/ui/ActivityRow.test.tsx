import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import ActivityRowDefault, { ActivityRow } from './ActivityRow';

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
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
