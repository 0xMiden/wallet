import React from 'react';

import { cva } from 'class-variance-authority';

import { ReactComponent as CheckIcon } from 'app/icons/v2/checkmark.svg';
import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';
import { Link } from 'lib/woozie';

export interface ListRowProps {
  title: React.ReactNode;
  /** 13px `muted` line under the title. A row with one is 64px tall, 56px without. */
  subtitle?: React.ReactNode;
  /** Leading 40px visual, such as a `ContactAvatar`. */
  avatar?: React.ReactNode;
  /** Leading glyph, drawn in a 30px circle. Ignored when `avatar` is set. */
  icon?: React.ReactNode;
  /** Trailing `muted` value, such as the current language. */
  value?: React.ReactNode;
  /** Trailing control, such as a `Toggle`. */
  trailing?: React.ReactNode;
  /**
   * A selectable row: `true` shows the check, and the row reports `aria-pressed`. Leave undefined
   * on a row that is not a choice.
   */
  checked?: boolean;
  /** Shows the chevron of a row that navigates. On by default for `to` and `href`. */
  chevron?: boolean;
  /** Tapping the row: renders a `button`, with the tap haptic. */
  onClick?: () => void;
  /** An in-wallet route: renders the wallet's `Link` (haptic and analytics come with it). */
  to?: string;
  /** A page outside the wallet, opened in a new tab. */
  href?: string;
  /**
   * The id of the control in `trailing` (a switch): the row renders as its `label`, so tapping
   * anywhere on the row flips it. The control brings its own haptic, so the row adds none.
   */
  htmlFor?: string;
  disabled?: boolean;
  /**
   * A choice in a `radiogroup` (a tapped row with `checked`): announced as a radio with
   * `aria-checked` rather than as a pressed toggle, which a single-select list is not.
   */
  radio?: boolean;
  /** Tapped rows only: roving focus in a radiogroup sets it per row. */
  tabIndex?: number;
  /** Tapped rows only, e.g. arrow keys moving focus through a radiogroup. */
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  /**
   * Tapped rows only: `false` leaves the tap haptic to the caller, for a row whose tap can be
   * refused (a second tap on a choice that already left the page).
   */
  haptic?: boolean;
  /** Layout only (margins). */
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

type Leading = 'none' | 'avatar' | 'icon';

const rowVariants = cva(
  [
    'relative flex w-full items-center gap-3 px-4 text-left',
    // The hairline above every row but the first, starting after the leading visual.
    'before:absolute before:top-0 before:right-0 before:h-px before:bg-hairline first:before:hidden'
  ],
  {
    variants: {
      // 16px padding + the visual + the 12px gap.
      leading: {
        none: 'before:left-4',
        avatar: 'before:left-[68px]',
        icon: 'before:left-[58px]'
      },
      size: {
        default: 'min-h-16 py-3',
        compact: 'min-h-14 py-2'
      },
      interactive: {
        true: [
          'cursor-pointer transition-colors active:bg-fill-pressed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset',
          'disabled:cursor-default disabled:opacity-50 disabled:active:bg-transparent'
        ],
        false: ''
      }
    },
    defaultVariants: { leading: 'none', size: 'default', interactive: false }
  }
);

/**
 * One row of a `ListGroup`: a leading avatar or icon, a 16px title over a 13px `muted` subtitle,
 * then a trailing value, control, check or chevron. It is a `button` when tapped, the wallet
 * `Link` for a route, an anchor for an outside page, and a plain `div` otherwise.
 */
export const ListRow = React.forwardRef<HTMLButtonElement, ListRowProps>(function ListRow(
  {
    title,
    subtitle,
    avatar,
    icon,
    value,
    trailing,
    checked,
    chevron,
    onClick,
    to,
    href,
    htmlFor,
    disabled,
    radio,
    tabIndex,
    onKeyDown,
    haptic = true,
    className,
    'aria-label': ariaLabel,
    'data-testid': dataTestId
  },
  ref
) {
  const leading: Leading = avatar ? 'avatar' : icon ? 'icon' : 'none';
  const interactive = Boolean(onClick || to || href || htmlFor);
  const showChevron = chevron ?? Boolean(to || href);
  const classes = cn(rowVariants({ leading, size: subtitle ? 'default' : 'compact', interactive }), className);

  const content = (
    <>
      {avatar ? (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center">{avatar}</span>
      ) : (
        icon && (
          <span
            aria-hidden="true"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-page text-ink [&>svg]:h-4 [&>svg]:w-4"
          >
            {icon}
          </span>
        )
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span data-slot="title" className="truncate text-row-title text-ink">
          {title}
        </span>
        {subtitle && <span className="truncate text-caption text-muted">{subtitle}</span>}
      </span>
      {value !== undefined && <span className="shrink-0 text-body-sm text-muted">{value}</span>}
      {trailing !== undefined && <span className="flex shrink-0 items-center">{trailing}</span>}
      {checked && (
        <span
          data-slot="check"
          aria-hidden="true"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-accent-primary"
        >
          <CheckIcon className="h-2 w-2.5 fill-pure-white" />
        </span>
      )}
      {showChevron && (
        <ChevronRightIcon data-slot="chevron" aria-hidden="true" className="h-5 w-5 shrink-0 stroke-muted" />
      )}
    </>
  );

  if (to) {
    return (
      <Link to={to} testID={dataTestId} data-testid={dataTestId} aria-label={ariaLabel} className={classes}>
        {content}
      </Link>
    );
  }

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={() => hapticLight()}
        aria-label={ariaLabel}
        data-testid={dataTestId}
        className={classes}
      >
        {content}
      </a>
    );
  }

  if (htmlFor) {
    return (
      <label htmlFor={htmlFor} aria-label={ariaLabel} data-testid={dataTestId} className={classes}>
        {content}
      </label>
    );
  }

  if (onClick) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={() => {
          if (haptic) hapticLight();
          onClick();
        }}
        onKeyDown={onKeyDown}
        tabIndex={tabIndex}
        disabled={disabled}
        role={radio ? 'radio' : undefined}
        aria-checked={radio ? Boolean(checked) : undefined}
        aria-pressed={radio ? undefined : checked}
        aria-label={ariaLabel}
        data-testid={dataTestId}
        className={classes}
      >
        {content}
      </button>
    );
  }

  return (
    <div aria-label={ariaLabel} data-testid={dataTestId} className={classes}>
      {content}
    </div>
  );
});
