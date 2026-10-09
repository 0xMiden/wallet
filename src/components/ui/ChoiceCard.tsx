import React, { KeyboardEvent, ReactNode, useId, useRef } from 'react';

import { cva } from 'class-variance-authority';
import { motion } from 'framer-motion';

import { useTabBarMotion, useTabIconPop } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { CheckboxIndicator } from './Checkbox';
import { radioGroupKeyTarget } from './radio-group-keys';

/** `data-*` attributes forwarded to an option's `button`, e.g. an E2E hook keyed on its value. */
export type ChoiceCardDataAttributes = Partial<Record<`data-${string}`, string>>;

export interface ChoiceCardItem<T extends string = string> {
  id: T;
  /** `text-row-title` in `ink`. A text title is also the option's accessible name unless `aria-label` is set. */
  title: ReactNode;
  /** The `text-caption` line under the title: a description, or a meta line such as "Operated by X · US". */
  subtitle?: ReactNode;
  /** Leading visual: a 48px logo tile or an icon circle. Anything drawn on the card sits on `page`. */
  leading?: ReactNode;
  /** After the title: a `Pill` ("Current") or a `StatusBadge` ("Offline"). */
  badge?: ReactNode;
  /** Cannot be chosen: out of the tab order, reported unavailable, its leading visual and title dimmed. */
  disabled?: boolean;
  /** The option's name when the title is not text (a wordmark) or the badge carries meaning. */
  'aria-label'?: string;
  'data-testid'?: string;
  data?: ChoiceCardDataAttributes;
}

export interface ChoiceCardGroupProps<T extends string = string> {
  items: readonly ChoiceCardItem<T>[];
  /** The chosen option, or `null` when none is (every option offline, a choice made elsewhere). */
  value: T | null;
  /** Called once per real change: never for a tap on the option that is already chosen. */
  onChange: (id: T) => void;
  /** Called instead of `onChange` when a tap or key activates the option that is already chosen. */
  onReselect?: (id: T) => void;
  /**
   * What the arrow keys and Home/End do. `select` (the default) moves focus and the choice together;
   * `focus` moves focus alone and leaves the choice to a tap, Enter or Space, for a group whose choice
   * acts at once (a sheet that closes on it), so arrowing past an option does not choose it.
   */
  arrowKeys?: 'select' | 'focus';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Layout only (margins). */
  className?: string;
  'data-testid'?: string;
}

const card = cva(
  [
    'group flex h-full w-full min-h-18 items-center gap-3 rounded-2xl bg-fill px-4 py-3 text-left',
    'select-none transition-[background-color,box-shadow] duration-150 ease-hover motion-reduce:transition-none',
    // The selection is the inset ring, so focus draws outside the card instead of fighting it.
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary/30',
    'disabled:cursor-not-allowed'
  ],
  {
    variants: {
      selected: {
        true: 'ring-2 ring-inset ring-accent-primary',
        false: 'hover:bg-fill-pressed active:bg-fill-pressed disabled:hover:bg-fill disabled:active:bg-fill'
      }
    },
    defaultVariants: { selected: false }
  }
);

interface OptionProps<T extends string> {
  item: ChoiceCardItem<T>;
  selected: boolean;
  focusable: boolean;
  onSelect: (id: T) => void;
}

