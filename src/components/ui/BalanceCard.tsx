import React, { FC, ReactNode, useLayoutEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { useCardColor } from 'lib/settings/card-color';
import { CardColor } from 'lib/settings/constants';

import { CopyButton } from './CopyButton';
import { Pill } from './Pill';
import { Skeleton } from './Skeleton';

export type BalanceDeltaDirection = 'positive' | 'negative' | 'neutral';

/* Card background per picked color — the card-* tokens resolve light/dark
 * variants via CSS vars, so no dark: classes needed. Shared with the
 * AccountsDrawer swatches. */
export const CARD_COLOR_BG: Record<CardColor, string> = {
  slate: 'bg-card-slate',
  orange: 'bg-card-orange',
  blue: 'bg-card-blue',
  green: 'bg-card-green',
  purple: 'bg-card-purple'
};

/* The card is one tone: solid in light mode, 50% over the page in dark mode. The five colors are
 * brand colors and never shift for contrast. */
const CARD_COLOR_SURFACE: Record<CardColor, string> = {
  slate: 'bg-card-slate dark:bg-card-slate/50',
  orange: 'bg-card-orange dark:bg-card-orange/50',
  blue: 'bg-card-blue dark:bg-card-blue/50',
  green: 'bg-card-green dark:bg-card-green/50',
  purple: 'bg-card-purple dark:bg-card-purple/50'
};

const LEADING_SIGN = /^[+\-\u2212]\s*/;

/**
 * Which way the change pill points. A change that rounds to zero is neutral whatever the caller
 * says, so the card never shows an arrow (or a "-0.00") for no movement. Without a direction the
 * sign of the percentage decides.
 */
export function resolveDeltaDirection(delta: {
  percentage: string;
  direction?: BalanceDeltaDirection;
}): BalanceDeltaDirection {
  const magnitude = Number.parseFloat(delta.percentage.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(magnitude) || magnitude === 0) return 'neutral';
  if (delta.direction) return delta.direction;
  return /^\s*[-\u2212]/.test(delta.percentage) ? 'negative' : 'positive';
}

export interface BalanceCardProps {
  /** Truncated display label, e.g. `mtst1aqg...940z`. */
  accountNumber: string;
  /** Full account id used when copying to clipboard. Falls back to accountNumber. */
  accountId?: string;
  /** The account's name, shown in the footer beside its address. */
  accountName?: string;
  amount: ReactNode;
  currency?: string;
  delta?: {
    absolute: string;
    percentage: string;
    direction?: BalanceDeltaDirection;
  };
  onMore?: () => void;
  state?: 'default' | 'loading' | 'zero' | 'hidden';
  className?: string;
}

const AMOUNT_MAX_REM = 3.5;
const AMOUNT_MIN_REM = 2.5;

/* Shrinks the balance font so the full amount always fits the card width.
 * Text width scales linearly with font size, so one measurement yields the
 * exact fit — no iterate-until-fit loop. Sized in rem so it tracks the root
 * font size. Falls back to maxRem when layout isn't available (jsdom). */
function useFitFontSize(maxRem: number, minRem: number, active: boolean) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [fontSizeRem, setFontSizeRem] = useState(maxRem);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const text = textRef.current;
    if (!active || !row || !text) return;

    const fit = () => {
      const textWidth = text.scrollWidth;
      const currentPx = parseFloat(getComputedStyle(text).fontSize);
      if (textWidth === 0 || !currentPx) return;
      const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const suffix = text.nextElementSibling;
      const gapPx = parseFloat(getComputedStyle(text.parentElement ?? row).columnGap) || 0;
      const suffixWidth = suffix instanceof HTMLElement ? suffix.offsetWidth + gapPx : 0;
      const available = row.clientWidth - suffixWidth;
      if (available <= 0) return;
      const widthAtMaxPx = (textWidth / currentPx) * maxRem * rootPx;
      const next = Math.min(maxRem, Math.max(minRem, (maxRem * available) / widthAtMaxPx));
      setFontSizeRem(Math.round(next * 1000) / 1000);
    };

    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(row);
    observer.observe(text);
    return () => observer.disconnect();
  }, [maxRem, minRem, active]);

  return { rowRef, textRef, fontSizeRem };
}

