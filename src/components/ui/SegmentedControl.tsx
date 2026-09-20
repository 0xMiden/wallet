import React, { KeyboardEvent, ReactNode, useEffect, useRef } from 'react';

import { cva } from 'class-variance-authority';
import { motion, useReducedMotion } from 'framer-motion';

import { Highlight, HighlightItem } from 'components/ui/animate/highlight';
import { raisedBubbleClassName } from 'components/ui/animate/raised-bubble';
import { useTabBarMotion, useTabIconPop } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface SegmentedControlItem<T extends string = string> {
  id: T;
  /** Already-translated text, also the item's accessible name. */
  label: string;
  /** Leading glyph, sized by the control. */
  icon?: ReactNode;
  /** A count after the label, e.g. how many rows a filter holds. */
  count?: number;
  disabled?: boolean;
  'data-testid'?: string;
}

/** `sm` is 32px (a dense row: chart timeframes); `md` is 40px (a filter row, a settings choice). */
export type SegmentedControlSize = 'sm' | 'md';

/**
 * `scroll`: items at their natural width in a row that scrolls sideways when it outgrows the
 * screen (filters). `fill`: items share the full width equally (a fixed handful of choices).
 */
export type SegmentedControlLayout = 'scroll' | 'fill';

/**
 * `radiogroup` for a choice that changes what one view shows (a filter, a timeframe, a setting);
 * `tablist` when each item switches to its own panel.
 */
export type SegmentedControlRole = 'radiogroup' | 'tablist';

export interface SegmentedControlProps<T extends string = string> {
  items: readonly SegmentedControlItem<T>[];
  value: T;
  /** Called once per real change: never for a tap on the item that is already selected. */
  onChange: (id: T) => void;
  size?: SegmentedControlSize;
  layout?: SegmentedControlLayout;
  role?: SegmentedControlRole;
  'aria-label'?: string;
  /** Layout only (margins, padding, width); the look is the control's own. */
  className?: string;
  'data-testid'?: string;
}

// No strip behind the items, like the tab bars. 4px above and below leaves room for the raised
// bubble's shadow and the focus ring, which a scrolling row would otherwise clip; 8px between the
// items, because each one is outlined and two hairlines 4px apart read as one seam.
const container = cva('flex items-center gap-2 py-1', {
  variants: {
    layout: {
      scroll: 'overflow-x-auto no-scrollbar',
      fill: 'w-full'
    }
  },
  defaultVariants: { layout: 'scroll' }
});

const segment = cva(
  [
    // `group` drives the bubble's pressed shadow; no overflow clip, or it would cut the shadow off.
    'group flex items-center justify-center rounded-full text-pill whitespace-nowrap',
    'transition-colors duration-200 motion-reduce:transition-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/30',
    'disabled:cursor-default disabled:opacity-50'
  ],
  {
    variants: {
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 px-4'
      },
      layout: {
        scroll: 'shrink-0',
        fill: 'min-w-0 flex-1'
      },
      // Every item is an outlined pill on the page; the selected one hands its outline over to
      // the raised bubble that covers it, keeping the border transparent so the item's width —
      // and so the row — never shifts as the selection moves.
      //
      // `pure-black` on the accent bubble, not white: white measures 3.0:1 there, which rule 6
      // permits only at 19px bold (the CTA), and these labels are 14px. Black is 7.0:1, and the
      // accent is the same colour in both themes, so one label colour serves both.
      active: {
        true: 'border border-transparent text-pure-black',
        false: 'border border-hairline bg-page text-ink'
      }
    },
    defaultVariants: { size: 'md', layout: 'scroll', active: false }
  }
);

const content = cva('flex min-w-0 items-center', {
  variants: {
    size: {
      sm: 'gap-1',
      md: 'gap-1.5'
    }
  },
  defaultVariants: { size: 'md' }
});

const icon = cva('flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full', {
  variants: {
    size: {
      sm: 'size-4',
      md: 'size-5'
    }
  },
  defaultVariants: { size: 'md' }
});

interface SegmentProps<T extends string> {
  item: SegmentedControlItem<T>;
  active: boolean;
  focusable: boolean;
  size: SegmentedControlSize;
  layout: SegmentedControlLayout;
  itemRole: 'radio' | 'tab';
  onSelect: (id: T) => void;
}

/**
 * One item: a button whose content pops when it becomes selected. `HighlightItem` (asChild) clones
 * the button, adds the sliding bubble and wraps the content, so the whole item, bubble included,
 * dips when pressed.
 */
