import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { springs } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';

import BottomNavDefault, { BottomNav, BottomNavItem } from './BottomNav';

let mockReduce = false;

// framer-motion: motion.* render as plain elements that surface what framer would receive — the
// highlight's shared layoutId and transition, a tab's press scale, the icon's pop target — and
// route `onAnimationComplete` to transitionend so a test can finish the pop's rise.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const make = (tag: string) =>
    ReactActual.forwardRef(
      (
        { layoutId, transition, initial, animate, exit, whileTap, onAnimationComplete, children, ...props }: any,
        ref: React.Ref<HTMLElement>
      ) =>
        ReactActual.createElement(
          tag,
          {
            ref,
            'data-layout-id': layoutId,
            'data-transition': JSON.stringify(transition),
            'data-animate': JSON.stringify(animate),
            'data-while-tap': JSON.stringify(whileTap),
            onTransitionEnd: onAnimationComplete,
            ...props
          },
          children
        )
    );
  return {
    ...jest.requireActual('framer-motion'),
    motion: { div: make('div'), span: make('span'), button: make('button') },
    useReducedMotion: () => mockReduce
  };
});

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn() }));

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
const pillIn = (tab: HTMLElement) => tab.querySelector('[data-slot="motion-highlight"]');
const iconOf = (tab: HTMLElement) => tab.querySelector<HTMLElement>('[data-pop]')!;

beforeEach(() => {
  mockReduce = false;
  jest.mocked(hapticSelection).mockClear();
});