function ChoiceCardOption<T extends string>({ item, selected, focusable, onSelect }: OptionProps<T>) {
  const motionTokens = useTabBarMotion();
  const pop = useTabIconPop(selected);
  const id = useId();
  const titleId = `${id}-title`;
  const badgeId = `${id}-badge`;
  const subtitleId = `${id}-subtitle`;
  // Named by the title alone; the badge and the subtitle describe it, so a reader hears
  // "Gateway, radio, checked" before the meta line rather than one run-on name.
  const describedBy = [item.badge ? badgeId : null, item.subtitle ? subtitleId : null].filter(Boolean).join(' ');

  return (
    <motion.button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={item['aria-label']}
      aria-labelledby={item['aria-label'] ? undefined : titleId}
      aria-describedby={describedBy || undefined}
      tabIndex={focusable ? 0 : -1}
      disabled={item.disabled}
      // The caller's own hooks go on first, so what the GROUP reports cannot be forged: `data-state`
      // is written after them. `data-testid` still falls back to a caller that supplies it only
      // through `data`, rather than being blanked by an undefined prop that shadows the spread.
      {...item.data}
      data-testid={item['data-testid'] ?? item.data?.['data-testid']}
      data-state={selected ? 'checked' : 'unchecked'}
      onClick={() => onSelect(item.id)}
      {...(item.disabled ? {} : motionTokens.press)}
      className={card({ selected })}
    >
      {item.leading && (
        <span aria-hidden="true" className="flex shrink-0 items-center group-disabled:opacity-50">
          {item.leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-start gap-2">
          <span id={titleId} className="min-w-0 flex-1 text-row-title text-ink group-disabled:text-muted">
            {item.title}
          </span>
          {/* Top right of the card, beside the radio mark: a tag, not a header strip. */}
          {item.badge && (
            <span id={badgeId} className="flex shrink-0 items-center gap-1 pt-px">
              {item.badge}
            </span>
          )}
        </span>
        {item.subtitle && (
          <span id={subtitleId} className="text-caption text-muted">
            {item.subtitle}
          </span>
        )}
      </span>
      <motion.span
        aria-hidden="true"
        data-pop={pop.phase}
        animate={pop.animate}
        transition={pop.transition}
        onAnimationComplete={pop.onAnimationComplete}
        className="flex shrink-0"
      >
        <CheckboxIndicator checked={selected} />
      </motion.span>
    </motion.button>
  );
}

/**
 * One choice out of a set of cards (a guardian operator, a recovery method, an import type): each
 * option a flat `fill` card with 16px corners and no border, a leading logo or icon, a `text-row-title` title,
 * a `muted` subtitle, an optional badge and a trailing radio mark.
 *
 * The chosen card takes an inset `accent` ring and the mark fills with a check. Not the raised
 * bubble: raised is for compact toggles, and cards stay flat (design-system.md, "Elevation"). The
 * behaviour is the `SegmentedControl`'s: ChoiceCardGroup and SegmentedControl, which share
 * `radioGroupKeyTarget`, answer the same way:
 * a `radiogroup` of `radio`s, a `value` naming a disabled option reported as no selection, only the
 * chosen (or first choosable) option in the tab order, arrow keys and Home/End moving focus and the
 * choice together (the first arrow landing on the first option with nothing chosen and nothing focused;
 * focus alone under `arrowKeys="focus"`), one selection haptic per real change and none for a tap on the
 * chosen card, a press that dips on the tab-bar spring and a check that pops as it lands. Under reduced
 * motion nothing scales or pops.
 * One split, by design: with every option disabled the twin, disabled as a whole, still shows its
 * value, while a card group with nothing to choose shows nothing chosen.
 */
export function ChoiceCardGroup<T extends string>({
  items,
  value,
  onChange,
  onReselect,
  arrowKeys = 'select',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className,
  'data-testid': dataTestId
}: ChoiceCardGroupProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  // A disabled option can never be the answer, so it is not reported as one: `value` is normalised
  // against the options the user can actually choose, and that one value feeds the check, the tab
  // stop and the keyboard. Reading it raw let a disabled card render `aria-checked` while focus sat
  // on a different card - a selection with no visible reason, reported to assistive tech as the
  // answer.
  const selectedIndex = items.findIndex(item => item.id === value && !item.disabled);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : items.findIndex(item => !item.disabled);

  const select = (id: T) => {
    if (id === value) {
      onReselect?.(id);
      return;
    }
    hapticSelection();
    onChange(id);
  };

  // The options are the grid's own children, one per item and in item order - the group renders
  // nothing else inside it. A divider, a section label or a per-row wrapper would break that, and
  // focus would then land on a different card than the one selected, silently.
  const buttonAt = (index: number): HTMLElement | null => {
    const node = groupRef.current?.children[index];
    return node instanceof HTMLElement ? node : null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;

    const current = enabled.findIndex(({ index }) => buttonAt(index) === document.activeElement);
    // With nothing focused, the origin falls back to the chosen card among the enabled ones, or -1
    // when nothing is chosen either. radio-group-keys.ts owns the no-origin case this falls back to.
    const selectedAmongEnabled = enabled.findIndex(({ item }) => item.id === value);
    const from = current >= 0 ? current : selectedAmongEnabled;
    const to = radioGroupKeyTarget(event.key, enabled.length, from);
    if (to === null) return;

    event.preventDefault();
    const target = enabled[to];
    if (!target) return;
    buttonAt(target.index)?.focus();
    if (arrowKeys === 'select') select(target.item.id);
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-orientation="vertical"
      data-testid={dataTestId}
      onKeyDown={handleKeyDown}
      // One column of equal rows: every card is as tall as the tallest, so a provider with a longer
      // meta line does not leave its neighbours looking shorter.
      className={cn('grid auto-rows-fr grid-cols-1 gap-3', className)}
    >
      {items.map((item, index) => (
        <ChoiceCardOption
          key={item.id}
          item={item}
          selected={index === selectedIndex}
          focusable={index === focusIndex}
          onSelect={select}
        />
      ))}
    </div>
  );
}

export default ChoiceCardGroup;