function Segment<T extends string>({ item, active, focusable, size, layout, itemRole, onSelect }: SegmentProps<T>) {
  const motionTokens = useTabBarMotion();
  const pop = useTabIconPop(active);

  return (
    <HighlightItem value={item.id} asChild as="span" className="flex min-w-0 items-center justify-center">
      <motion.button
        type="button"
        role={itemRole}
        aria-checked={itemRole === 'radio' ? active : undefined}
        aria-selected={itemRole === 'tab' ? active : undefined}
        tabIndex={focusable ? 0 : -1}
        disabled={item.disabled}
        data-testid={item['data-testid']}
        onClick={() => onSelect(item.id)}
        {...(item.disabled ? {} : motionTokens.press)}
        className={segment({ size, layout, active })}
      >
        <motion.span
          data-pop={pop.phase}
          animate={pop.animate}
          transition={pop.transition}
          onAnimationComplete={pop.onAnimationComplete}
          className={content({ size })}
        >
          {item.icon && (
            <span aria-hidden="true" className={icon({ size })}>
              {item.icon}
            </span>
          )}
          <span className="min-w-0 truncate">{item.label}</span>
          {/* The count quiets to `muted` beside an `ink` label, but inherits on the accent bubble —
              `muted` on the accent is 1.5:1. */}
          {item.count !== undefined && (
            <span className={cn('tabular-nums', !active && 'text-muted')}>{item.count}</span>
          )}
        </motion.span>
      </motion.button>
    </HighlightItem>
  );
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

/**
 * A single choice out of a few, drawn like the tab bars: no strip behind the items, each one an
 * outlined pill on the page, and the selected one on the bottom nav's raised bubble —
 * `raisedBubbleClassName` and `useTabBarMotion` verbatim, so the shadow, the pressed shadow and
 * the spring it slides on are the bottom bar's, not a copy of them — filled with the brand accent.
 * Its content pops as it lands and a press dips the item. One selection haptic per real change.
 * Under reduced motion the bubble moves instantly, nothing pops and a press does not scale.
 *
 * The label on that bubble is `pure-black` (7.0:1), never white (3.0:1, which rule 6 allows only
 * at 19px bold).
 *
 * Arrow keys (and Home/End) move focus and the selection together, as the ARIA radio group and
 * tab patterns do; only the selected item is in the tab order. In the `scroll` layout the selected
 * item is kept on screen.
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  size = 'md',
  layout = 'scroll',
  role = 'radiogroup',
  'aria-label': ariaLabel,
  className,
  'data-testid': dataTestId
}: SegmentedControlProps<T>) {
  const motionTokens = useTabBarMotion();
  const reduceMotion = useReducedMotion();
  const rowRef = useRef<HTMLDivElement>(null);

  const selectedIndex = items.findIndex(item => item.id === value);
  // The item Tab lands on: the selected one, or the first that can be chosen when none is.
  const focusIndex =
    selectedIndex >= 0 && !items[selectedIndex]?.disabled ? selectedIndex : items.findIndex(item => !item.disabled);

  const select = (id: T) => {
    if (id === value) return;
    hapticSelection();
    onChange(id);
  };

  // The buttons are the row's own children (Highlight's items mode adds no wrapper), in item order.
  const buttonAt = (index: number): HTMLElement | null => {
    const node = rowRef.current?.children[index];
    return node instanceof HTMLElement ? node : null;
  };

  useEffect(() => {
    if (layout !== 'scroll' || selectedIndex < 0) return;
    const node = rowRef.current?.children[selectedIndex];
    if (!(node instanceof HTMLElement)) return;
    node.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });
  }, [layout, selectedIndex, reduceMotion]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;

    const current = enabled.findIndex(({ index }) => buttonAt(index) === document.activeElement);
    const from =
      current >= 0
        ? current
        : Math.max(
            0,
            enabled.findIndex(({ item }) => item.id === value)
          );

    let to: number;
    if (NEXT_KEYS.has(event.key)) to = (from + 1) % enabled.length;
    else if (PREV_KEYS.has(event.key)) to = (from - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = enabled.length - 1;
    else return;

    event.preventDefault();
    const target = enabled[to];
    if (!target) return;
    buttonAt(target.index)?.focus();
    select(target.item.id);
  };

  return (
    <motion.div
      ref={rowRef}
      role={role}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      data-testid={dataTestId}
      // Framer measures the bubble's slide in page coordinates; `layoutScroll` tells it this row
      // scrolls, so a row scrolled sideways does not throw the bubble off its item.
      layoutScroll={layout === 'scroll'}
      onKeyDown={handleKeyDown}
      className={cn(container({ layout }), className)}
    >
      {/* One bubble shared by every item slides to the selected one; its layoutId is scoped to this
          control, so two mounted controls never trade bubbles. Controlled and click-free: `value`
          decides where it sits. `-inset-px` rather than the bottom nav's inset: the bubble is
          absolutely positioned against the item's PADDING box, so it has to reach 1px past it to
          cover the item's border and match the outlined pills beside it edge for edge. The bottom
          nav's bubble in every respect but its fill, which is the brand accent here (Brian,
          simulator review) — shadow, pressed shadow and spring are the shared ones. */}
      <Highlight
        controlledItems
        value={value}
        click={false}
        exitDelay={0}
        transition={motionTokens.highlight}
        className={cn('-inset-px', raisedBubbleClassName, 'bg-accent-primary')}
      >
        {items.map((item, index) => (
          <Segment
            key={item.id}
            item={item}
            active={index === selectedIndex}
            focusable={index === focusIndex}
            size={size}
            layout={layout}
            itemRole={role === 'tablist' ? 'tab' : 'radio'}
            onSelect={select}
          />
        ))}
      </Highlight>
    </motion.div>
  );
}

export default SegmentedControl;
