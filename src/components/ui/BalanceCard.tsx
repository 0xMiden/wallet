import React, { FC, ReactNode, useLayoutEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import CopyButton from 'app/atoms/CopyButton';
import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { useCardColor } from 'lib/settings/card-color';
import { CardColor } from 'lib/settings/constants';
import { WalletType } from 'screens/onboarding/types';

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

/* Two-tone card: the top section is the primary tone — solid in light mode,
 * 50% opacity in dark mode; the bottom strip is the solid second tone. */
const CARD_COLOR_TOP: Record<CardColor, string> = {
  slate: 'bg-card-slate dark:bg-card-slate/50',
  orange: 'bg-card-orange dark:bg-card-orange/50',
  blue: 'bg-card-blue dark:bg-card-blue/50',
  green: 'bg-card-green dark:bg-card-green/50',
  purple: 'bg-card-purple dark:bg-card-purple/50'
};

const CARD_COLOR_BOTTOM: Record<CardColor, string> = {
  slate: 'bg-card-slate-deep',
  orange: 'bg-card-orange-deep',
  blue: 'bg-card-blue-deep',
  green: 'bg-card-green-deep',
  purple: 'bg-card-purple-deep'
};

const CARD_COLOR_ICON: Record<CardColor, string> = {
  slate: 'text-card-slate-deep',
  orange: 'text-card-orange-deep',
  blue: 'text-card-blue-deep',
  green: 'text-card-green-deep',
  purple: 'text-card-purple-deep'
};

const ACCOUNT_TYPE_LABEL_KEY: Record<WalletType, string> = {
  [WalletType.OffChain]: 'accountTypePrivate',
  [WalletType.Guardian]: 'accountTypeGuardian',
  [WalletType.OnChain]: 'accountTypePublic'
};

export interface BalanceCardProps {
  /** Truncated display label, e.g. `mtst1aqg...940z`. */
  accountNumber: string;
  /** Full account id used when copying to clipboard. Falls back to accountNumber. */
  accountId?: string;
  /** User-visible account name ("Account 1"). Shown before the address when set. */
  accountName?: string;
  /** Account privacy model shown beside the total-balance heading. */
  accountType?: WalletType;
  amount: ReactNode;
  currency?: string;
  delta?: {
    absolute: string;
    percentage: string;
    direction?: BalanceDeltaDirection;
  };
  onMore?: () => void;
  /** Opens the account switcher; turns the account label into a chip with a chevron. */
  onSwitch?: () => void;
  /** Shows a "+" button next to the settings dot for adding an account. */
  onAdd?: () => void;
  state?: 'default' | 'loading' | 'zero' | 'hidden';
  className?: string;
}

const SKELETON_BLOCK = 'animate-pulse rounded-md bg-white/15';

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
  accountType,
  amount,
  currency = 'USD',
  delta,
  onMore,
  onSwitch,
  onAdd,
  state = 'default',
  className
}) => {
  const { t } = useTranslation();
  const isLoading = state === 'loading';
  const isHidden = state === 'hidden';
  const isZero = state === 'zero';
  const cardColor = useCardColor(accountId ?? accountNumber);
  const { rowRef, textRef, fontSizeRem } = useFitFontSize(AMOUNT_MAX_REM, AMOUNT_MIN_REM, !isLoading);

  const pillBg = delta?.direction === 'negative' ? 'bg-status-negative' : 'bg-[#A8BBA3]';

  const handleMoreClick = () => {
    if (!onMore) return;
    hapticLight();
    onMore();
  };

  const handleSwitchClick = () => {
    if (!onSwitch) return;
    hapticLight();
    onSwitch();
  };

  const handleAddClick = () => {
    if (!onAdd) return;
    hapticLight();
    onAdd();
  };

  return (
    <div className={classNames('relative w-full overflow-hidden text-surface-balance-fg rounded-lg-token', className)}>
      <div className={classNames('px-3.5 pt-4 pb-3.5', CARD_COLOR_TOP[cardColor])}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-surface-balance-fg-muted leading-none">
            {t('balanceCardTotalBalance')}
          </div>
          {accountType && (
            <span className="shrink-0 rounded-full bg-surface-balance-rule px-2 py-1 text-xs font-heading font-semibold leading-none text-surface-balance-fg">
              {t(ACCOUNT_TYPE_LABEL_KEY[accountType])}
            </span>
          )}
        </div>

        <div ref={rowRef} className="mt-2.5 flex items-end gap-1 leading-none min-w-0">
          {isLoading ? (
            <div className={classNames(SKELETON_BLOCK, 'h-12 w-48')} />
          ) : (
            <div className="flex items-center gap-0.5 min-w-0">
              <span
                ref={textRef}
                style={{ fontSize: `${fontSizeRem}rem` }}
                className="font-heading font-extrabold leading-none whitespace-nowrap"
              >
                {/* eslint-disable-next-line i18next/no-literal-string -- balance-mask glyphs / pre-formatted zero value, not translatable copy */}
                {isHidden ? '••••••' : isZero ? '$0.00' : amount}
              </span>
              <span className="shrink-0 font-heading text-base font-semibold text-surface-balance-fg-muted">
                {currency}
              </span>
            </div>
          )}
        </div>

        {delta && !isLoading && !isHidden && (
          <div className="mt-3">
            <span
              className={classNames(
                'inline-flex items-center rounded-full px-3 py-1',
                'font-heading text-sm font-semibold leading-none text-surface-balance-fg',
                pillBg
              )}
            >
              {t('balanceCardDeltaPill', { absolute: delta.absolute, percentage: delta.percentage })}
            </span>
          </div>
        )}
      </div>

      <div
        className={classNames(
          'flex items-center justify-between gap-2 py-2 border-t border-dashed px-3.5 border-t-[#FFFFFF4D]',
          CARD_COLOR_BOTTOM[cardColor]
        )}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {onSwitch ? (
            <>
              <button
                type="button"
                onClick={handleSwitchClick}
                aria-label={t('switchAccount')}
                className={classNames(
                  'flex items-center gap-1 text-xs font-heading font-bold leading-none tracking-tight min-w-0 text-left',
                  'text-surface-balance-fg active:opacity-80 transition-opacity'
                )}
              >
                <span className="truncate">
                  {accountName
                    ? t('balanceCardAccountChip', { name: accountName, number: accountNumber })
                    : t('balanceCardAccount', { number: accountNumber })}
                </span>
                {/* The `!` on the size classes is load-bearing: <Icon> injects a default `md` (w-6 h-6)
                    size class that, under Tailwind v4's scale-ordered output, otherwise wins the cascade.
                    Do not drop the `!` (same for the icons below). */}
                <Icon name={IconName.ChevronDown} fill="currentColor" className="w-3.5! h-3.5! shrink-0" />
              </button>
              <CopyButton
                text={accountId ?? accountNumber}
                aria-label={t('copy')}
                className="shrink-0 flex items-center text-surface-balance-fg hover:bg-transparent active:opacity-80 transition-opacity"
              >
                <Icon name={IconName.CopyNew} className="w-3.5! h-3.5! shrink-0" />
              </CopyButton>
            </>
          ) : (
            <CopyButton
              text={accountId ?? accountNumber}
              className={classNames(
                'flex items-center gap-1 text-xs font-heading font-bold leading-none tracking-tight min-w-0 text-left',
                'text-surface-balance-fg hover:bg-transparent active:opacity-80 transition-opacity'
              )}
            >
              <span className="truncate">{t('balanceCardAccount', { number: accountNumber })}</span>
              <Icon name={IconName.CopyNew} className="w-3.5! h-3.5! shrink-0" />
            </CopyButton>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {onAdd && (
            <button
              type="button"
              onClick={handleAddClick}
              aria-label={t('addAccount')}
              className="flex items-center justify-center w-4.5 h-4.5 rounded-full bg-pure-white"
            >
              <Icon
                name={IconName.Add}
                fill="currentColor"
                className={classNames('w-3! h-3!', CARD_COLOR_ICON[cardColor])}
              />
            </button>
          )}
          {onMore && (
            <button
              type="button"
              onClick={handleMoreClick}
              aria-label={t('balanceCardAccountOptions')}
              className="flex items-center justify-center w-4.5 h-4.5 rounded-full bg-pure-white"
            >
              <Icon name={IconName.SettingsNew} className={classNames('w-3! h-3!', CARD_COLOR_ICON[cardColor])} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default BalanceCard;
