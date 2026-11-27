import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button, ButtonVariant } from 'components/ui/Button';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { type DepositBadgeSide, DepositBadge } from './DepositProcessingView';
import { DepositAmount, DepositFactCard, DepositFactRow, DepositFeeValue } from './parts';
import * as s from './styles';
import type { DepositFee } from './types';

export interface DepositSuccessViewProps {
  /** What the user sent, on the left of the badge. */
  sent: DepositBadgeSide;
  /** What arrived, on the right of the badge and in the Received row. */
  received: DepositBadgeSide;
  /** The source network's name (the From row). */
  networkName: string;
  routeName: string;
  bridgeFee: DepositFee;
  /** The symbol a fee amount is in (the source token). */
  feeSymbol: string;
  onDone: () => void;
  /** Starts a new deposit on the amount screen. */
  onDepositAgain: () => void;
}

/**
 * The success screen of a deposit (mock-up `viewSuccess`): the check disc, "Deposit arrived", the badge, the details
 * card (From, Route, Bridge fee, Received) and the two pinned buttons "Done" and "Deposit again". It has no page
 * header.
 */
export const DepositSuccessView: React.FC<DepositSuccessViewProps> = ({
  sent,
  received,
  networkName,
  routeName,
  bridgeFee,
  feeSymbol,
  onDone,
  onDepositAgain
}) => {
  const { t } = useTranslation();
  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <div className="flex w-full flex-col gap-2.5">
          <Button
            title={t('done')}
            accent="send"
            onClick={() => {
              hapticLight();
              onDone();
            }}
            className="w-full max-w-none"
            data-testid="deposit-success-done"
          />
          <Button
            title={t('depositFlowDepositAgain')}
            accent="send"
            variant={ButtonVariant.Secondary}
            onClick={() => {
              hapticLight();
              onDepositAgain();
            }}
            className="w-full max-w-none"
            data-testid="deposit-success-again"
          />
        </div>
      }
    >
      <div className={cn(s.BASE, s.STATUS_STACK, s.SUCCESS_TOP)} data-testid="deposit-success">
        <div className={s.OKC} aria-hidden="true">
          <Icon name={IconName.Checkmark} fill="currentColor" className={s.ICON_44} />
        </div>
        <h1 className={s.T24}>{t('depositFlowArrivedTitle')}</h1>
        <DepositBadge sent={sent} received={received} />
        <DepositFactCard data-testid="deposit-success-facts">
          <DepositFactRow label={t('from')}>{networkName}</DepositFactRow>
          <DepositFactRow label={t('route')}>{routeName}</DepositFactRow>
          <DepositFactRow label={t('depositFlowBridgeFee')} data-testid="deposit-success-fee">
            <DepositFeeValue fee={bridgeFee} symbol={feeSymbol} />
          </DepositFactRow>
          <DepositFactRow label={t('received')} data-testid="deposit-success-received">
            {received.value === undefined ? (
              received.symbol
            ) : (
              <DepositAmount value={received.value} symbol={received.symbol} rounding={received.rounding} />
            )}
          </DepositFactRow>
        </DepositFactCard>
      </div>
    </HomeGroupPaneBody>
  );
};
