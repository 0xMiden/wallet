import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticSelection } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { DepositAmount, depositAmountText, DepositSheet } from './parts';
import * as s from './styles';
import type { DepositAmountValue, DepositFee } from './types';

/** One route the deposit can take. */
export interface DepositRouteOption {
  id: string;
  /** The route's name (Agglayer, Epoch). */
  name: string;
  /** The arrival time, already translated ("About 2 minutes"). */
  arrivesIn: string;
  /** What arrives with this route. Omit before an amount is entered: the row then leads with the fee. */
  received?: DepositAmountValue;
  /** The route's bridge fee. Omit to show no fee line. */
  fee?: DepositFee;
  /** How much less this route delivers than the best one. Shown only on a row with no tag. */
  less?: DepositAmountValue;
  /** The route that delivers the most: the "Most received" tag. */
  best: boolean;
  /** The quickest route: the "Fastest" tag. */
  fastest: boolean;
  selected: boolean;
}

export interface DepositRouteSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rows, in the order to show them. */
  routes: readonly DepositRouteOption[];
  /** The symbol of what arrives, for `received` and `less`. */
  receivedSymbol: string;
  /** The symbol of the source token, for a fee amount. */
  feeSymbol: string;
  onSelect: (id: string) => void;
}

/** The "Choose a route" sheet (mock-up `routeRowsV`): one card for each route, the chosen one raised. */
export const DepositRouteSheet: React.FC<DepositRouteSheetProps> = ({
  open,
  onOpenChange,
  routes,
  receivedSymbol,
  feeSymbol,
  onSelect
}) => {
  const { t } = useTranslation();

  const feeText = (fee: DepositFee): string => {
    switch (fee.kind) {
      case 'amount':
        return t('depositFlowRouteFee', { fee: `${depositAmountText(fee.value, 'up')} ${feeSymbol}` });
      case 'rate':
        return t('depositFlowRouteFee', { fee: fee.text });
      case 'none':
        return t('depositFlowNoFee');
    }
  };

  return (
    <DepositSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('depositFlowChooseRoute')}
      screenKey="deposit-route"
      data-testid="deposit-route-sheet"
    >
      <div className="flex flex-col gap-2">
        {routes.map(route => {
          const fee = route.fee ? feeText(route.fee) : '';
          return (
            <button
              key={route.id}
              type="button"
              aria-pressed={route.selected}
              onClick={() => {
                hapticSelection();
                onSelect(route.id);
              }}
              className={cn(s.OPT5, route.selected && s.OPT5_SELECTED)}
              data-testid={`deposit-route-${route.id}`}
            >
              <i aria-hidden="true" className={cn(s.OPT5_MARK, route.selected && s.OPT5_MARK_ON)}>
                {route.selected && <Icon name={IconName.Checkmark} fill="currentColor" className={s.ICON_12} />}
              </i>
              <b className={s.OPT5_STRONG}>{route.name}</b>
              <b className={cn(s.OPT5_STRONG, 'text-right')}>
                {route.received ? (
                  <DepositAmount value={route.received} symbol={receivedSymbol} rounding="down" />
                ) : (
                  fee
                )}
              </b>
              <small className={s.OPT5_SMALL}>{route.arrivesIn}</small>
              <small className={cn(s.OPT5_SMALL, 'text-right')}>{route.received ? fee : ''}</small>
              <span className={s.FT6}>
                {route.best && (
                  <span className={cn(s.TG, s.TG_K)} data-testid={`deposit-route-${route.id}-best`}>
                    {t('depositFlowMostReceived')}
                  </span>
                )}
                {route.fastest && (
                  <span className={s.TG} data-testid={`deposit-route-${route.id}-fastest`}>
                    {t('depositFlowFastest')}
                  </span>
                )}
                {!route.best && !route.fastest && route.less && (
                  <small className={s.OPT5_SMALL}>
                    {t('depositFlowRouteLess', {
                      amount: `${depositAmountText(route.less, 'up')} ${receivedSymbol}`
                    })}
                  </small>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </DepositSheet>
  );
};
