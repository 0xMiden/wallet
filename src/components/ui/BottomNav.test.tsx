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
    // The original floating pill: 8px above and below the 56px tabs, centred, rounded, shadowed.
    expect(nav).toHaveClass('rounded-3xl', 'px-4', 'py-2', 'justify-center');
    expect(nav.className).toContain('shadow-[');
    expect(nav).not.toHaveClass('border-t');
  });

  it('docks edge to edge with a hairline top rule and the safe-area padding when `docked`', () => {
    const { container } = renderNav({ docked: true });

    const nav = container.querySelector('nav')!;
    expect(nav).toHaveClass('w-full', 'border-t', 'border-hairline', 'bg-page');
    // The original docked geometry: 8px above the tabs, and below them the body's safe-area floor
    // minus 16px with an 8px floor (18px on an iPhone: 1 + 8 + 56 + 18 = 83px).
    expect(nav).toHaveClass(
      'pt-2',
      'pb-[max(0.5rem,calc(var(--app-safe-bottom,max(16px,env(safe-area-inset-bottom)))-16px))]'
    );
    expect(nav).not.toHaveClass('rounded-3xl');
    expect(nav.className).not.toContain('shadow-');
  });

  it('pads a docked bar by the whole inset plus 8px with `clearInset`, so the tabs end above the system bar', () => {
    const { container } = renderNav({ docked: true, clearInset: true });

    const nav = container.querySelector('nav')!;
    expect(nav).toHaveClass('w-full', 'border-t', 'pt-2', 'pb-[calc(env(safe-area-inset-bottom)+0.5rem)]');
    expect(nav.className).not.toContain('-16px');
  });

  it('ignores `clearInset` on the floating pill, which never meets the inset', () => {
    const { container } = renderNav({ clearInset: true });

    const nav = container.querySelector('nav')!;
    expect(nav).toHaveClass('rounded-3xl', 'py-2');
    expect(nav.className).not.toContain('safe-area-inset-bottom');
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
  it('keeps the original 80 x 56 tab (a 72 x 48 pill plus 4px) with a 24px icon', () => {
    renderNav();

    for (const label of ['Home', 'Activity', 'Settings']) {
      expect(getTab(label)).toHaveClass('h-14', 'w-20', 'p-1', 'group');
      expect(iconOf(getTab(label))).toHaveClass('size-6', '[&>svg]:size-6');
    }
  });

  it('draws the highlight as a raised 72 x 48 bubble that sinks while pressed', () => {
    renderNav();

    const pill = pillIn(getTab('Home'))!;
    // 80 x 56 tab minus inset-1 (4px) all round = 72 x 48.
    expect(pill).toHaveClass('inset-1', 'rounded-full', 'bg-raised', 'shadow-raised');
    expect(pill).toHaveClass('group-active:shadow-raised-pressed');
    expect(pill).not.toHaveClass('bg-fill');
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

  it('paints the active icon in the accent and mutes the rest', () => {
    renderNav({ activeId: 'home' });

    expect(getTab('Home')).toHaveClass('text-accent-primary');
    expect(getTab('Home')).not.toHaveClass('text-muted');
    expect(getTab('Settings')).toHaveClass('text-muted');
    expect(getTab('Settings')).not.toHaveClass('text-accent-primary');
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

describe('BottomNav — unread indicator', () => {
  const dotItems: BottomNavItem[] = [
    { id: 'home', label: 'Home', icon: <svg />, unread: { label: 'Unread' } },
    { id: 'settings', label: 'Settings', icon: <svg /> },
    { id: 'activity', label: 'Activity', icon: <svg /> }
  ];

  it('renders the notification dot on the icon only for an unread item', () => {
    render(<BottomNav items={dotItems} activeId="home" onChange={jest.fn()} />);

    const dots = screen.getAllByTestId('bottom-nav-unread');
    expect(dots).toHaveLength(1);
    // The design system's own notification token, not the error red.
    expect(dots[0]).toHaveClass('bg-notification', 'size-2', 'rounded-full');
    expect(iconOf(getTab('Home, Unread')).contains(dots[0]!)).toBe(true);
  });

  it('announces the tab as unread instead of leaving the dot as colour alone', () => {
    render(<BottomNav items={dotItems} activeId="home" onChange={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'Home, Unread' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });

  it('pulses the unread icon and leaves the read ones still', () => {
    render(<BottomNav items={dotItems} activeId="settings" onChange={jest.fn()} />);

    const glyphOf = (tab: HTMLElement) => iconOf(tab).querySelector('[data-animate]');
    expect(glyphOf(getTab('Home, Unread'))).toHaveAttribute('data-animate', JSON.stringify({ scale: [1, 1.06, 1] }));
    expect(glyphOf(getTab('Settings'))).toBeNull();
  });

  it('does not run the pulse under reduced motion', () => {
    mockReduce = true;
    render(<BottomNav items={dotItems} activeId="settings" onChange={jest.fn()} />);

    // The dot is still there — only the motion is dropped.
    expect(screen.getAllByTestId('bottom-nav-unread')).toHaveLength(1);
    expect(iconOf(getTab('Home, Unread')).querySelector('[data-animate]')).toBeNull();
  });

  it('leaves no indicator, and nothing looping, once the item is read', () => {
    render(<BottomNav items={[{ id: 'home', label: 'Home', icon: <svg /> }]} activeId="home" onChange={jest.fn()} />);

    expect(screen.queryByTestId('bottom-nav-unread')).toBeNull();
    expect(iconOf(getTab('Home')).querySelector('[data-animate]')).toBeNull();
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

describe('BottomNav — corner overlay', () => {
  it('draws the corner over the bar, clipped to its shape and transparent to taps, taking no layout space', () => {
    const { container } = renderNav({ corner: <button type="button">Testnet</button> });

    const nav = container.querySelector('nav')!;
    const ribbon = screen.getByRole('button', { name: 'Testnet' });
    const box = ribbon.parentElement!;
    expect(nav).toHaveClass('relative');
    expect(box).toHaveAttribute('data-slot', 'bottom-nav-corner');
    expect(box).toHaveClass('pointer-events-none', 'absolute', 'inset-0', 'overflow-hidden', 'rounded-[inherit]');
    // Out of flow: the nav's only in-flow child is still the tab row, so the tabs keep their widths.
    const inFlow = Array.from(nav.children).filter(child => !child.classList.contains('absolute'));
    expect(inFlow).toHaveLength(1);
    expect(inFlow[0]).toHaveClass('flex', 'gap-2');
    ['Home', 'Activity', 'Settings'].map(getTab).forEach(tab => {
      expect(tab).not.toContainElement(ribbon);
      expect(tab).toHaveClass('w-20');
    });
  });

  it('spreads docked tabs across the full width, as without a corner', () => {
    const { container } = renderNav({ docked: true, corner: <span /> });

    expect(container.querySelector('nav')).toHaveClass('px-4');
    expect(container.querySelector('nav')!.firstElementChild).toHaveClass('flex-1', 'justify-around');
  });

  it('keeps every tab tappable with a corner drawn over them', () => {
    const onChange = jest.fn();
    renderNav({ onChange, corner: <button type="button">Testnet</button> });

    fireEvent.click(getTab('Settings'));

    expect(onChange).toHaveBeenCalledWith('settings');
  });

  it('renders no corner box without one', () => {
    const { container } = renderNav();

    expect(container.querySelector('[data-slot="bottom-nav-corner"]')).toBeNull();
    expect(container.querySelector('nav')!.children).toHaveLength(1);
  });

  it('ends the corner at the inset with `clearInset`, so the ribbon sits above the system bar', () => {
    renderNav({ docked: true, clearInset: true, corner: <button type="button">Testnet</button> });

    const box = screen.getByRole('button', { name: 'Testnet' }).parentElement!;
    expect(box).toHaveAttribute('data-slot', 'bottom-nav-corner');
    expect(box).toHaveClass(
      'absolute',
      'inset-x-0',
      'top-0',
      'bottom-[env(safe-area-inset-bottom)]',
      'overflow-hidden'
    );
    expect(box).not.toHaveClass('inset-0');
  });

  it('keeps the corner on the whole docked bar without `clearInset`', () => {
    renderNav({ docked: true, corner: <button type="button">Testnet</button> });

    const box = screen.getByRole('button', { name: 'Testnet' }).parentElement!;
    expect(box).toHaveClass('inset-0');
    expect(box.className).not.toContain('safe-area-inset-bottom');
  });

  it('ignores `clearInset` on the floating pill corner, which never meets the inset', () => {
    renderNav({ clearInset: true, corner: <button type="button">Testnet</button> });

    const box = screen.getByRole('button', { name: 'Testnet' }).parentElement!;
    expect(box).toHaveClass('inset-0');
    expect(box.className).not.toContain('safe-area-inset-bottom');
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
