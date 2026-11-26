import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { TokenAmount } from 'components/ui/TokenAmount';
import { type AmountDisplayOptions, formatAmountDisplay, formatUsdDisplay } from 'lib/i18n/amount-display';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerTitle } from 'lib/ui/drawer';
import { cn } from 'lib/ui/util';

import * as s from './styles';
import type { DepositAmountValue, DepositFee, DepositLayout } from './types';

/** How a deposit amount is rounded on screen: up for what the user pays, down for what arrives. */
export type DepositRounding = 'up' | 'down';

/**
 * The display text of an amount, without a symbol. `exact` shows every digit, for an amount the
 * user typed or must send. Display only, never transaction input.
 */
export function depositAmountText(value: DepositAmountValue, rounding: DepositRounding | 'exact'): string {
  switch (rounding) {
    case 'exact':
      return formatAmountDisplay(value.amount, { decimals: value.decimals, formatting: 'exact' });
    case 'up':
    case 'down':
      return formatAmountDisplay(value.amount, { decimals: value.decimals, rounding });
  }
}

/** The exact decimal text of an amount, with no grouping: what a copy writes and what a deposit must match. */
export function depositExactText(value: DepositAmountValue): string {
  return formatAmountDisplay(value.amount, { decimals: value.decimals, formatting: 'exact', grouping: false });
}

/** An amount with its symbol, through `TokenAmount`. `exact` shows every digit (an amount the user must send). */
export const DepositAmount: React.FC<{
  value: DepositAmountValue;
  symbol: string;
  rounding: DepositRounding | 'exact';
  className?: string;
  'data-testid'?: string;
}> = ({ value, symbol, rounding, className, 'data-testid': dataTestId }) => {
  const options: Pick<AmountDisplayOptions, 'formatting' | 'rounding'> =
    rounding === 'exact' ? { formatting: 'exact' } : { formatting: 'adaptive', rounding };
  return value.decimals === undefined ? (
    <TokenAmount amount={value.amount} symbol={symbol} {...options} className={className} data-testid={dataTestId} />
  ) : (
    <TokenAmount
      amount={value.amount}
      decimals={value.decimals}
      symbol={symbol}
      {...options}
      className={className}
      data-testid={dataTestId}
    />
  );
};

/** The mock-up's "≈ $70.25 USD" line text. Empty while the value is not known. */
export function useUsdEstimateText(usd: number | undefined): string {
  const { t } = useTranslation();
  if (usd === undefined || !Number.isFinite(usd)) return '';
  return t('depositFlowUsdEstimate', { value: formatUsdDisplay(usd) });
}

/** The minus sign in front of a fee that the receipt takes off ("− 0.21 USDC"). */
const MINUS_PREFIX = '− ';

/** The bridge fee as one value: the quoted amount, a rate, or "None". */
export const DepositFeeValue: React.FC<{ fee: DepositFee; symbol: string; minusSign?: boolean }> = ({
  fee,
  symbol,
  minusSign = false
}) => {
  const { t } = useTranslation();
  switch (fee.kind) {
    case 'amount':
      return (
        <>
          {minusSign && MINUS_PREFIX}
          <DepositAmount value={fee.value} symbol={symbol} rounding="up" />
        </>
      );
    case 'rate':
      return <>{fee.text}</>;
    case 'none':
      return <>{t('none')}</>;
  }
};

export interface DepositFactRowProps {
  label: string;
  children: React.ReactNode;
  'data-testid'?: string;
}

const FactCardLayout = React.createContext<DepositLayout>('mobile');

/** One row of a `.dcard`. */
export const DepositFactRow: React.FC<DepositFactRowProps> = ({ label, children, 'data-testid': dataTestId }) => {
  const layout = React.useContext(FactCardLayout);
  return (
    <div data-testid={dataTestId} className={cn(s.DCARD_ROW, layout === 'extension' && s.DCARD_ROW_EXT)}>
      <span className={s.ROW_LABEL}>{label}</span>
      <b className={s.DCARD_VALUE}>{children}</b>
    </div>
  );
};

/** `.dcard`: rows of label and value with hairlines between them. */
export const DepositFactCard: React.FC<{
  children: React.ReactNode;
  layout?: DepositLayout;
  className?: string;
  'data-testid'?: string;
}> = ({ children, layout = 'mobile', className, 'data-testid': dataTestId }) => (
  <FactCardLayout.Provider value={layout}>
    <div data-testid={dataTestId} className={cn(s.DCARD, 'divide-y divide-hairline', className)}>
      {children}
    </div>
  </FactCardLayout.Provider>
);

export type DepositNoticeKind = 'negative' | 'big' | 'inline';

/** The three notices of the mock-up: `.notice.neg`, `.notice.big` and `.notice`. */
export const DepositNotice: React.FC<{
  kind: DepositNoticeKind;
  title?: React.ReactNode;
  children?: React.ReactNode;
  icon?: IconName;
  role?: 'note' | 'status' | 'alert';
  action?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}> = ({
  kind,
  title,
  children,
  icon = IconName.WarningFill,
  role = 'note',
  action,
  className,
  'data-testid': dataTestId
}) => {
  const look = (() => {
    switch (kind) {
      case 'negative':
        return { box: s.NOTICE_NEG, icon: s.NOTICE_NEG_ICON, title: s.NOTICE_NEG_TITLE };
      case 'big':
        return { box: s.NOTICE_BIG, icon: s.NOTICE_BIG_ICON, title: s.NOTICE_BIG_TITLE };
      case 'inline':
        return { box: s.NOTICE, icon: s.NOTICE_ICON, title: 'block font-bold' };
    }
  })();
  return (
    <div role={role} data-kind={kind} data-testid={dataTestId} className={cn(look.box, className)}>
      <Icon name={icon} fill="currentColor" aria-hidden="true" className={look.icon} />
      <span className="flex min-w-0 flex-col">
        <span>
          {title !== undefined && <b className={look.title}>{title}</b>}
          {children}
        </span>
        {action}
      </span>
    </div>
  );
};

export interface DepositSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Names the drawer for the E2E overlay key. */
  screenKey: string;
  children: React.ReactNode;
  'data-testid'?: string;
}

/** `.sheet`: the shared `Drawer` with the mock-up's header (`.hd`, `.x32`) and rule, items 14px apart. */
export const DepositSheet: React.FC<DepositSheetProps> = ({
  open,
  onOpenChange,
  title,
  screenKey,
  children,
  'data-testid': dataTestId
}) => {
  const { t } = useTranslation();
  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey={screenKey}>
      <DrawerContent className={cn(s.BASE, s.SHEET)} overlayClassName={s.SCRIM}>
        <div data-testid={dataTestId} className="contents">
          <div className={s.SHEET_HEAD}>
            <DrawerTitle className={s.SHEET_TITLE}>{title}</DrawerTitle>
            <button
              type="button"
              aria-label={t('close')}
              data-testid={dataTestId && `${dataTestId}-close`}
              className={s.X32}
              onClick={() => {
                hapticLight();
                onOpenChange(false);
              }}
            >
              <Icon name={IconName.Close} fill="currentColor" aria-hidden="true" className={s.ICON_18} />
            </button>
          </div>
          <div aria-hidden="true" className={s.SHEET_RULE} />
          <div className={s.SHEET_BODY}>{children}</div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
