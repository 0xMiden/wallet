import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import AssetListItemDefault, { AssetListItem } from './AssetListItem';

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

const renderItem = (props: Partial<React.ComponentProps<typeof AssetListItem>> = {}) =>
  render(<AssetListItem icon={<svg data-testid="glyph" />} name="Miden" amount="12.5 MIDEN" {...props} />);

describe('AssetListItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports the same component as default and named', () => {
    expect(AssetListItemDefault).toBe(AssetListItem);
  });

  it('renders the icon, name, and amount', () => {
    renderItem();

    expect(screen.getByTestId('glyph')).toBeTruthy();
    expect(screen.getByText('Miden')).toBeTruthy();
    expect(screen.getByText('12.5 MIDEN')).toBeTruthy();
  });

  it('forwards the data-testid to the root element', () => {
    renderItem({ 'data-testid': 'asset-row' });

    expect(screen.getByTestId('asset-row')).toBeTruthy();
  });

  it('applies a custom className to the root element', () => {
    const { container } = renderItem({ className: 'my-extra-class' });

    expect((container.firstChild as HTMLElement).className).toContain('my-extra-class');
  });

  describe('chart rendering', () => {
    it('renders the chart node when provided', () => {
      renderItem({ chart: <div data-testid="chart" /> });

      expect(screen.getByTestId('chart')).toBeTruthy();
    });

    it('renders no chart node when absent', () => {
      renderItem();

      expect(screen.queryByTestId('chart')).toBeNull();
    });
  });

  describe('price rendering', () => {
    it('renders the price when provided', () => {
      renderItem({ price: '$1.23' });

      expect(screen.getByText('$1.23')).toBeTruthy();
    });

    it('omits the price when absent', () => {
      renderItem();

      expect(screen.queryByText('$1.23')).toBeNull();
    });
  });

  describe('delta rendering and color', () => {
    it('omits the delta when absent', () => {
      renderItem();

      expect(screen.queryByText('+2.5%')).toBeNull();
    });

    it('applies the positive color for an explicit positive direction', () => {
      renderItem({ delta: { value: '+2.5%', direction: 'positive' } });

      expect(screen.getByText('+2.5%').className).toContain('text-status-positive');
    });

    it('defaults to the positive color when direction is undefined', () => {
      renderItem({ delta: { value: '+1.0%' } });

      expect(screen.getByText('+1.0%').className).toContain('text-status-positive');
    });

    it('applies the negative color for a negative direction', () => {
      renderItem({ delta: { value: '-3.1%', direction: 'negative' } });

      expect(screen.getByText('-3.1%').className).toContain('text-status-negative');
    });

    it('applies the tertiary color for a neutral direction', () => {
      renderItem({ delta: { value: '0.0%', direction: 'neutral' } });

      expect(screen.getByText('0.0%').className).toContain('text-text-tertiary-token');
    });
  });

  describe('onClick / interaction', () => {
    it('exposes a button role, fires haptics then onClick when clicked', () => {
      const onClick = jest.fn();
      renderItem({ onClick });

      const button = screen.getByRole('button');
      expect(button.className).toContain('cursor-pointer');

      fireEvent.click(button);

      expect(hapticLight).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('has no button role and does not fire haptics when onClick is absent', () => {
      const { container } = renderItem();

      expect(screen.queryByRole('button')).toBeNull();

      fireEvent.click(container.firstChild as HTMLElement);

      expect(hapticLight).not.toHaveBeenCalled();
      expect((container.firstChild as HTMLElement).className).not.toContain('cursor-pointer');
    });
  });
});
