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

  describe('delta rendering', () => {
    /** The Pill around a figure: its label slot's parent, or null when the figure is not in a pill. */
    const pillAround = (text: string) =>
      screen.getByText(text).closest('[data-slot="pill-label"]')?.parentElement ?? null;

    it('omits the delta when absent', () => {
      renderItem();

      expect(screen.queryByText('+2.5%')).toBeNull();
    });

    it('draws the move as a tinted pill', () => {
      renderItem({ delta: { value: '+2.5%', direction: 'positive' } });

      const pill = pillAround('+2.5%');
      expect(pill).not.toBeNull();
      expect(pill).toHaveClass('h-5', 'text-badge', 'mt-0.5', 'bg-positive-tint', 'text-positive-tint-ink');
      // The pill carries the colour alone: no caption ink around it to argue with its tint.
      expect(pill!.parentElement!.className).not.toMatch(/\btext-/);
    });

    it.each([
      ['negative', '-3.1%', ['bg-negative-tint', 'text-negative-tint-ink']],
      ['neutral', '0.0%', ['bg-fill', 'text-muted']],
      [undefined, '+1.0%', ['bg-positive-tint', 'text-positive-tint-ink']]
    ] as const)('tints the pill by the direction: %s', (direction, value, classes) => {
      renderItem({ delta: { value, direction } });

      expect(pillAround(value)).toHaveClass(...classes);
    });
  });

  it('truncates a long name before it pushes the price or the check out of the row', () => {
    renderItem({ onClick: jest.fn(), selected: true, price: '$2.50', name: 'A very long token name' });

    const nameRow = screen.getByText('A very long token name').parentElement!;
    expect(nameRow).toHaveClass('min-w-0');
    expect(nameRow).not.toHaveClass('shrink-0');
    // The name row sits inside the name+amount stack, which sits inside the leading group; each must
    // be allowed to shrink, or the one above it cannot.
    const stack = nameRow.parentElement!;
    expect(stack).toHaveClass('min-w-0');
    const leading = stack.parentElement!;
    expect(leading).toHaveClass('min-w-0', 'flex-1');
    const trailing = screen.getByText('$2.50').closest('[data-slot="trailing"]');
    expect(trailing).toHaveClass('shrink-0');
  });

  it('truncates a long amount on one line, so it never runs under the price or the check', () => {
    renderItem({ onClick: jest.fn(), selected: true, price: '$2.50', amount: '123456789.12345678 AVERYLONGSYMBOL' });

    expect(screen.getByText('123456789.12345678 AVERYLONGSYMBOL')).toHaveClass('truncate');
  });

  describe('badge rendering', () => {
    it('renders a badge right after the name, outside the truncating name element, in a wrapper that never shrinks', () => {
      renderItem({ name: 'A very long token name', badge: <span data-testid="badge">B</span> });

      const name = screen.getByText('A very long token name');
      const wrapper = screen.getByTestId('badge').parentElement!;
      expect(name).not.toContainElement(wrapper);
      expect(name.nextElementSibling).toBe(wrapper);
      expect(wrapper).toHaveClass('shrink-0');
    });

    it('leaves the name alone in its row when no badge is given', () => {
      renderItem();

      expect(screen.getByText('Miden').parentElement!.children).toHaveLength(1);
    });
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

  it('is hidden from assistive tech, since it has nothing to announce', () => {
    render(<AssetListItemSkeleton data-testid="skeleton-row" />);
    expect(screen.getByTestId('skeleton-row')).toHaveAttribute('aria-hidden', 'true');
  });
});
