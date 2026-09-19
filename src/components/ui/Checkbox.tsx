import React, { KeyboardEvent, ReactNode, useId } from 'react';

import { motion, useReducedMotion } from 'framer-motion';

import { resolveTransition, springs, tabBarMotion, useTabBarMotion } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface CheckboxIndicatorProps {
  checked: boolean;
  /** Layout only. */
  className?: string;
}

/**
 * The 22px box (6px corners) that every checkbox in the wallet draws. Empty it is `page` with a
 * `muted` edge (3:1 on `page` and `fill`); checking fills it with `accent` on a quick spring and draws
 * the check in on the tab-bar spring, and unchecking runs both back. Under reduced motion both are
 * instant. Decorative: the control that owns it carries the role and the state.
 */
export const CheckboxIndicator: React.FC<CheckboxIndicatorProps> = ({ checked, className }) => {
  const reduce = useReducedMotion();
  const fill = resolveTransition(reduce, springs.snappy);
  const draw = resolveTransition(reduce, tabBarMotion.highlight);

  return (
    <span
      aria-hidden="true"
      data-slot="checkbox-indicator"
      data-state={checked ? 'checked' : 'unchecked'}
      className={cn(
        'relative flex size-5.5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-page',
        'ring-[1.5px] ring-muted ring-inset',
        className
      )}
    >
      <motion.span
        data-slot="checkbox-fill"
        className="absolute inset-0 rounded-md bg-accent-primary"
        initial={false}
        animate={{ scale: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
        transition={fill}
      />
      <svg viewBox="0 0 22 22" fill="none" className="relative size-full text-pure-white">
        {/* Drawn rather than a registry icon: the check animates along its own path. */}
        <motion.path
          data-slot="checkbox-check"
          d="M6.5 11.5l3 3 6-6.5"
          stroke="currentColor"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
          transition={draw}
        />
      </svg>
    </span>
  );
};

export interface CheckboxRowProps {
  checked: boolean;
  /** Called with the new state on every toggle, after the selection haptic. */
  onCheckedChange: (checked: boolean) => void;
  /** 16px bold `ink`: the row's accessible name. */
  title: ReactNode;
  /** 13px `muted` under the title: the row's accessible description. */
  description?: ReactNode;
  disabled?: boolean;
  /** Layout only. */
  className?: string;
  'data-testid'?: string;
}

/**
 * A checklist row for a `ListGroup`: the whole row is the checkbox, a `role="checkbox"` button with
 * the box leading, the title and a `muted` description, and a hairline above it inset past the box,
 * like `ListRow`. A tap anywhere on it, Space or Enter toggles it, with the selection haptic and the
 * tab-bar press dip; focus draws an inset `accent` ring.
 */
export const CheckboxRow: React.FC<CheckboxRowProps> = ({
  checked,
  onCheckedChange,
  title,
  description,
  disabled = false,
  className,
  'data-testid': dataTestId
}) => {
  const id = useId();
  const motionTokens = useTabBarMotion();

  const toggle = () => {
    if (disabled) return;
    hapticSelection();
    onCheckedChange(!checked);
  };

  // A button already clicks on Space and Enter; Enter is handled here too so it does not submit a
  // surrounding form.
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    toggle();
  };

  return (
    <motion.button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      disabled={disabled}
      data-testid={dataTestId}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative flex min-h-16 w-full items-start gap-3.5 px-4 py-3.5 text-left select-none',
        'transition-colors duration-150 ease-hover active:bg-fill-pressed motion-reduce:transition-none',
        'outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset',
        'disabled:cursor-default disabled:opacity-50',
        // The hairline above every row but the first, starting after the box, as `ListRow` draws it.
        'before:absolute before:top-0 before:right-0 before:left-[52px] before:h-px before:bg-hairline first:before:hidden',
        className
      )}
    >
      {/* The dip is on the content, not the row, so the row's hairline and focus ring stay put. */}
      <motion.span {...motionTokens.press} className="flex min-w-0 flex-1 items-start gap-3.5">
        <CheckboxIndicator checked={checked} className="mt-px" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span id={`${id}-title`} className="font-heading text-base leading-5 font-bold text-ink">
            {title}
          </span>
          {description && (
            <span id={`${id}-description`} className="font-sans text-[13px] leading-[17px] text-muted">
              {description}
            </span>
          )}
        </span>
      </motion.span>
    </motion.button>
  );
};
