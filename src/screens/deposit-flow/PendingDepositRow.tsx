import React from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { depositAmountText } from './parts';
import * as s from './styles';
import type { DepositAmountValue } from './types';

/** `waiting`: no funds yet. `received`: the funds are at the address and a tap finishes the deposit. */
export type PendingDepositRowState = 'waiting' | 'received';

export interface PendingDepositRowProps {
  state: PendingDepositRowState;
  /** The reviewed amount, in source-token units. */
  amount: DepositAmountValue;
  symbol: string;
  /** The source network's name. */
  networkName: string;
  /** Goes back to the deposit address screen. */
  onClick: () => void;
  className?: string;
}

/**
 * The Home row of a deposit the user left (mock-up `.pend` in `viewHome`): a turning ring, the
 * state, "<amount> <token> from <network>" and a chevron. The whole row is one button.
 */
export const PendingDepositRow: React.FC<PendingDepositRowProps> = ({
  state,
  amount,
  symbol,
  networkName,
  onClick,
  className
}) => {
  const { t } = useTranslation();
  const title = state === 'received' ? t('depositFlowPendingReceived') : t('depositFlowWaitingTitle');
  return (
    <button
      type="button"
      onClick={() => {
        hapticLight();
        onClick();
      }}
      data-state={state}
      className={cn(s.BASE, s.PEND, className)}
      data-testid="pending-deposit-row"
    >
      <span aria-hidden="true" className={s.PEND_DOT} />
      <span className="min-w-0">
        <b className={s.PEND_TITLE}>{title}</b>
        <small className={s.PEND_SMALL}>
          {t('depositFlowPendingFrom', {
            amount: `${depositAmountText(amount, 'exact')} ${symbol}`,
            network: networkName
          })}
        </small>
      </span>
      <ChevronRightIcon aria-hidden="true" className={cn(s.ICON_20, 'stroke-current')} />
    </button>
  );
};
