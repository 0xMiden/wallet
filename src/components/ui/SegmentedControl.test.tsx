import React, { useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { springs } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';

import { SegmentedControl, SegmentedControlItem, SegmentedControlProps } from './SegmentedControl';

let mockReduce = false;

// framer-motion: motion.* render as plain elements that surface what framer would receive — the
// bubble's shared layoutId and transition, the press scale, the content's pop target and the row's
// `layoutScroll` — and route `onAnimationComplete` to transitionend so a test can finish the pop.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const make = (tag: string) =>
    ReactActual.forwardRef(
      (
        {
          layout,
          layoutId,
          layoutScroll,
          transition,
          initial,
          animate,
          exit,
          whileTap,
          onAnimationComplete,
          children,
          ...props
        }: Record<string, unknown> & { children?: React.ReactNode },
        ref: React.Ref<HTMLElement>
      ) =>
        ReactActual.createElement(
          tag,
          {
            ref,
            'data-layout-id': layoutId,
            'data-layout-scroll': layoutScroll === undefined ? undefined : String(layoutScroll),
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

const mockHapticSelection = jest.mocked(hapticSelection);

type Filter = 'all' | 'pending' | 'sent' | 'received';

const items: SegmentedControlItem<Filter>[] = [
  { id: 'all', label: 'All', 'data-testid': 'filter-all' },
  { id: 'pending', label: 'Pending' },
  { id: 'sent', label: 'Sent' },
  { id: 'received', label: 'Received' }
];

const renderControl = (props: Partial<SegmentedControlProps<Filter>> = {}) =>
  render(<SegmentedControl items={items} value="all" onChange={jest.fn()} aria-label="Filters" {...props} />);

/** A controlled owner, so selection follows the control's own onChange like a real caller. */
const Owner: React.FC<{ initial?: Filter; list?: SegmentedControlItem<Filter>[]; onChange?: (id: Filter) => void }> = ({
  initial = 'all',
  list = items,
  onChange
}) => {
  const [value, setValue] = useState<Filter>(initial);
  return (
    <SegmentedControl
      items={list}
      value={value}
      onChange={id => {
        onChange?.(id);
        setValue(id);
      }}
      aria-label="Filters"
    />
  );
};

const getRadio = (name: string) => screen.getByRole('radio', { name });
const bubbleIn = (item: HTMLElement) => item.querySelector<HTMLElement>('[data-slot="motion-highlight"]');
const popOf = (item: HTMLElement) => item.querySelector<HTMLElement>('[data-pop]')!;

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  jest.clearAllMocks();
  mockReduce = false;
  HTMLElement.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

describe('SegmentedControl — structure and semantics', () => {
  it('is a labelled radiogroup of radios by default, aria-checked on the selected one only', () => {
    renderControl({ value: 'sent' });

    const group = screen.getByRole('radiogroup', { name: 'Filters' });
    expect(group).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(getRadio('Sent')).toHaveAttribute('aria-checked', 'true');
    expect(getRadio('All')).toHaveAttribute('aria-checked', 'false');
    expect(getRadio('Sent')).not.toHaveAttribute('aria-selected');
    screen.getAllByRole('radio').forEach(radio => expect(radio).toHaveAttribute('type', 'button'));
  });

  it('keeps item and control test ids', () => {
    renderControl({ 'data-testid': 'filters' });

    expect(screen.getByTestId('filters')).toHaveAttribute('role', 'radiogroup');
    expect(screen.getByTestId('filter-all')).toBe(getRadio('All'));
  });

  it('sits on no strip: the row has no background, only layout classes from the caller', () => {
    renderControl({ className: 'px-4' });

    const group = screen.getByRole('radiogroup');
    expect(group.className).not.toMatch(/(^|\s)bg-/);
    expect(group).toHaveClass('px-4', 'flex', 'py-1');
  });
});

describe('SegmentedControl — the raised bubble', () => {
  it('draws the bubble only in the selected item, raised and sinking while pressed', () => {
    renderControl({ value: 'pending' });

    const selected = getRadio('Pending');
    const bubble = bubbleIn(selected)!;
    expect(bubble).toHaveClass('inset-0', 'rounded-full', 'bg-raised', 'shadow-raised');
    expect(bubble).toHaveClass('group-active:shadow-raised-pressed');
    expect(selected).toHaveClass('group', 'rounded-full', 'text-ink');
    expect(selected).not.toHaveClass('overflow-hidden');

    expect(bubbleIn(getRadio('All'))).toBeNull();
    expect(getRadio('All')).toHaveClass('text-muted');
  });

  it('moves one shared bubble when the value changes, scoped per control', () => {
    const { rerender } = renderControl({ value: 'all' });
    const layoutId = bubbleIn(getRadio('All'))!.getAttribute('data-layout-id');

    rerender(<SegmentedControl items={items} value="sent" onChange={jest.fn()} aria-label="Filters" />);

    expect(bubbleIn(getRadio('All'))).toBeNull();
    expect(bubbleIn(getRadio('Sent'))!.getAttribute('data-layout-id')).toBe(layoutId);
    expect(document.querySelectorAll('[data-slot="motion-highlight"]')).toHaveLength(1);
  });

  it('gives two mounted controls their own bubbles', () => {
    render(
      <>
        <SegmentedControl items={items} value="all" onChange={jest.fn()} />
        <SegmentedControl items={items} value="all" onChange={jest.fn()} />
      </>
    );

    const [first, second] = screen.getAllByRole('radio', { name: 'All' });
    expect(bubbleIn(first!)!.getAttribute('data-layout-id')).not.toBe(
      bubbleIn(second!)!.getAttribute('data-layout-id')
    );
  });
});

describe('SegmentedControl — motion', () => {
  it('slides the bubble on the tab-switch spring and dips a pressed item', () => {
    renderControl();

    expect(JSON.parse(bubbleIn(getRadio('All'))!.getAttribute('data-transition')!)).toEqual(springs.tabSwitch);
    expect(JSON.parse(getRadio('Sent').getAttribute('data-while-tap')!)).toEqual({
      scale: 0.92,
      transition: springs.snappy
    });
  });

  it('pops the content of the item that becomes selected, then brings it back to rest', () => {
    const { rerender } = renderControl({ value: 'all' });
    expect(popOf(getRadio('All'))).toHaveAttribute('data-pop', 'rest');

    rerender(<SegmentedControl items={items} value="received" onChange={jest.fn()} aria-label="Filters" />);
    const content = popOf(getRadio('Received'));
    expect(content).toHaveAttribute('data-pop', 'pop');
    expect(JSON.parse(content.getAttribute('data-animate')!)).toEqual({ scale: 1.12 });

    act(() => {
      fireEvent.transitionEnd(content);
    });
    expect(popOf(getRadio('Received'))).toHaveAttribute('data-pop', 'rest');
  });

  it('under reduced motion: the bubble moves instantly, nothing pops, a press does not scale', () => {
    mockReduce = true;
    const { rerender } = renderControl({ value: 'all' });

    expect(JSON.parse(bubbleIn(getRadio('All'))!.getAttribute('data-transition')!)).toEqual({ duration: 0.001 });
    expect(getRadio('Sent')).not.toHaveAttribute('data-while-tap');

    rerender(<SegmentedControl items={items} value="sent" onChange={jest.fn()} aria-label="Filters" />);
    expect(popOf(getRadio('Sent'))).toHaveAttribute('data-pop', 'rest');
  });
});

describe('SegmentedControl — selection and haptics', () => {
  it('is controlled: a tap reports the id and the selection follows only the value', () => {
    const onChange = jest.fn();
    renderControl({ onChange });

    fireEvent.click(getRadio('Sent'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('sent');
    expect(getRadio('All')).toHaveAttribute('aria-checked', 'true');
    expect(bubbleIn(getRadio('Sent'))).toBeNull();
  });

  it('buzzes once per real change and never on a re-tap', () => {
    const onChange = jest.fn();
    render(<Owner onChange={onChange} />);

    fireEvent.click(getRadio('Sent'));
    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(getRadio('Sent')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(getRadio('Sent'));
    fireEvent.click(getRadio('Sent'));
    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the owner moves the value itself', () => {
    const { rerender } = renderControl({ value: 'all' });

    rerender(<SegmentedControl items={items} value="pending" onChange={jest.fn()} />);

    expect(mockHapticSelection).not.toHaveBeenCalled();
  });

  it('does not select a disabled item', () => {
    const onChange = jest.fn();
    const list: SegmentedControlItem<Filter>[] = [
      ...items.slice(0, 3),
      { id: 'received', label: 'Received', disabled: true }
    ];
    render(<SegmentedControl items={list} value="all" onChange={onChange} />);

    expect(getRadio('Received')).toBeDisabled();
    expect(getRadio('Received')).not.toHaveAttribute('data-while-tap');
    fireEvent.click(getRadio('Received'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SegmentedControl — keyboard', () => {
  it('puts only the selected item in the tab order', () => {
    renderControl({ value: 'sent' });

    expect(getRadio('Sent')).toHaveAttribute('tabindex', '0');
    expect(getRadio('All')).toHaveAttribute('tabindex', '-1');
    expect(getRadio('Received')).toHaveAttribute('tabindex', '-1');
  });

  it('falls back to the first enabled item when the selected one is disabled', () => {
    const list: SegmentedControlItem<Filter>[] = [{ id: 'all', label: 'All', disabled: true }, ...items.slice(1)];
    render(<SegmentedControl items={list} value="all" onChange={jest.fn()} />);

    expect(getRadio('Pending')).toHaveAttribute('tabindex', '0');
  });

  // A value the items do not hold: a stored setting from another build, or a list that shrank. The
  // row must stay reachable by Tab, with nothing selected.
  it('keeps the first item tabbable when the value matches no item', () => {
    render(<SegmentedControl items={items.slice(0, 3)} value={'received' as Filter} onChange={jest.fn()} />);

    expect(getRadio('All')).toHaveAttribute('tabindex', '0');
    expect(screen.getAllByRole('radio').every(radio => radio.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(document.querySelector('[data-slot="motion-highlight"]')).toBeNull();
  });

  it('moves focus and selection with the arrows, wrapping, with one haptic per move', () => {
    const onChange = jest.fn();
    render(<Owner onChange={onChange} />);
    getRadio('All').focus();

    fireEvent.keyDown(getRadio('All'), { key: 'ArrowRight' });
    expect(getRadio('Pending')).toHaveFocus();
    expect(getRadio('Pending')).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(getRadio('Pending'), { key: 'ArrowLeft' });
    fireEvent.keyDown(getRadio('All'), { key: 'ArrowLeft' });
    expect(getRadio('Received')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('received');

    fireEvent.keyDown(getRadio('Received'), { key: 'ArrowDown' });
    expect(getRadio('All')).toHaveFocus();
    expect(mockHapticSelection).toHaveBeenCalledTimes(4);
  });

  it('jumps with Home and End and skips disabled items', () => {
    const list: SegmentedControlItem<Filter>[] = [
      ...items.slice(0, 3),
      { id: 'received', label: 'Received', disabled: true }
    ];
    render(<Owner list={list} />);
    getRadio('All').focus();

    fireEvent.keyDown(getRadio('All'), { key: 'End' });
    expect(getRadio('Sent')).toHaveFocus();
    expect(getRadio('Sent')).toHaveAttribute('aria-checked', 'true');

    // Home from the far end, so the key has somewhere to move: pressed on the item it would land on
    // anyway, the assertion holds with the Home branch deleted.
    fireEvent.keyDown(getRadio('Sent'), { key: 'Home' });
    expect(getRadio('All')).toHaveFocus();
    expect(getRadio('All')).toHaveAttribute('aria-checked', 'true');
  });

  it('ignores other keys and shows a focus ring', () => {
    const onChange = jest.fn();
    renderControl({ onChange });

    fireEvent.keyDown(getRadio('All'), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(getRadio('All')).toHaveClass('focus-visible:ring-2');
  });
});

describe('SegmentedControl — layouts', () => {
  it('scroll (default): natural-width items in a sideways-scrolling row framer knows scrolls', () => {
    renderControl();

    const group = screen.getByRole('radiogroup');
    expect(group).toHaveClass('overflow-x-auto', 'no-scrollbar');
    expect(group).toHaveAttribute('data-layout-scroll', 'true');
    expect(getRadio('All')).toHaveClass('shrink-0');
    expect(getRadio('All')).not.toHaveClass('flex-1');
  });

  it('fill: equal-width items across the full width, no scrolling', () => {
    renderControl({ layout: 'fill' });

    const group = screen.getByRole('radiogroup');
    expect(group).toHaveClass('w-full');
    expect(group).not.toHaveClass('overflow-x-auto');
    expect(group).toHaveAttribute('data-layout-scroll', 'false');
    expect(getRadio('All')).toHaveClass('flex-1', 'min-w-0');
  });

  it('sizes: sm is 32px, md (default) is 40px', () => {
    const { unmount } = renderControl({ size: 'sm' });
    expect(getRadio('All')).toHaveClass('h-8', 'px-3');
    unmount();

    renderControl();
    expect(getRadio('All')).toHaveClass('h-10', 'px-4');
  });

  it('scrolls the selected item into view on a change, but never on mount', () => {
    const { rerender } = renderControl({ value: 'all' });
    // Mounting a page is not a selection change, and this call would scroll the page, not the row.
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

    const scrollSpy = jest.mocked(HTMLElement.prototype.scrollIntoView);
    scrollSpy.mockClear();
    rerender(<SegmentedControl items={items} value="received" onChange={jest.fn()} />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.contexts[0]).toBe(getRadio('Received'));

    mockReduce = true;
    rerender(<SegmentedControl items={items} value="sent" onChange={jest.fn()} />);
    expect(scrollSpy).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
  });

  it('does not scroll in the fill layout', () => {
    renderControl({ layout: 'fill' });

    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
