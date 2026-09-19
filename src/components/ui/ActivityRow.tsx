import React, { FC, ReactNode } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { springs, useMotion } from 'lib/animation';
import { getAdaptiveDecimalPlaces } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { Status, StatusBadge } from './StatusBadge';

/** Extra batch-claim assets rendered inline before the row collapses to a count. */
const EXTRA_ASSET_PREVIEW_COUNT = 2;

export type ActivityAmountDirection = 'positive' | 'negative' | 'neutral';

export interface ActivityRowProps {
  /** Glyph rendered inside the colored square. Pass a white-stroked SVG; it is forced to 16x16. */
  icon: ReactNode;
  /**
   * Tailwind classes for the icon square's background. Defaults to a neutral
   * gray; callers should pass the appropriate accent (e.g. `bg-receive-green`).
   */
  iconBg?: string;
  title: string;
  subtitle?: string;
  amount?: {
    value: string;
    /** Token symbol, rendered in the neutral heading color next to the value. */
    symbol?: string;
    direction?: ActivityAmountDirection;
    /**
     * Further assets appended inline after the first, comma-separated and in the
     * same colour — a batch claim of several tokens reads "+20 A, +10 B". Each
     * `value` carries its own sign like the primary `value`. `key` must be stable
     * and unique (the source faucet id): two faucets can format to the same
     * amount and to the same symbol, since an unresolvable one reads "Unknown".
     *
     * Only the first `EXTRA_ASSET_PREVIEW_COUNT` render; the remainder collapse
     * to a "+N more" count, so pass these in the order worth showing — they are
     * rendered in the given order, not sorted. The detail view's summary pill
     * wraps and lists every asset.
     */
    extra?: { key: string; value: string; symbol?: string }[];
  };
  /** The row's status, drawn as a `sm` `StatusBadge` under the amount. */
  status?: Status;
  /** Right-aligned relative time (e.g. "Just now") — alternative to `status`. */
  timestamp?: string;
  onClick?: () => void;
  /**
   * Layout, or the surface a `Card asChild` draws onto the row. Merged with `cn`, so a card's
   * padding replaces the row's own `py-4` instead of fighting it.
   */
  className?: string;
  /**
   * Optional E2E hook. The component destructures its props (no rest spread), so
   * a `data-testid` cannot be threaded through from the call site — it has to be
   * an explicit prop. When set, the root carries it and the text parts carry
   * `${testId}-title` / `-subtitle` / `-amount` / `-status`, so a spec can assert
   * the row's amount and recipient exactly instead of substring-matching the row.
   */
  testId?: string;
  /**
   * Stable per-entry identifier, mirrored to `data-entry-key`. A spec cannot
   * address a row by its rendered address: that string is truncated, and on a
   * composite account id BOTH visible halves are shared network-wide
   * (`mtst1a…qq9wr6w`), so it matches every row rather than one.
   */
  entryKey?: string;
}

// The status badge's sage and clay inks, so an amount and the badge under it speak one palette.
// Never the raw status fills (#90BA89 was 2.19:1 on white): on the row's `fill` card these read
// 5.62 / 5.56:1 light and 8.38 / 7.30:1 dark (`lib/ui/design-tokens.test.ts`).
const AMOUNT_COLOR: Record<ActivityAmountDirection, string> = {
  positive: 'text-positive-tint-ink',
  negative: 'text-negative-tint-ink',
  neutral: 'text-ink'
};

const DISPLAY_DECIMAL_PLACES = 3;

function formatDisplayAmount(value: string): string {
  const sign = value.startsWith('+') ? '+' : '';
  const amount = new BigNumber(sign ? value.slice(1) : value);

  if (!amount.isFinite()) {
    return value;
  }

  const decimalPlaces = getAdaptiveDecimalPlaces(amount, DISPLAY_DECIMAL_PLACES);
  return `${sign}${amount.decimalPlaces(decimalPlaces, BigNumber.ROUND_DOWN).toFixed()}`;
}

