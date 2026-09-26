import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import AssetListItemDefault, { AssetListItem, AssetListItemSkeleton } from './AssetListItem';

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

  it('renders the amount in the muted token rather than opacity-50', () => {
    renderItem();

    const amount = screen.getByText('12.5 MIDEN');
    expect(amount.className).toContain('text-muted');
    expect(amount.className).not.toContain('opacity-50');
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

      expect(screen.getByText('+2.5%').className).toContain('text-positive-tint-ink');
    });

    it('defaults to the positive color when direction is undefined', () => {
      renderItem({ delta: { value: '+1.0%' } });

      expect(screen.getByText('+1.0%').className).toContain('text-positive-tint-ink');
    });

    it('applies the negative color for a negative direction', () => {
      renderItem({ delta: { value: '-3.1%', direction: 'negative' } });

      expect(screen.getByText('-3.1%').className).toContain('text-negative-tint-ink');
    });

    it('applies the tertiary color for a neutral direction', () => {
      renderItem({ delta: { value: '0.0%', direction: 'neutral' } });

      expect(screen.getByText('0.0%').className).toContain('text-text-tertiary-token');
    });
  });

  it('truncates a long name before it pushes the price or the check out of the row', () => {
    renderItem({ onClick: jest.fn(), selected: true, price: '$2.50', name: 'A very long token name' });

    const nameColumn = screen.getByText('A very long token name').parentElement!;
    expect(nameColumn).toHaveClass('min-w-0');
    expect(nameColumn).not.toHaveClass('shrink-0');
    const leading = nameColumn.parentElement!;
    expect(leading).toHaveClass('min-w-0', 'flex-1');
    const trailing = screen.getByText('$2.50').closest('[data-slot="trailing"]');
    expect(trailing).toHaveClass('shrink-0');
  });

  it('truncates a long amount on one line, so it never runs under the price or the check', () => {
    renderItem({ onClick: jest.fn(), selected: true, price: '$2.50', amount: '123456789.12345678 AVERYLONGSYMBOL' });

    expect(screen.getByText('123456789.12345678 AVERYLONGSYMBOL')).toHaveClass('truncate');
  });

  describe('selection', () => {
    it('renders no check and reports no pressed state when selected is undefined', () => {
      const { container } = renderItem({ onClick: jest.fn() });

      expect(container.querySelector('[data-slot="check"]')).toBeNull();
      expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed');
    });

    it('renders the round check in the brand accent and reports aria-pressed when selected', () => {
      const { container } = renderItem({ onClick: jest.fn(), selected: true });

      const check = container.querySelector('[data-slot="check"]')!;
      expect(check).toBeTruthy();
      expect(check.className).toContain('bg-accent-primary');
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    });

    it("fills the check with a flow's own colour when an accent is given", () => {
      const { container } = renderItem({ onClick: jest.fn(), selected: true, accent: 'swap' });

      const check = container.querySelector('[data-slot="check"]')!;
      expect(check.className).toContain('bg-accent-swap');
      expect(check.className).not.toContain('bg-accent-primary');
    });

    it('renders no check on an unselected row but still reports the pressed state', () => {
      const { container } = renderItem({ onClick: jest.fn(), selected: false });

      expect(container.querySelector('[data-slot="check"]')).toBeNull();
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('onClick / interaction', () => {
    it('is a native button, fires haptics then onClick when clicked', () => {
      const onClick = jest.fn();
      renderItem({ onClick });

      const button = screen.getByRole('button');
      expect(button.tagName).toBe('BUTTON');
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

describe('AssetListItemSkeleton', () => {
  it('stands in for a row with the row height and no text', () => {
    render(<AssetListItemSkeleton data-testid="skeleton-row" />);
    const row = screen.getByTestId('skeleton-row');
    expect(row).toHaveClass('h-18');
    expect(row).toHaveTextContent('');
  });

  it('draws a round icon block and pulsing bars where the name, amount, price and change go', () => {
    render(<AssetListItemSkeleton data-testid="skeleton-row" />);
    const blocks = screen.getByTestId('skeleton-row').querySelectorAll('[data-slot="skeleton"]');
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toHaveClass('rounded-full', 'w-9', 'h-9');
  });
});
