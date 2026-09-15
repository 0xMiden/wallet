import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import BottomNavDefault, { BottomNav, BottomNavItem } from './BottomNav';

const items: BottomNavItem[] = [
  { id: 'home', label: 'Home', icon: <svg data-testid="icon-home" /> },
  {
    id: 'activity',
    label: 'Activity',
    icon: <svg data-testid="icon-activity" />,
    iconActive: <svg data-testid="icon-activity-active" />
  },
  { id: 'settings', label: 'Settings', icon: <svg data-testid="icon-settings" /> }
];

const renderNav = (props: Partial<React.ComponentProps<typeof BottomNav>> = {}) =>
  render(<BottomNav items={items} activeId="home" onChange={jest.fn()} {...props} />);

const getTab = (label: string) => screen.getByRole('button', { name: label });

describe('BottomNav — exports & structure', () => {
  it('exposes the same component as the default and named export', () => {
    expect(BottomNavDefault).toBe(BottomNav);
  });

  it('renders a nav with one button per item, each carrying its icon and label', () => {
    const { container } = renderNav();

    const nav = container.querySelector('nav');
    expect(nav).not.toBeNull();
    // Base layout classes always present on the container.
    expect(nav!.className).toContain('flex');
    expect(nav!.className).toContain('bg-white');
    expect(nav!.className).toContain('rounded-3xl');

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);

    // Every item's inactive icon renders by default (home is active but has no iconActive).
    expect(screen.getByTestId('icon-home')).toBeTruthy();
    expect(screen.getByTestId('icon-settings')).toBeTruthy();

    // Labels mirror each item.
    expect(getTab('Home')).toBeTruthy();
    expect(getTab('Activity')).toBeTruthy();
    expect(getTab('Settings')).toBeTruthy();

    // Each button is a real submit-safe type="button".
    buttons.forEach(button => expect(button.getAttribute('type')).toBe('button'));
  });

  it('appends a caller-supplied className to the nav container', () => {
    const { container } = renderNav({ className: 'my-extra-class' });

    const nav = container.querySelector('nav')!;
    expect(nav.className).toContain('my-extra-class');
    // Base classes still present alongside the override.
    expect(nav.className).toContain('justify-center');
  });

  it('renders an empty nav when there are no items', () => {
    const { container } = render(<BottomNav items={[]} activeId="none" onChange={jest.fn()} />);

    expect(container.querySelector('nav')).not.toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('BottomNav — active vs inactive rendering', () => {
  it('marks the active tab with aria-current="page" and leaves the others unset', () => {
    renderNav({ activeId: 'activity' });

    expect(getTab('Activity').getAttribute('aria-current')).toBe('page');
    // Inactive tabs omit the attribute entirely (undefined => not present).
    expect(getTab('Home').hasAttribute('aria-current')).toBe(false);
    expect(getTab('Settings').hasAttribute('aria-current')).toBe(false);
  });

  it('applies the accent color + bold label to the active tab and the neutral pair to the rest', () => {
    renderNav({ activeId: 'home' });

    const active = getTab('Home');
    expect(active.className).toContain('text-accent-primary');
    expect(active.className).not.toContain('text-text-primary-token');
    // Active label is bold.
    expect(screen.getByText('Home').className).toContain('font-bold');
    expect(screen.getByText('Home').className).not.toContain('font-semibold');

    const inactive = getTab('Settings');
    expect(inactive.className).toContain('text-text-primary-token');
    expect(inactive.className).not.toContain('text-accent-primary');
    // Inactive label is semibold.
    expect(screen.getByText('Settings').className).toContain('font-semibold');
    expect(screen.getByText('Settings').className).not.toContain('font-bold');
  });
});

describe('BottomNav — four destinations', () => {
  // The wallet ships four primary destinations (Home, Explore, Activity,
  // Settings) off-extension. The pill's gutter and gap are sized for that.
  const fourItems: BottomNavItem[] = [
    { id: 'home', label: 'Home', icon: <svg data-testid="icon-home" /> },
    { id: 'explore', label: 'Explore', icon: <svg data-testid="icon-explore" /> },
    { id: 'activity', label: 'Activity', icon: <svg data-testid="icon-activity" /> },
    { id: 'settings', label: 'Settings', icon: <svg data-testid="icon-settings" /> }
  ];

  it('renders every destination, in order', () => {
    const { container } = render(<BottomNav items={fourItems} activeId="home" onChange={jest.fn()} />);

    const buttons = Array.from(container.querySelectorAll('nav > button'));
    expect(buttons).toHaveLength(4);
    expect(buttons.map(b => b.textContent)).toEqual(['Home', 'Explore', 'Activity', 'Settings']);
  });

  it('marks exactly one of the four active', () => {
    render(<BottomNav items={fourItems} activeId="settings" onChange={jest.fn()} />);

    expect(getTab('Settings').getAttribute('aria-current')).toBe('page');
    expect(screen.getAllByRole('button').filter(b => b.hasAttribute('aria-current'))).toHaveLength(1);
  });

  it('reports the tapped destination id', () => {
    const onChange = jest.fn();
    render(<BottomNav items={fourItems} activeId="home" onChange={onChange} />);

    fireEvent.click(getTab('Settings'));

    expect(onChange).toHaveBeenCalledWith('settings');
  });
});

describe('BottomNav — icon vs iconActive selection', () => {
  it('renders iconActive on the active tab when the item provides one', () => {
    renderNav({ activeId: 'activity' });

    expect(screen.getByTestId('icon-activity-active')).toBeTruthy();
    // The inactive-state icon is not rendered while active.
    expect(screen.queryByTestId('icon-activity')).toBeNull();
  });

  it('falls back to the base icon on the active tab when no iconActive is provided', () => {
    // Home is active but has no iconActive => uses item.icon.
    renderNav({ activeId: 'home' });

    expect(screen.getByTestId('icon-home')).toBeTruthy();
  });

  it('renders the base icon on an inactive tab even when an iconActive exists', () => {
    // Activity has an iconActive but is inactive here => uses item.icon.
    renderNav({ activeId: 'home' });

    expect(screen.getByTestId('icon-activity')).toBeTruthy();
    expect(screen.queryByTestId('icon-activity-active')).toBeNull();
  });
});

describe('BottomNav — notification dot', () => {
  it('renders the red dot only for items with showDot set', () => {
    const dotItems: BottomNavItem[] = [
      { id: 'home', label: 'Home', icon: <svg />, showDot: true },
      { id: 'settings', label: 'Settings', icon: <svg />, showDot: false },
      { id: 'activity', label: 'Activity', icon: <svg /> }
    ];
    render(<BottomNav items={dotItems} activeId="home" onChange={jest.fn()} />);

    // Exactly one dot in the whole nav — the one on Home.
    const dots = document.querySelectorAll('.bg-red-500');
    expect(dots).toHaveLength(1);

    // It lives inside the Home button and is hidden from the a11y tree.
    const homeDot = getTab('Home').querySelector('.bg-red-500');
    expect(homeDot).not.toBeNull();
    expect(homeDot!.getAttribute('aria-hidden')).toBe('true');

    // No dot on the items that did not opt in.
    expect(getTab('Settings').querySelector('.bg-red-500')).toBeNull();
    expect(getTab('Activity').querySelector('.bg-red-500')).toBeNull();
  });
});

describe('BottomNav — selection behaviour', () => {
  it('calls onChange with the id when an inactive tab is clicked', () => {
    const onChange = jest.fn();
    renderNav({ activeId: 'home', onChange });

    fireEvent.click(getTab('Settings'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('settings');
  });

  it('forwards re-taps on the already-active tab too (owner decides no-op semantics)', () => {
    const onChange = jest.fn();
    renderNav({ activeId: 'home', onChange });

    fireEvent.click(getTab('Home'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('home');
  });

  it('reports the correct id for each distinct tab clicked', () => {
    const onChange = jest.fn();
    renderNav({ activeId: 'home', onChange });

    fireEvent.click(getTab('Activity'));
    expect(onChange).toHaveBeenLastCalledWith('activity');

    fireEvent.click(getTab('Settings'));
    expect(onChange).toHaveBeenLastCalledWith('settings');

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
