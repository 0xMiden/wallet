import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { springKeyframeStops, springs } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';

import BottomNavDefault, { BottomNav, BottomNavItem } from './BottomNav';

let mockReduce = false;

// framer-motion: motion.* render as plain elements that surface what framer would receive (the
// unread pulse is the one framer motion left in the nav). The highlight, the press and the icon pop
// run on Web Animations, recorded by the `animate` stub below.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const make = (tag: string) =>
    ReactActual.forwardRef(({ transition, animate, children, ...props }: any, ref: React.Ref<HTMLElement>) =>
      ReactActual.createElement(
        tag,
        { ref, 'data-transition': JSON.stringify(transition), 'data-animate': JSON.stringify(animate), ...props },
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

interface Played {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: jest.Mock;
}

const played: Played[] = [];
const playedOn = (element: Element | null) => played.filter(entry => entry.element === element);

// jsdom has no DOMMatrixReadOnly; this reads the 2D part of a matrix() or a scale() the way an engine does.
class TestMatrix {
  a = 1;
  b = 0;
  e = 0;
  f = 0;
  constructor(transform: string) {
    const matrix = /matrix\(([^)]+)\)/.exec(transform);
    if (matrix?.[1]) {
      const [a = 1, b = 0, , , e = 0, f = 0] = matrix[1].split(',').map(Number);
      Object.assign(this, { a, b, e, f });
    }
    const scale = /scale\(([^)]+)\)/.exec(transform);
    if (scale?.[1]) this.a = Number(scale[1]);
  }
}

// Layout, which jsdom does not do: the row starts at x = 100, its 64 x 48 tabs sit 68px apart, and the
// bubble draws where its slot is placed plus `bubbleShift` (the part of a slide still running).
const ROW_LEFT = 100;
const TAB_STEP = 68;
let bubbleShift = 0;

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left,
  y: top,
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  toJSON: () => ({})
});
const tabIndex = (el: HTMLElement) =>
  Array.from(el.parentElement?.querySelectorAll<HTMLElement>('button') ?? []).indexOf(el);
const isTab = (el: HTMLElement) => el.tagName === 'BUTTON';
const isBubble = (el: HTMLElement) => el.getAttribute('data-slot') === 'motion-highlight';

beforeEach(() => {
  mockReduce = false;
  bubbleShift = 0;
  played.length = 0;
  jest.mocked(hapticSelection).mockClear();
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', { configurable: true, value: TestMatrix });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = { cancel: jest.fn(), finished: Promise.resolve() };
      played.push({ element: this, keyframes, options, cancel: animation.cancel });
      return animation;
    }
  });
  jest.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    return isTab(this) ? tabIndex(this) * TAB_STEP : 0;
  });
  jest.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(0);
  jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return isTab(this) ? 64 : 0;
  });
  jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return isTab(this) ? 48 : 0;
  });
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (isTab(this)) return rect(ROW_LEFT + tabIndex(this) * TAB_STEP, 0, 64, 48);
    if (isBubble(this)) {
      // The slot's own dip scales the bubble about the slot's centre.
      const slot = this.parentElement?.style;
      const scale = Number(/scale\(([^)]+)\)/.exec(slot?.transform ?? '')?.[1] ?? 1);
      const centre = ROW_LEFT + parseFloat(slot?.left ?? '0') + 28 + bubbleShift;
      return rect(centre - 28 * scale, 24 - 20 * scale, 56 * scale, 40 * scale);
    }
    return rect(0, 0, 0, 0);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, 'animate');
  Reflect.deleteProperty(globalThis, 'DOMMatrixReadOnly');
});

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
const bubbleOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-slot="motion-highlight"]');
const iconOf = (tab: HTMLElement) => tab.querySelector<HTMLElement>(':scope > span')!;

