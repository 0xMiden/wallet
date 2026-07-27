import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';

import SegmentedActionBarDefault, { SegmentedActionBar, SegmentedActionBarItem } from './SegmentedActionBar';

// framer-motion: the two `motion.span`s are (1) the sliding active pill —
// surface its `layoutId` — and (2) the fading label. Both just render plain
// spans; the framer-only props (layoutId/initial/animate/transition) are
// stripped so React does not warn about unknown DOM attributes.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    span: ({ children, layoutId, initial, animate, transition, ...props }: any) => (
      <span data-layout-id={layoutId} {...props}>
        {children}
      </span>
    )
  }
}));

// Native selection buzz — spy so we can assert it fires only on a real change.
jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: jest.fn()
}));

const mockHapticSelection = hapticSelection as jest.MockedFunction<typeof hapticSelection>;

const items: SegmentedActionBarItem[] = [
  { id: 'send', label: 'Send', icon: <svg data-testid="icon-send" /> },
  { id: 'receive', label: 'Receive', icon: <svg data-testid="icon-receive" /> },
  { id: 'swap', label: 'Swap', icon: <svg data-testid="icon-swap" /> }
];

const renderBar = (props: Partial<React.ComponentProps<typeof SegmentedActionBar>> = {}) =>
  render(<SegmentedActionBar items={items} activeId="send" onChange={jest.fn()} {...props} />);

const getTab = (label: string) => screen.getByRole('tab', { name: label });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SegmentedActionBar — exports & structure', () => {
  it('exposes the same component as the default and named export', () => {
    expect(SegmentedActionBarDefault).toBe(SegmentedActionBar);
  });

  it('renders a tablist with one tab per item, each carrying its icon and aria-label', () => {
    renderBar();

    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeTruthy();
    // Base layout classes always present on the container.
    expect(tablist.className).toContain('h-16');
    expect(tablist.className).toContain('bg-gray-25');

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);

    // Every item's icon renders regardless of active state.
    expect(screen.getByTestId('icon-send')).toBeTruthy();
    expect(screen.getByTestId('icon-receive')).toBeTruthy();
    expect(screen.getByTestId('icon-swap')).toBeTruthy();

    // aria-label mirrors the item label on each button.
    expect(getTab('Send')).toBeTruthy();
    expect(getTab('Receive')).toBeTruthy();
    expect(getTab('Swap')).toBeTruthy();

    // Each button is a real submit-safe type="button".
    tabs.forEach(tab => expect(tab.getAttribute('type')).toBe('button'));
  });

  it('appends a caller-supplied className to the container', () => {
    renderBar({ className: 'my-extra-class' });

    const tablist = screen.getByRole('tablist');
    expect(tablist.className).toContain('my-extra-class');
    // Base classes still present alongside the override.
    expect(tablist.className).toContain('flex');
  });

  it('renders nothing but an empty tablist when there are no items', () => {
    render(<SegmentedActionBar items={[]} activeId="none" onChange={jest.fn()} />);

    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

describe('SegmentedActionBar — active vs inactive rendering', () => {
  it('marks the active tab selected and the others unselected', () => {
    renderBar({ activeId: 'receive' });

    expect(getTab('Receive').getAttribute('aria-selected')).toBe('true');
    expect(getTab('Send').getAttribute('aria-selected')).toBe('false');
    expect(getTab('Swap').getAttribute('aria-selected')).toBe('false');
  });

  it('applies the active layout classes to the selected tab and the fill classes to the rest', () => {
    renderBar({ activeId: 'send' });

    // Active: uses a fixed width so long labels cannot collide with adjacent icons.
    expect(getTab('Send').className).toContain('w-28');
    expect(getTab('Send').className).toContain('max-[359px]:w-24');
    expect(getTab('Send').className).toContain('flex-none');
    expect(getTab('Send').className).toContain('gap-1.5');
    expect(getTab('Send').className).toContain('px-2.5');

    // Inactive: stretches to fill the row with no horizontal padding.
    expect(getTab('Receive').className).toContain('flex-1');
    expect(getTab('Receive').className).toContain('px-0');
    expect(getTab('Receive').className).not.toContain('w-28');
  });

  it('renders the pill and the label only inside the active tab', () => {
    renderBar({ activeId: 'send' });

    // The label text appears exactly once — on the active tab.
    expect(screen.getByText('Send')).toBeTruthy();
    // Inactive tabs render their icon but not their label text.
    expect(screen.queryByText('Receive')).toBeNull();
    expect(screen.queryByText('Swap')).toBeNull();

    // The sliding pill (bg-white) lives inside the active tab only.
    const activePill = getTab('Send').querySelector('.bg-white');
    expect(activePill).not.toBeNull();
    expect(getTab('Receive').querySelector('.bg-white')).toBeNull();
  });

  it('moves the pill and label when a different tab is active', () => {
    renderBar({ activeId: 'swap' });

    expect(screen.getByText('Swap')).toBeTruthy();
    expect(screen.queryByText('Send')).toBeNull();
    expect(getTab('Swap').querySelector('.bg-white')).not.toBeNull();
    expect(getTab('Send').querySelector('.bg-white')).toBeNull();
  });
});

describe('SegmentedActionBar — layoutId plumbing', () => {
  it('defaults the pill layoutId to the shared namespace', () => {
    renderBar({ activeId: 'send' });

    const pill = getTab('Send').querySelector('.bg-white');
    expect(pill?.getAttribute('data-layout-id')).toBe('segmented-action-pill');
  });

  it('forwards a caller-provided layoutId override to the pill', () => {
    renderBar({ activeId: 'send', layoutId: 'custom-pill' });

    const pill = getTab('Send').querySelector('.bg-white');
    expect(pill?.getAttribute('data-layout-id')).toBe('custom-pill');
  });
});

describe('SegmentedActionBar — selection behaviour', () => {
  it('buzzes and calls onChange with the id when an inactive tab is clicked', () => {
    const onChange = jest.fn();
    renderBar({ activeId: 'send', onChange });

    fireEvent.click(getTab('Receive'));

    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('receive');
  });

  it('is a no-op when the already-active tab is clicked (early return, no buzz)', () => {
    const onChange = jest.fn();
    renderBar({ activeId: 'send', onChange });

    fireEvent.click(getTab('Send'));

    expect(mockHapticSelection).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the correct id for each distinct inactive tab', () => {
    const onChange = jest.fn();
    renderBar({ activeId: 'send', onChange });

    fireEvent.click(getTab('Swap'));

    expect(onChange).toHaveBeenCalledWith('swap');
    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
  });
});
