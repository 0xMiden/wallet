import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { PageActiveContext, TabActiveContext } from 'app/layouts/page-active';
import { springs, tabBarMotion, tabBarSwap } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';

import SegmentedActionBarDefault, { SegmentedActionBar, SegmentedActionBarItem } from './SegmentedActionBar';

let mockReduce = false;

// framer-motion: motion.* render as plain elements that surface what framer would receive — the
// segments' `layout`, the pill's shared layoutId and transition, the press scale, the icon's pop
// target and the label's fade — and route `onAnimationComplete` to transitionend so a test can
// finish the pop's rise.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const make = (tag: string) =>
    ReactActual.forwardRef(
      (
        {
          layout,
          layoutId,
          transition,
          initial,
          animate,
          exit,
          whileTap,
          onAnimationComplete,
          children,
          ...props
        }: any,
        ref: React.Ref<HTMLElement>
      ) =>
        ReactActual.createElement(
          tag,
          {
            ref,
            'data-layout': layout === undefined ? undefined : String(layout),
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

const mockHapticSelection = hapticSelection as jest.MockedFunction<typeof hapticSelection>;

const items: SegmentedActionBarItem[] = [
  { id: 'send', label: 'Send', icon: <svg data-testid="icon-send" /> },
  { id: 'receive', label: 'Receive', icon: <svg data-testid="icon-receive" /> },
  { id: 'swap', label: 'Swap', icon: <svg data-testid="icon-swap" /> }
];

const renderBar = (props: Partial<React.ComponentProps<typeof SegmentedActionBar>> = {}) =>
  render(<SegmentedActionBar items={items} activeId="send" onChange={jest.fn()} {...props} />);

const getTab = (label: string) => screen.getByRole('tab', { name: label });
const pillIn = (tab: HTMLElement) => tab.querySelector<HTMLElement>('[data-slot="motion-highlight"]');
const contentOf = (tab: HTMLElement) => tab.querySelector<HTMLElement>('[data-slot="motion-highlight-item"]')!;
const iconOf = (tab: HTMLElement) => tab.querySelector<HTMLElement>('[data-pop]')!;

beforeEach(() => {
  jest.clearAllMocks();
  mockReduce = false;
});

describe('SegmentedActionBar — exports & structure', () => {
  it('exposes the same component as the default and named export', () => {
    expect(SegmentedActionBarDefault).toBe(SegmentedActionBar);
  });

  it("carries a caller's band on the bar itself, over its own rule", () => {
    renderBar({ className: 'bg-action-bar' });
    expect(screen.getByRole('tablist')).toHaveClass('bg-action-bar', 'border-b', 'border-hairline');
  });

  it('renders a tablist with one tab per item, each carrying its icon and aria-label', () => {
    renderBar();

    const tablist = screen.getByRole('tablist');
    // No band of its own (a caller passes one in `className`): snug under the status bar (4px above
    // the 48px segments, 8px below), with a hairline rule on its bottom edge like the bottom nav's top rule.
    expect(tablist).toHaveClass('px-3', 'gap-1', 'pt-1', 'pb-2', 'border-b', 'border-hairline');
    expect(tablist.className).not.toMatch(/(^|\s)bg-/);
    expect(tablist.className).not.toMatch(/(^|\s)(h-\d+|pt-[2-9]|py-)/);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    tabs.forEach(tab => expect(tab).toHaveAttribute('type', 'button'));
    expect(screen.getByTestId('icon-send')).toBeTruthy();
    expect(screen.getByTestId('icon-receive')).toBeTruthy();
    expect(screen.getByTestId('icon-swap')).toBeTruthy();
    expect(getTab('Send')).toBeTruthy();
    expect(getTab('Receive')).toBeTruthy();
    expect(getTab('Swap')).toBeTruthy();
  });

  it('appends a caller-supplied className to the container', () => {
    renderBar({ className: 'my-extra-class' });

    expect(screen.getByRole('tablist')).toHaveClass('my-extra-class', 'flex');
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

    expect(getTab('Receive')).toHaveAttribute('aria-selected', 'true');
    expect(getTab('Send')).toHaveAttribute('aria-selected', 'false');
    expect(getTab('Swap')).toHaveAttribute('aria-selected', 'false');
  });

  it('applies the active layout classes to the selected tab and the fill classes to the rest', () => {
    renderBar({ activeId: 'send' });

    // The floor, not a fixed width: the segment grows to fit a longer label and gives width back
    // when the bar runs out (#1069).
    expect(getTab('Send')).toHaveClass('min-w-28', 'max-[359px]:min-w-24', 'flex-initial', 'px-2.5', 'h-12');
    expect(getTab('Send')).not.toHaveClass('w-28');
    expect(getTab('Send')).not.toHaveClass('max-[359px]:w-24');
    expect(getTab('Send')).not.toHaveClass('flex-none');
    expect(contentOf(getTab('Send'))).toHaveClass('gap-1.5', 'max-[359px]:gap-1');

    // Inactive: stretches to fill the row with no horizontal padding.
    expect(getTab('Receive')).toHaveClass('flex-1', 'px-0');
    expect(getTab('Receive')).not.toHaveClass('w-28');
    // 44px keeps every inactive segment a touch target when the active one grows.
    expect(getTab('Receive')).toHaveClass('min-w-11', 'flex-1');
    expect(getTab('Receive')).not.toHaveClass('min-w-28');
  });

  it('keeps the 20px icon, so a label that fits today keeps its width', () => {
    renderBar();

    expect(iconOf(getTab('Send'))).toHaveClass('h-5', 'w-5');
  });

  it('renders the pill and the label only inside the active tab', () => {
    renderBar({ activeId: 'send' });

    expect(screen.getByText('Send')).toBeTruthy();
    expect(screen.queryByText('Receive')).toBeNull();
    expect(screen.queryByText('Swap')).toBeNull();

    expect(pillIn(getTab('Send'))).not.toBeNull();
    expect(pillIn(getTab('Receive'))).toBeNull();
  });

  it('sets the active tab label in bold and gives an inactive tab no label', () => {
    renderBar({ activeId: 'send' });

    expect(screen.getByText('Send')).toHaveClass('font-bold');
    // A label that still cannot fit ends in an ellipsis; the tab's aria-label keeps it whole.
    expect(screen.getByText('Send')).toHaveClass('min-w-0', 'truncate');
    expect(getTab('Send')).toHaveAttribute('aria-label', 'Send');
    expect(getTab('Receive')).not.toHaveTextContent('Receive');
  });

  it('draws the active pill as a raised, fully round bubble that sinks while pressed', () => {
    renderBar({ activeId: 'send' });

    const activeTab = getTab('Send');
    expect(activeTab).toHaveClass('rounded-full', 'group');
    expect(activeTab.style.borderRadius).toBe('9999px');
    // No clip on the segment, or it would cut the pill's shadow off.
    expect(activeTab).not.toHaveClass('overflow-hidden');

    const pill = pillIn(activeTab)!;
    expect(pill).toHaveClass('inset-0', 'rounded-full', 'bg-raised', 'shadow-raised');
    expect(pill).toHaveClass('group-active:shadow-raised-pressed');
    expect(pill.style.borderRadius).toBe('9999px');
  });

  it('moves the pill and label when a different tab is active, on one shared layoutId', () => {
    const { rerender } = renderBar({ activeId: 'send' });
    const layoutId = pillIn(getTab('Send'))!.getAttribute('data-layout-id');

    rerender(<SegmentedActionBar items={items} activeId="swap" onChange={jest.fn()} />);

    expect(screen.getByText('Swap')).toBeTruthy();
    expect(screen.queryByText('Send')).toBeNull();
    expect(pillIn(getTab('Send'))).toBeNull();
    expect(pillIn(getTab('Swap'))!.getAttribute('data-layout-id')).toBe(layoutId);
  });

  it('scopes the pill to each bar, so two mounted bars never trade pills', () => {
    render(
      <>
        <SegmentedActionBar items={items} activeId="send" onChange={jest.fn()} />
        <SegmentedActionBar items={items} activeId="send" onChange={jest.fn()} />
      </>
    );

    const [first, second] = screen.getAllByRole('tab', { name: 'Send' });
    expect(pillIn(first!)!.getAttribute('data-layout-id')).not.toBe(pillIn(second!)!.getAttribute('data-layout-id'));
  });
});

describe('SegmentedActionBar — motion', () => {
  it('slides the pill and resizes the segments on the one bouncy tab-switch spring', () => {
    renderBar();

    expect(JSON.parse(pillIn(getTab('Send'))!.getAttribute('data-transition')!)).toEqual(springs.tabSwitch);
    expect(getTab('Receive')).toHaveAttribute('data-layout', 'true');
    expect(JSON.parse(getTab('Receive').getAttribute('data-transition')!)).toEqual(springs.tabSwitch);
  });

  it('fades the label in on the named label transition', () => {
    renderBar();

    const label = screen.getByText('Send');
    expect(JSON.parse(label.getAttribute('data-transition')!)).toEqual(tabBarMotion.label);
  });

  it('dips a pressed segment to 0.92', () => {
    renderBar();

    expect(JSON.parse(getTab('Swap').getAttribute('data-while-tap')!)).toEqual({
      scale: 0.92,
      transition: springs.snappy
    });
  });

  it('pops the icon of the segment that becomes active, then brings it back to rest', () => {
    const { rerender } = renderBar({ activeId: 'send' });
    expect(iconOf(getTab('Send'))).toHaveAttribute('data-pop', 'rest');

    rerender(<SegmentedActionBar items={items} activeId="receive" onChange={jest.fn()} />);
    const icon = iconOf(getTab('Receive'));
    expect(icon).toHaveAttribute('data-pop', 'pop');
    expect(JSON.parse(icon.getAttribute('data-animate')!)).toEqual({ scale: 1.12 });

    act(() => {
      fireEvent.transitionEnd(icon);
    });
    expect(iconOf(getTab('Receive'))).toHaveAttribute('data-pop', 'rest');
  });

  it('under reduced motion: the pill and segments move instantly, nothing pops, a press does not scale', () => {
    mockReduce = true;
    const { rerender } = renderBar({ activeId: 'send' });

    expect(JSON.parse(pillIn(getTab('Send'))!.getAttribute('data-transition')!)).toEqual({ duration: 0.001 });
    expect(JSON.parse(getTab('Receive').getAttribute('data-transition')!)).toEqual({ duration: 0.001 });
    expect(getTab('Receive')).not.toHaveAttribute('data-while-tap');

    rerender(<SegmentedActionBar items={items} activeId="receive" onChange={jest.fn()} />);
    expect(iconOf(getTab('Receive'))).toHaveAttribute('data-pop', 'rest');
  });
});

// TabLayout keeps the Home pane mounted, hidden, while another tab shows, and hands the bar its new
// active segment only in the commit that shows it again (#1068).
describe('SegmentedActionBar - shown again after its pane was hidden', () => {
  const bar = (shown: boolean, activeId: string) => (
    <TabActiveContext.Provider value={shown}>
      <SegmentedActionBar items={items} activeId={activeId} onChange={jest.fn()} />
    </TabActiveContext.Provider>
  );

  it('takes its new state at once: no slide, no resize, no fade, no pop', () => {
    const { rerender } = render(bar(true, 'send'));
    rerender(bar(false, 'send'));
    rerender(bar(true, 'receive'));

    const receive = getTab('Receive');
    expect(JSON.parse(pillIn(receive)!.getAttribute('data-transition')!)).toEqual(tabBarSwap);
    for (const label of ['Send', 'Receive', 'Swap']) {
      expect(JSON.parse(getTab(label).getAttribute('data-transition')!)).toEqual(tabBarSwap);
    }
    expect(JSON.parse(screen.getByText('Receive').getAttribute('data-transition')!)).toEqual(tabBarSwap);
    expect(iconOf(receive)).toHaveAttribute('data-pop', 'rest');
    expect(JSON.parse(iconOf(receive).getAttribute('data-transition')!).layout).toEqual(tabBarSwap);
    expect(JSON.parse(getTab('Swap').getAttribute('data-while-tap')!)).toEqual({
      scale: 0.92,
      transition: springs.snappy
    });
  });

  it('animates the next change while it stays shown', () => {
    const { rerender } = render(bar(true, 'send'));
    rerender(bar(false, 'send'));
    rerender(bar(true, 'receive'));
    rerender(bar(true, 'swap'));

    const swap = getTab('Swap');
    expect(JSON.parse(pillIn(swap)!.getAttribute('data-transition')!)).toEqual(springs.tabSwitch);
    expect(JSON.parse(swap.getAttribute('data-transition')!)).toEqual(springs.tabSwitch);
    expect(JSON.parse(screen.getByText('Swap').getAttribute('data-transition')!)).toEqual(tabBarMotion.label);
    expect(iconOf(swap)).toHaveAttribute('data-pop', 'pop');
    expect(JSON.parse(iconOf(swap).getAttribute('data-transition')!).layout).toEqual(springs.tabSwitch);
  });

  // A slide page closing back onto Home (TokenDetail to Send, Earn's withdraw Done to Overview) only
  // flips PageActiveContext, not the tab itself: HomeSwipeContainer's carousel animates that reveal, so
  // the bar must too, instead of reading it as a swap (#1068 design review).
  it('animates normally when a slide page closes back onto Home with a different segment', () => {
    const { rerender } = render(
      <PageActiveContext.Provider value={true}>
        <SegmentedActionBar items={items} activeId="send" onChange={jest.fn()} />
      </PageActiveContext.Provider>
    );
    rerender(
      <PageActiveContext.Provider value={false}>
        <SegmentedActionBar items={items} activeId="send" onChange={jest.fn()} />
      </PageActiveContext.Provider>
    );
    rerender(
      <PageActiveContext.Provider value={true}>
        <SegmentedActionBar items={items} activeId="receive" onChange={jest.fn()} />
      </PageActiveContext.Provider>
    );

    const receive = getTab('Receive');
    expect(JSON.parse(pillIn(receive)!.getAttribute('data-transition')!)).toEqual(springs.tabSwitch);
    expect(JSON.parse(receive.getAttribute('data-transition')!)).toEqual(springs.tabSwitch);
    expect(iconOf(receive)).toHaveAttribute('data-pop', 'pop');
  });
});

describe('SegmentedActionBar — selection behaviour and haptics', () => {
  it('buzzes once and calls onChange with the id when an inactive tab is clicked', () => {
    const onChange = jest.fn();
    renderBar({ activeId: 'send', onChange });

    fireEvent.click(getTab('Receive'));

    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('receive');
  });

  it('is a no-op when the already-active tab is clicked (no buzz, no change)', () => {
    const onChange = jest.fn();
    renderBar({ activeId: 'send', onChange });

    fireEvent.click(getTab('Send'));

    expect(mockHapticSelection).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('buzzes exactly once per switch: the tap, and not again when the owner moves it there', () => {
    const onChange = jest.fn();
    const { rerender } = renderBar({ activeId: 'send', onChange });

    fireEvent.click(getTab('Swap'));
    rerender(<SegmentedActionBar items={items} activeId="swap" onChange={onChange} />);

    expect(onChange).toHaveBeenCalledWith('swap');
    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
  });

  it('stays silent when a swipe moves the active segment (HomeSwipeContainer buzzes for that)', () => {
    const { rerender } = renderBar({ activeId: 'send' });

    rerender(<SegmentedActionBar items={items} activeId="receive" onChange={jest.fn()} />);

    expect(getTab('Receive')).toHaveAttribute('aria-selected', 'true');
    expect(mockHapticSelection).not.toHaveBeenCalled();
  });

  it('leaves the pill where the owner puts it: a tap alone does not move it', () => {
    renderBar({ activeId: 'send' });

    fireEvent.click(getTab('Swap'));

    expect(pillIn(getTab('Send'))).not.toBeNull();
    expect(pillIn(getTab('Swap'))).toBeNull();
  });
});
