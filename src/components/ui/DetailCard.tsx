import React, { useId } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

import { ReactComponent as ChevronDownIcon } from 'app/icons/v2/chevron-down-lucide.svg';
import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { usePreset } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { outlineSurfaceClassName } from './surfaces';

export interface DetailRowProps {
  label: string;
  /** The value. A long value (an address) wraps instead of truncating. */
  children: React.ReactNode;
  /** Secondary line under the value, e.g. a fee note. */
  sub?: React.ReactNode;
  /**
   * Rendered right after the label — an `InfoHint`, for a row whose explanation is a sentence.
   * A sentence belongs here rather than in `sub`: three wrapped lines under a value push the
   * rows apart and make the card read as prose.
   */
  info?: React.ReactNode;
  /** Inline text action after the value, e.g. "Edit" or "Copy". Always `accent-tint-ink` — the only accent that clears 4.5:1 on `fill` (Rule 6). */
  action?: { label: string; onClick: () => void };
  /** Stack the value under the label, for values too long to sit beside it (e.g. a full address). */
  stacked?: boolean;
  /**
   * Tapping the row opens something (a sheet that changes the value): the whole row is a `button`
   * with the tap haptic and a trailing chevron, like a `ListRow` that navigates. Never with `action`.
   */
  onClick?: () => void;
  className?: string;
  'data-testid'?: string;
}

/** One label/value row of a `DetailCard`. */
export const DetailRow: React.FC<DetailRowProps> = ({
  label,
  children,
  sub,
  info,
  action,
  stacked = false,
  onClick,
  className,
  'data-testid': dataTestId
}) => {
  const content = (
    <>
      <span className={cn('flex shrink-0 items-center gap-0.5 text-body-sm text-muted', !stacked && 'min-w-20')}>
        {label}
        {info}
      </span>
      <div className={cn('flex min-w-0 flex-1 flex-col gap-1', stacked ? 'items-start' : 'items-end text-right')}>
        <div className={cn('flex max-w-full items-center gap-2 text-value text-ink', stacked && 'break-all')}>
          {children}
          {action && (
            <button
              type="button"
              onClick={() => {
                hapticLight();
                action.onClick();
              }}
              className="shrink-0 text-action text-accent-tint-ink"
            >
              {action.label}
            </button>
          )}
          {onClick && <ChevronRightIcon aria-hidden="true" className="-mr-1 h-5 w-5 shrink-0 stroke-muted" />}
        </div>
        {sub && <span className="text-caption text-muted">{sub}</span>}
      </div>
    </>
  );
  const classes = cn('flex gap-x-4 gap-y-1 px-4 py-3', stacked ? 'flex-col' : 'items-start', className);

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={dataTestId}
        onClick={() => {
          hapticLight();
          onClick();
        }}
        className={cn(
          classes,
          'w-full text-left transition-colors active:bg-fill-pressed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset'
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div data-testid={dataTestId} className={classes}>
      {content}
    </div>
  );
};

export interface DetailDisclosureProps {
  /** The row's title, in the label face but `ink`: it is a control, not a label. */
  title: string;
  /**
   * One caption under the title while the rows are hidden: the current state of what is inside,
   * so closing the disclosure never hides a choice the user made ("Public · In 7 days").
   */
  summary?: React.ReactNode;
  /** Draws the summary in `accent-tint-ink` rather than `muted`: a choice that departs from the default. */
  summaryEmphasis?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The `DetailRow`s revealed when open. */
  children: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}

/**
 * A `DetailCard` row that folds a few more rows under it ("Advanced options"): a header `button`
 * with a chevron that turns, `aria-expanded` and `aria-controls` on the region it reveals, and the
 * hidden rows sliding open on the `reveal` preset (instant under reduced motion). The rows inside
 * keep the card's hairlines and gutter; the header's summary keeps the state visible while closed.
 */
export const DetailDisclosure: React.FC<DetailDisclosureProps> = ({
  title,
  summary,
  summaryEmphasis = false,
  open,
  onOpenChange,
  children,
  className,
  'data-testid': dataTestId
}) => {
  const regionId = useId();
  const reveal = usePreset('reveal');
  return (
    <div data-testid={dataTestId} data-open={open} className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        data-testid={dataTestId && `${dataTestId}-toggle`}
        onClick={() => {
          hapticLight();
          onOpenChange(!open);
        }}
        className={cn(
          'flex w-full items-center gap-x-4 px-4 py-3 text-left transition-colors active:bg-fill-pressed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset'
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-label text-ink">{title}</span>
          {!open && summary && (
            <span
              data-testid={dataTestId && `${dataTestId}-summary`}
              className={cn('text-caption', summaryEmphasis ? 'text-accent-tint-ink' : 'text-muted')}
            >
              {summary}
            </span>
          )}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            '-mr-1 h-5 w-5 shrink-0 stroke-muted transition-transform motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="rows"
            id={regionId}
            className="overflow-hidden"
            initial={reveal.initial}
            animate={reveal.animate}
            exit={reveal.exit}
            transition={reveal.transition}
          >
            {/* The same hairlines as the card around it, with one above the first hidden row. */}
            <div className="divide-y divide-hairline border-t border-hairline">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/**
 * A card of label/value rows with hairline dividers between them, 16px radius: on `fill` by default,
 * or with `surface="outline"` on the page with a hairline border, like `Card`'s outline surface.
 */
export const DetailCard: React.FC<{ children: React.ReactNode; surface?: 'fill' | 'outline'; className?: string }> = ({
  children,
  surface = 'fill',
  className
}) => (
  <div
    className={cn(
      'divide-y divide-hairline rounded-2xl',
      surface === 'outline' ? outlineSurfaceClassName : 'bg-fill',
      className
    )}
  >
    {children}
  </div>
);