export const ActivityRow: FC<ActivityRowProps> = ({
  icon,
  iconBg = 'bg-fill',
  title,
  subtitle,
  amount,
  status,
  timestamp,
  onClick,
  className,
  testId,
  entryKey
}) => {
  const { t } = useTranslation();
  // `settle` for the row's layout move: the most damped preset, so a slide
  // comes to rest with no overshoot. Under reduced motion `useMotion`
  // collapses it to an instant tween, so a filter change still swaps the
  // list, only without the movement.
  const transition = useMotion(springs.settle);
  const handleClick = () => {
    if (!onClick) return;
    hapticLight();
    onClick();
  };
  // A "Claim All" can sweep up any number of distinct assets, and this row has
  // one line for them; past a couple the amount column starves the title beside
  // it. Show the first few in the order the caller passed and count the rest.
  // The row opens the detail view, whose summary pill wraps and so does list
  // every asset in full.
  const extra = amount?.extra ?? [];
  const visibleExtra = extra.slice(0, EXTRA_ASSET_PREVIEW_COUNT);
  const extraOverflowCount = extra.length - visibleExtra.length;
  // The row is a Framer element so a list can animate it as a plain list item:
  // `layout` slides the rows that stay into place when a filter or a search
  // removes a neighbour. Nothing fades: a removed row leaves at once and a new
  // one appears in place, the way a native list behaves. The tap state is
  // Framer's, so it shares the channel a layout move may hold.
  return (
    <motion.div
      layout
      whileTap={onClick ? { opacity: 0.9 } : undefined}
      transition={transition}
      data-testid={testId}
      data-entry-key={entryKey}
      role={onClick ? 'button' : undefined}
      onClick={onClick ? handleClick : undefined}
      className={cn('w-full flex items-center py-4 justify-between', onClick && 'cursor-pointer', className)}
    >
      <div className="flex items-center gap-2">
        <div
          className={classNames(
            'shrink-0 flex items-center justify-center w-10 h-10 rounded-full text-pure-white',
            '[&_svg]:w-4 [&_svg]:h-4',
            iconBg
          )}
        >
          {icon}
        </div>

        <div className="flex flex-col text-ink leading-tight dark:text-pure-white">
          <span data-testid={testId && `${testId}-title`} className="font-heading text-base font-bold">
            {title}
          </span>
          {subtitle && (
            <span
              data-testid={testId && `${testId}-subtitle`}
              className="font-heading text-xs text-muted font-medium leading-[100%]"
            >
              {subtitle}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col items-end gap-1">
        {amount && (
          <span
            data-testid={testId && `${testId}-amount`}
            className="font-heading text-sm font-bold leading-tight text-right"
          >
            {amount.value !== '' && (
              <span className={AMOUNT_COLOR[amount.direction ?? 'neutral']}>{formatDisplayAmount(amount.value)}</span>
            )}
            {amount.symbol ? (
              <span className="text-ink">{amount.value === '' ? amount.symbol : ` ${amount.symbol}`}</span>
            ) : null}
            {/* Every further asset of a batch claim follows inline: "+20 A, +10 B".
                The test id is indexed so each asset stays individually addressable —
                a repeated one makes `getByTestId` ambiguous under strict mode.
                An asset whose scale never resolved carries an empty `value`; it is
                named without a number, and without the space that would otherwise
                sit between the missing number and the symbol. */}
            {visibleExtra.map((line, index) => (
              <span key={line.key} data-testid={testId && `${testId}-amount-extra-${index}`}>
                {/* eslint-disable-next-line i18next/no-literal-string -- list separator, not translatable copy */}
                <span className="text-ink">, </span>
                {line.value !== '' && (
                  <span className={AMOUNT_COLOR[amount.direction ?? 'neutral']}>{formatDisplayAmount(line.value)}</span>
                )}
                {line.symbol ? (
                  <span className="text-ink">{line.value === '' ? line.symbol : ` ${line.symbol}`}</span>
                ) : null}
              </span>
            ))}
            {extraOverflowCount > 0 && (
              <span data-testid={testId && `${testId}-amount-extra-overflow`} className="text-ink">
                {/* eslint-disable-next-line i18next/no-literal-string -- list separator, not translatable copy */}
                <span>, </span>
                {t('andMoreAssets', { count: extraOverflowCount })}
              </span>
            )}
          </span>
        )}
        {status && <StatusBadge status={status} data-testid={testId && `${testId}-status`} />}
        {timestamp && <span className="text-[10px] text-gray-secondary font-regular">{timestamp}</span>}
      </div>
    </motion.div>
  );
};

export default ActivityRow;