export const BalanceCard: FC<BalanceCardProps> = ({
  accountNumber,
  accountId,
  accountName,
  amount,
  currency = 'USD',
  delta,
  onMore,
  state = 'default',
  className
}) => {
  const { t } = useTranslation();
  const isLoading = state === 'loading';
  const isHidden = state === 'hidden';
  const isZero = state === 'zero';
  const cardColor = useCardColor();
  const { rowRef, textRef, fontSizeRem } = useFitFontSize(AMOUNT_MAX_REM, AMOUNT_MIN_REM, !isLoading);

  const deltaDirection = delta ? resolveDeltaDirection(delta) : 'neutral';
  // A neutral change carries no sign: the arrow and the sign are how the pill shows direction.
  // TRAP for whoever wires a real price source: `deltaDirection` is neutral when the PERCENTAGE
  // rounds to zero, and this strips the sign from BOTH values, so a real -$12.34 at 0.00% renders
  // identically to a gain. Home passes no delta today, which is why nothing shows it.
  const deltaText = (value: string) => (deltaDirection === 'neutral' ? value.replace(LEADING_SIGN, '') : value);

  const handleMoreClick = () => {
    if (!onMore) return;
    hapticLight();
    onMore();
  };
  return (
    <div
      className={classNames(
        'relative w-full overflow-hidden text-surface-balance-fg rounded-lg-token',
        CARD_COLOR_SURFACE[cardColor],
        onMore && 'cursor-pointer',
        className
      )}
    >
      {/* The whole card opens the account options, but as a real button UNDER the content, never
          around it: a role=button container makes its children presentational, so the balance and
          the copy control stopped being reachable for assistive tech. The content above it is
          transparent to taps, so a tap anywhere still opens the options, while the copy button
          keeps its own. */}
      {onMore && (
        <button
          type="button"
          onClick={handleMoreClick}
          aria-label={t('balanceCardAccountOptions')}
          // The ring has to be inset: this button's border box is exactly the box the card clips
          // to, so an outside ring is clipped away and keyboard focus would show nothing at all.
          className="absolute inset-0 z-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary focus-visible:outline-none"
        />
      )}
      <div className={classNames('relative px-4 pt-4 pb-4', onMore && 'pointer-events-none')}>
        {/* Every text on the card is the full-strength card ink: hierarchy comes from size and
            weight, since any translucent ink falls under 4.5:1 on the lighter card colors. */}
        <div data-testid="balance-card-label" className="text-label">
          {t('balanceCardTotalBalance')}
        </div>

        <div ref={rowRef} className="mt-2 flex items-end leading-none min-w-0">
          {isLoading ? (
            <Skeleton tone="inverse" className="h-12 w-48" />
          ) : (
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span
                ref={textRef}
                style={{ fontSize: `${fontSizeRem}rem` }}
                className="text-display leading-none whitespace-nowrap"
              >
                {/* eslint-disable-next-line i18next/no-literal-string -- balance-mask glyphs / pre-formatted zero value, not translatable copy */}
                {isHidden ? '••••••' : isZero ? '0.00' : amount}
              </span>
              {/* The entry pattern's unit: 22px beside the amount, on its baseline. */}
              <span data-testid="balance-card-currency" className="shrink-0 text-entry-unit leading-none">
                {currency}
              </span>
            </div>
          )}
        </div>

        {delta && !isLoading && !isHidden && (
          <div className="mt-3 flex">
            <Pill
              tone="inverse"
              data-testid="balance-card-delta"
              icon={
                deltaDirection === 'neutral' ? undefined : (
                  // The `!` beats the default md size <Icon> injects; under Tailwind v4 it otherwise wins.
                  <Icon
                    name={deltaDirection === 'negative' ? IconName.ArrowDown : IconName.ArrowUp}
                    className="w-4! h-4!"
                  />
                )
              }
            >
              {t('balanceCardDeltaPill', {
                absolute: deltaText(delta.absolute),
                percentage: deltaText(delta.percentage)
              })}
            </Pill>
          </div>
        )}
      </div>

      {/* The footer is the same card, set off by a hairline in the card's ink. */}
      <div
        data-testid="balance-card-footer"
        className={classNames(
          'relative mx-4 flex min-h-11 items-center justify-between gap-3 border-t border-surface-balance-rule',
          onMore && 'pointer-events-none'
        )}
      >
        {accountName && (
          <span data-testid="balance-card-account-name" className="min-w-0 truncate text-label">
            {accountName}
          </span>
        )}
        {/* The copy control takes its own taps back; it is a sibling of the options button, so a
            copy can no longer also open the options. */}
        <span className={classNames('pointer-events-auto flex min-w-0', accountName ? 'ml-auto' : '-ml-2')}>
          <CopyButton
            text={accountId ?? accountNumber}
            data-testid="balance-card-copy-address"
            aria-label={copied => (copied ? t('balanceCardAddressCopied') : t('balanceCardCopyAddress'))}
            label={accountNumber}
            // The address stays put; the glyph alone morphs to the check.
            copiedLabel={null}
            icon="trailing"
            className="-mr-2 flex min-h-11 min-w-0 items-center px-2 text-surface-balance-fg active:opacity-80 transition-opacity"
            contentClassName="text-label leading-none"
          />
        </span>
      </div>
    </div>
  );
};

export default BalanceCard;