describe('BottomNav — exports & structure', () => {
  it('exposes the same component as the default and named export', () => {
    expect(BottomNavDefault).toBe(BottomNav);
  });

  it('renders a nav with one button per item, each named by its label', () => {
    const { container } = renderNav();

    const nav = container.querySelector('nav')!;
    expect(nav).toHaveClass('flex', 'items-center', 'bg-page');
    expect(screen.getAllByRole('button')).toHaveLength(3);
    for (const label of ['Home', 'Activity', 'Settings']) {
      // Icons only: the label is the button's accessible name, never visible text.
      expect(getTab(label)).toHaveAttribute('aria-label', label);
      expect(getTab(label)).toHaveAttribute('type', 'button');
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('floats as a rounded, shadowed pill by default, on the page surface', () => {
    const { container } = renderNav();

    const nav = container.querySelector('nav')!;
    expect(nav).toHaveClass('rounded-3xl', 'px-2');
    expect(nav.className).toContain('shadow-[');
    expect(nav).not.toHaveClass('border-t');
  });

  it('docks edge to edge with a hairline top rule and the safe-area padding when `docked`', () => {
    const { container } = renderNav({ docked: true });

    const nav = container.querySelector('nav')!;
    expect(nav).toHaveClass('w-full', 'border-t', 'border-hairline', 'bg-page');
    expect(nav.className).toContain('pb-[max(0.5rem,calc(var(--app-safe-bottom');
    expect(nav).not.toHaveClass('rounded-3xl');
    expect(nav.className).not.toContain('shadow-');
  });

  it('appends a caller-supplied className to the nav container', () => {
    const { container } = renderNav({ className: 'my-extra-class' });

    expect(container.querySelector('nav')).toHaveClass('my-extra-class', 'bg-page');
  });

  it('renders an empty nav when there are no items', () => {
    const { container } = render(<BottomNav items={[]} activeId="none" onChange={jest.fn()} />);

    expect(container.querySelector('nav')).not.toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('BottomNav — sizing shared with the action bar', () => {
  it('gives every tab a 64px-tall hit area and a 24px icon', () => {
    renderNav();

    for (const label of ['Home', 'Activity', 'Settings']) {
      expect(getTab(label)).toHaveClass('h-16', 'w-15', 'shrink-0');
      expect(iconOf(getTab(label))).toHaveClass('size-6', '[&>svg]:size-6');
    }
  });

  it('draws the highlight as a fully round 48px pill on the fill surface', () => {
    renderNav();

    const pill = pillIn(getTab('Home'))!;
    // 64px tab minus inset-y-2 (8px) top and bottom = 48px; 60px minus inset-x-0.5 = 56px.
    expect(pill).toHaveClass('inset-y-2', 'inset-x-0.5', 'rounded-full', 'bg-fill');
    expect(pill).toHaveStyle({ position: 'absolute' });
  });
});

describe('BottomNav — active vs inactive rendering', () => {
  it('marks the active tab with aria-current="page" and leaves the others unset', () => {
    renderNav({ activeId: 'activity' });

    expect(getTab('Activity')).toHaveAttribute('aria-current', 'page');
    expect(getTab('Home')).not.toHaveAttribute('aria-current');
    expect(getTab('Settings')).not.toHaveAttribute('aria-current');
    // The Highlight primitive leaves ARIA to the tab: no aria-selected on a nav link.
    expect(getTab('Activity')).not.toHaveAttribute('aria-selected');
  });

  it('inks the active icon and mutes the rest', () => {
    renderNav({ activeId: 'home' });

    expect(getTab('Home')).toHaveClass('text-ink');
    expect(getTab('Home')).not.toHaveClass('text-muted');
    expect(getTab('Settings')).toHaveClass('text-muted');
    expect(getTab('Settings')).not.toHaveClass('text-ink');
  });

  it('renders the highlight under the active tab only, on one shared layoutId', () => {
    const { rerender } = renderNav({ activeId: 'activity' });

    const pill = pillIn(getTab('Activity'))!;
    expect(pillIn(getTab('Home'))).toBeNull();
    expect(pillIn(getTab('Settings'))).toBeNull();

    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);
    expect(pillIn(getTab('Activity'))).toBeNull();
    expect(pillIn(getTab('Settings'))!.getAttribute('data-layout-id')).toBe(pill.getAttribute('data-layout-id'));
  });
});

describe('BottomNav — motion', () => {
  it('slides the highlight on the bouncy tab-switch spring', () => {
    renderNav();

    expect(JSON.parse(pillIn(getTab('Home'))!.getAttribute('data-transition')!)).toEqual(springs.tabSwitch);
  });

  it('dips a pressed tab to 0.92', () => {
    renderNav();

    expect(JSON.parse(getTab('Settings').getAttribute('data-while-tap')!)).toEqual({
      scale: 0.92,
      transition: springs.snappy
    });
  });

  it('pops the icon of the tab that becomes active, then brings it back to rest', () => {
    const { rerender } = renderNav({ activeId: 'home' });
    expect(iconOf(getTab('Home'))).toHaveAttribute('data-pop', 'rest');

    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);

    const icon = iconOf(getTab('Settings'));
    expect(icon).toHaveAttribute('data-pop', 'pop');
    expect(JSON.parse(icon.getAttribute('data-animate')!)).toEqual({ scale: 1.12 });
    expect(iconOf(getTab('Home'))).toHaveAttribute('data-pop', 'rest');

    act(() => {
      fireEvent.transitionEnd(icon);
    });
    expect(iconOf(getTab('Settings'))).toHaveAttribute('data-pop', 'rest');
    expect(JSON.parse(iconOf(getTab('Settings')).getAttribute('data-animate')!)).toEqual({ scale: 1 });
  });

  it('under reduced motion: moves the highlight instantly, never pops, never scales a press', () => {
    mockReduce = true;
    const { rerender } = renderNav({ activeId: 'home' });

    expect(JSON.parse(pillIn(getTab('Home'))!.getAttribute('data-transition')!)).toEqual({ duration: 0.001 });
    expect(getTab('Home')).not.toHaveAttribute('data-while-tap');

    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);
    expect(iconOf(getTab('Settings'))).toHaveAttribute('data-pop', 'rest');
  });
});

describe('BottomNav — icon vs iconActive selection', () => {
  it('renders iconActive on the active tab when the item provides one', () => {
    renderNav({ activeId: 'activity' });

    expect(screen.getByTestId('icon-activity-active')).toBeTruthy();
    expect(screen.queryByTestId('icon-activity')).toBeNull();
  });

  it('falls back to the base icon on the active tab when no iconActive is provided', () => {
    renderNav({ activeId: 'home' });

    expect(screen.getByTestId('icon-home')).toBeTruthy();
  });

  it('renders the base icon on an inactive tab even when an iconActive exists', () => {
    renderNav({ activeId: 'home' });

    expect(screen.getByTestId('icon-activity')).toBeTruthy();
    expect(screen.queryByTestId('icon-activity-active')).toBeNull();
  });
});

describe('BottomNav — notification dot', () => {
  it('renders the negative-status dot on the icon only for items with showDot set', () => {
    const dotItems: BottomNavItem[] = [
      { id: 'home', label: 'Home', icon: <svg />, showDot: true },
      { id: 'settings', label: 'Settings', icon: <svg />, showDot: false },
      { id: 'activity', label: 'Activity', icon: <svg /> }
    ];
    render(<BottomNav items={dotItems} activeId="home" onChange={jest.fn()} />);

    expect(document.querySelectorAll('.bg-status-negative')).toHaveLength(1);
    const homeDot = iconOf(getTab('Home')).querySelector('.bg-status-negative');
    expect(homeDot).not.toBeNull();
    expect(homeDot).toHaveAttribute('aria-hidden', 'true');
    expect(homeDot).toHaveClass('size-2', 'rounded-full');
    expect(getTab('Settings').querySelector('.bg-status-negative')).toBeNull();
    expect(getTab('Activity').querySelector('.bg-status-negative')).toBeNull();
  });
});

describe('BottomNav — four destinations', () => {
  const fourItems: BottomNavItem[] = [
    { id: 'home', label: 'Home', icon: <svg /> },
    { id: 'explore', label: 'Explore', icon: <svg /> },
    { id: 'activity', label: 'Activity', icon: <svg /> },
    { id: 'settings', label: 'Settings', icon: <svg /> }
  ];

  it('renders every destination, in order, and marks exactly one active', () => {
    render(<BottomNav items={fourItems} activeId="settings" onChange={jest.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['Home', 'Explore', 'Activity', 'Settings']);
    expect(buttons.filter(b => b.hasAttribute('aria-current'))).toEqual([getTab('Settings')]);
  });
});

describe('BottomNav — accessory', () => {
  it('renders the accessory after the tabs, outside every tab', () => {
    const { container } = renderNav({ accessory: <button type="button">Testnet</button> });

    const strip = screen.getByRole('button', { name: 'Testnet' });
    const tabs = ['Home', 'Activity', 'Settings'].map(getTab);
    tabs.forEach(tab => expect(tab).not.toContainElement(strip));
    expect(tabs[2]!.compareDocumentPosition(strip)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Its wrapper is the one that shrinks, so the tabs keep their width.
    expect(strip.parentElement).toHaveClass('min-w-0', 'shrink');
    // It keeps to the row's top 48px, clear of the home indicator's gesture zone.
    expect(strip.parentElement).toHaveClass('self-stretch', 'items-start', 'pt-1');
    expect(strip.parentElement!.parentElement).toBe(container.querySelector('nav'));
  });

  it('collapses the slot when the accessory renders nothing (the strip on mainnet)', () => {
    const Nothing = () => null;
    const { container } = renderNav({ accessory: <Nothing /> });

    const slot = container.querySelector('nav')!.children[1]!;
    expect(slot).toBeEmptyDOMElement();
    expect(slot).toHaveClass('empty:hidden');
  });

  it('renders no accessory slot without one', () => {
    const { container } = renderNav();

    expect(container.querySelector('nav')!.children).toHaveLength(1);
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

    expect(onChange).toHaveBeenCalledWith('home');
  });

  it('leaves the highlight where the owner puts it: a tap alone does not move it', () => {
    renderNav({ activeId: 'home' });

    fireEvent.click(getTab('Settings'));

    expect(pillIn(getTab('Home'))).not.toBeNull();
    expect(pillIn(getTab('Settings'))).toBeNull();
  });

  it('fires no haptic itself — the owner buzzes once for a real switch', () => {
    renderNav({ activeId: 'home' });

    fireEvent.click(getTab('Settings'));

    expect(hapticSelection).not.toHaveBeenCalled();
  });
});