describe('BottomNav — exports & structure', () => {
  it('exposes the same component as the default and named export', () => {
    expect(BottomNavDefault).toBe(BottomNav);
  });

  it('renders a nav with one button per item, each named by its label', () => {
    const { container } = renderNav();

    const nav = container.querySelector('nav')!;
    expect(nav).toHaveClass('flex', 'items-center', 'bg-pure-white/2');
    expect(screen.getAllByRole('button')).toHaveLength(3);
    for (const label of ['Home', 'Activity', 'Settings']) {
      // Icons only: the label is the button's accessible name, never visible text.
      expect(getTab(label)).toHaveAttribute('aria-label', label);
      expect(getTab(label)).toHaveAttribute('type', 'button');
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('floats as a glass capsule: white at 2% over a 6px blur, a white edge, an inner glow and two highlights', () => {
    const { container } = renderNav();

    const nav = container.querySelector('nav')!;
    // 4px of bar around the 48px tabs, centred, fully rounded.
    expect(nav).toHaveClass('rounded-full', 'p-1', 'justify-center', 'overflow-hidden');
    expect(nav).toHaveClass('border', 'border-pure-white/30', 'bg-pure-white/2');
    // Plain filter values, prefixed and not: a composed `backdrop-blur-*` draws no blur on older WebViews.
    expect(nav).toHaveClass('[backdrop-filter:blur(6px)]', '[-webkit-backdrop-filter:blur(6px)]');
    expect(nav).not.toHaveClass('backdrop-blur-[6px]');
    // A thin glow: a larger one fills the 58px bar with white. Dark mode uses much less white.
    expect(nav.className).toContain('inset_0_0_12px_2px_rgba(255,255,255,0.12)');
    expect(nav.className).toContain('inset_0_0_12px_2px_rgba(255,255,255,0.02)');
    expect(nav).toHaveClass('dark:border-pure-white/10', 'dark:before:via-pure-white/25');
    // The top and left highlights never take a tap from a tab.
    expect(nav).toHaveClass('before:h-px', 'before:bg-linear-to-r', 'before:pointer-events-none');
    expect(nav).toHaveClass('after:w-px', 'after:bg-linear-to-b', 'after:pointer-events-none');
    expect(nav).not.toHaveClass('border-t');
  });

  it('never reads the safe-area inset: the owner keeps the pill clear of it', () => {
    const { container } = renderNav();

    expect(container.querySelector('nav')!.className).not.toContain('safe-area-inset-bottom');
  });

  it('appends a caller-supplied className to the nav container', () => {
    const { container } = renderNav({ className: 'my-extra-class' });

    expect(container.querySelector('nav')).toHaveClass('my-extra-class', 'bg-pure-white/2');
  });

  it('renders an empty nav when there are no items', () => {
    const { container } = render(<BottomNav items={[]} activeId="none" onChange={jest.fn()} />);

    expect(container.querySelector('nav')).not.toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('BottomNav — sizing shared with the action bar', () => {
  it('draws a 64 x 48 tab (a 56 x 40 highlight plus 4px) with a 24px icon', () => {
    renderNav();

    for (const label of ['Home', 'Activity', 'Settings']) {
      expect(getTab(label)).toHaveClass('h-12', 'w-16', 'p-1');
      expect(iconOf(getTab(label))).toHaveClass('size-6', '[&>svg]:size-6');
    }
  });

  it('draws one raised bubble in the tab row, at the active tab inset by 4px, under the icons', () => {
    const { container } = renderNav({ activeId: 'activity' });

    const bubble = bubbleOf(container)!;
    expect(container.querySelectorAll('[data-slot="motion-highlight"]')).toHaveLength(1);
    expect(bubble).toHaveClass('rounded-full', 'bg-raised', 'shadow-raised', 'data-[pressed]:shadow-raised-pressed');
    expect(bubble).not.toHaveClass('bg-fill');
    // Outside every tab, positioned in the row: the tabs paint above it.
    expect(bubble.closest('button')).toBeNull();
    const slot = bubble.parentElement!;
    expect(slot).toHaveClass('absolute', 'pointer-events-none');
    expect(slot.parentElement).toHaveClass('relative');
    expect(getTab('Activity')).toHaveClass('relative');
    expect(slot.style).toMatchObject({ left: `${TAB_STEP + 4}px`, top: '4px', width: '56px', height: '40px' });
  });

  it('sinks the bubble while the active tab is held, and only the active tab', () => {
    const { container } = renderNav({ activeId: 'home' });
    const bubble = bubbleOf(container)!;

    fireEvent.pointerDown(getTab('Settings'));
    expect(bubble).not.toHaveAttribute('data-pressed');
    fireEvent.pointerUp(getTab('Settings'));

    fireEvent.pointerDown(getTab('Home'));
    expect(bubble).toHaveAttribute('data-pressed');
    fireEvent.pointerCancel(getTab('Home'));
    expect(bubble).not.toHaveAttribute('data-pressed');
  });
});

describe('BottomNav — active vs inactive rendering', () => {
  it('marks the active tab with aria-current="page" and leaves the others unset', () => {
    renderNav({ activeId: 'activity' });

    expect(getTab('Activity')).toHaveAttribute('aria-current', 'page');
    expect(getTab('Home')).not.toHaveAttribute('aria-current');
    expect(getTab('Settings')).not.toHaveAttribute('aria-current');
    expect(getTab('Activity')).not.toHaveAttribute('aria-selected');
  });

  it('paints the active icon in the accent and mutes the rest', () => {
    renderNav({ activeId: 'home' });

    expect(getTab('Home')).toHaveClass('text-accent-primary');
    expect(getTab('Home')).not.toHaveClass('text-muted');
    expect(getTab('Settings')).toHaveClass('text-muted');
    expect(getTab('Settings')).not.toHaveClass('text-accent-primary');
  });

  it('hides the bubble while no tab is active', () => {
    const { container } = renderNav({ activeId: 'none' });

    expect(bubbleOf(container)!.parentElement).not.toBeVisible();
  });
});

describe('BottomNav — motion', () => {
  it('animates nothing on first render', () => {
    renderNav({ activeId: 'activity' });

    expect(played).toHaveLength(0);
  });

  it('slides the bubble from the old tab to the new one on the tab-switch spring', () => {
    const { container, rerender } = renderNav({ activeId: 'home' });
    const bubble = bubbleOf(container)!;

    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);

    const slides = playedOn(bubble);
    expect(slides).toHaveLength(1);
    // Placed at the new tab, then drawn back over the old one: home's left minus settings' left.
    expect(bubble.parentElement!.style.left).toBe(`${2 * TAB_STEP + 4}px`);
    expect(slides[0]!.keyframes[0]).toMatchObject({ transform: `translate(${-2 * TAB_STEP}px, 0px)`, offset: 0 });
    expect(slides[0]!.keyframes.at(-1)).toMatchObject({ transform: 'none', offset: 1 });
    expect(slides[0]!.options).toEqual({
      duration: springKeyframeStops(springs.tabSwitch, { distance: 2 * TAB_STEP })!.duration,
      easing: 'linear',
      fill: 'none'
    });
  });

  it('leaves a sliding bubble alone when only the items change, as an unread flip does', () => {
    const { container, rerender } = renderNav({ activeId: 'home' });
    const bubble = bubbleOf(container)!;
    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);
    const [slide] = playedOn(bubble);
    bubble.style.transform = 'matrix(1, 0, 0, 1, -40, 0)';
    bubbleShift = -40;
    const flipped = items.map(item => (item.id === 'activity' ? { ...item, unread: { label: 'Unread' } } : item));

    rerender(<BottomNav items={flipped} activeId="settings" onChange={jest.fn()} />);

    expect(playedOn(bubble)).toEqual([slide]);
    expect(slide!.cancel).not.toHaveBeenCalled();
    expect(playedOn(bubble.parentElement)).toHaveLength(0);
    expect(bubble.parentElement!.style.left).toBe(`${2 * TAB_STEP + 4}px`);
  });

  it('catches a running slide where it is drawn and goes on from there', () => {
    const { container, rerender } = renderNav({ activeId: 'home' });
    const bubble = bubbleOf(container)!;
    rerender(<BottomNav items={items} activeId="activity" onChange={jest.fn()} />);

    // Mid-slide: drawn 30px right of the activity tab.
    bubble.style.transform = 'matrix(1, 0, 0, 1, 30, 0)';
    bubbleShift = 30;
    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);

    const slides = playedOn(bubble);
    expect(slides).toHaveLength(2);
    expect(slides[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(slides[1]!.keyframes[0]).toMatchObject({ transform: `translate(${30 - TAB_STEP}px, 0px)` });
  });

  it('dips a pressed tab to 0.92 on the press spring and brings it back on release', () => {
    renderNav();
    const tab = getTab('Settings');

    fireEvent.pointerDown(tab);
    const [dip] = playedOn(tab);
    expect(dip!.keyframes.at(-1)).toMatchObject({ transform: 'scale(0.92)' });
    expect(dip!.options.duration).toBe(springKeyframeStops(springs.snappy, { distance: 8 })!.duration);

    fireEvent.pointerUp(tab);
    const back = playedOn(tab)[1]!;
    expect(dip!.cancel).toHaveBeenCalledTimes(1);
    expect(back.keyframes[0]).toMatchObject({ transform: 'scale(0.92)' });
    expect(back.keyframes.at(-1)).toMatchObject({ transform: 'scale(1)' });
  });

  it('dips the bubble with the active tab, and leaves it still for an inactive one', () => {
    const { container } = renderNav({ activeId: 'home' });
    const slot = bubbleOf(container)!.parentElement;

    fireEvent.pointerDown(getTab('Settings'));
    fireEvent.pointerLeave(getTab('Settings'));
    expect(playedOn(slot)).toHaveLength(0);

    fireEvent.pointerDown(getTab('Home'));
    expect(playedOn(slot)[0]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(0.92)' });
    fireEvent.pointerUp(getTab('Home'));
    expect(playedOn(slot)[1]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(1)' });
  });

  it('dips only on a primary press: a right click leaves the tab and the bubble still', () => {
    const { container } = renderNav({ activeId: 'home' });
    // jsdom has no PointerEvent; a MouseEvent carries the button, and the pointer type is added.
    const rightClick = new MouseEvent('pointerdown', { bubbles: true, button: 2 });
    Object.defineProperty(rightClick, 'pointerType', { value: 'mouse' });

    fireEvent(getTab('Home'), rightClick);

    expect(playedOn(getTab('Home'))).toHaveLength(0);
    expect(playedOn(bubbleOf(container)!.parentElement)).toHaveLength(0);
    expect(bubbleOf(container)).not.toHaveAttribute('data-pressed');
  });

  it('catches a bubble still dipped with its tab where it is drawn, and lets the slot rest', () => {
    const { container, rerender } = renderNav({ activeId: 'home' });
    const bubble = bubbleOf(container)!;
    const slot = bubble.parentElement!;
    fireEvent.pointerDown(getTab('Home'));
    // The dip still on its way back: drawn at 0.95 when the switch lands.
    fireEvent.pointerUp(getTab('Home'));
    slot.style.transform = 'scale(0.95)';

    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);

    const dips = playedOn(slot);
    expect(dips.at(-1)!.cancel).toHaveBeenCalled();
    expect(slot.style.transform).toBe('');
    // The bubble alone carries the drawn scale, from the old tab's centre.
    const [first] = playedOn(bubble)[0]!.keyframes;
    const drawn = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+), ([\d.]+)\)$/.exec(
      String(first!.transform)
    );
    expect(drawn).not.toBeNull();
    expect(Number(drawn![1])).toBeCloseTo(-2 * TAB_STEP);
    expect(Number(drawn![2])).toBeCloseTo(0);
    expect(Number(drawn![3])).toBeCloseTo(0.95);
    expect(Number(drawn![4])).toBeCloseTo(0.95);
  });

  it('dips a tab held down with Enter, and the bubble with the active one', () => {
    const { container } = renderNav({ activeId: 'home' });
    const slot = bubbleOf(container)!.parentElement;

    fireEvent.keyDown(getTab('Settings'), { key: 'Enter' });
    expect(playedOn(getTab('Settings'))[0]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(0.92)' });
    expect(playedOn(slot)).toHaveLength(0);
    fireEvent.keyUp(getTab('Settings'), { key: 'Enter' });
    expect(playedOn(getTab('Settings'))[1]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(1)' });

    fireEvent.keyDown(getTab('Home'), { key: 'Enter' });
    expect(playedOn(slot)[0]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(0.92)' });
    expect(bubbleOf(container)).toHaveAttribute('data-pressed');
    fireEvent.keyUp(getTab('Home'), { key: 'Enter' });
    expect(playedOn(slot)[1]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(1)' });
    expect(bubbleOf(container)).not.toHaveAttribute('data-pressed');
  });

  it('dips the active tab and sinks the bubble while Space is held, ignoring key repeat', () => {
    const { container } = renderNav({ activeId: 'home' });
    const tab = getTab('Home');

    fireEvent.keyDown(tab, { key: ' ' });
    fireEvent.keyDown(tab, { key: ' ', repeat: true });
    expect(playedOn(tab)).toHaveLength(1);
    expect(bubbleOf(container)).toHaveAttribute('data-pressed');

    fireEvent.keyUp(tab, { key: ' ' });
    expect(playedOn(tab)[1]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(1)' });
    expect(bubbleOf(container)).not.toHaveAttribute('data-pressed');
  });

  it('releases a key press when the tab loses focus, and ignores other keys', () => {
    const { container } = renderNav({ activeId: 'home' });
    const tab = getTab('Home');

    fireEvent.keyDown(tab, { key: 'a' });
    expect(playedOn(tab)).toHaveLength(0);

    fireEvent.keyDown(tab, { key: 'Enter' });
    fireEvent.blur(tab);
    expect(playedOn(tab)[1]!.keyframes.at(-1)).toMatchObject({ transform: 'scale(1)' });
    expect(bubbleOf(container)).not.toHaveAttribute('data-pressed');
  });

  it('pops the icon of the tab that becomes active, up to 1.12 and back to rest in one animation', () => {
    const { rerender } = renderNav({ activeId: 'home' });
    expect(played).toHaveLength(0);

    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);

    const pops = playedOn(iconOf(getTab('Settings')));
    expect(pops).toHaveLength(1);
    const transforms = pops[0]!.keyframes.map(k => k.transform);
    expect(transforms[0]).toBe('scale(1)');
    expect(transforms).toContain('scale(1.12)');
    expect(transforms.at(-1)).toBe('scale(1)');
    const offsets = pops[0]!.keyframes.map(k => Number(k.offset));
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets.at(-1)).toBe(1);
    expect(playedOn(iconOf(getTab('Home')))).toHaveLength(0);
  });

  it('under reduced motion: moves the bubble at once, never pops, never scales a press', () => {
    mockReduce = true;
    const { container, rerender } = renderNav({ activeId: 'home' });

    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);
    fireEvent.pointerDown(getTab('Settings'));
    fireEvent.pointerUp(getTab('Settings'));

    expect(played).toHaveLength(0);
    expect(bubbleOf(container)!.parentElement!.style.left).toBe(`${2 * TAB_STEP + 4}px`);
  });

  it('cancels its running animations on unmount', () => {
    const { rerender, unmount } = renderNav({ activeId: 'home' });
    rerender(<BottomNav items={items} activeId="settings" onChange={jest.fn()} />);
    fireEvent.pointerDown(getTab('Settings'));

    unmount();

    expect(played.length).toBeGreaterThan(0);
    for (const entry of played) expect(entry.cancel).toHaveBeenCalled();
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
    const { container } = renderNav({ activeId: 'home' });

    fireEvent.click(getTab('Settings'));

    expect(bubbleOf(container)!.parentElement!.style.left).toBe('4px');
    expect(playedOn(bubbleOf(container))).toHaveLength(0);
  });

  it('fires no haptic itself — the owner buzzes once for a real switch', () => {
    renderNav({ activeId: 'home' });

    fireEvent.click(getTab('Settings'));

    expect(hapticSelection).not.toHaveBeenCalled();
  });
});
