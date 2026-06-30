import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';
import { IBridgedSendExtraInputs } from 'lib/miden/db/types';

import { bridgeRouteValue, bridgeSpeedBadge, buildReceiptRows } from './receipt';
import {
  ReceiptRows,
  SuccessAmountBlock,
  SuccessDivider,
  TransactionSuccessLayout,
  TransactionSuccessProps,
  useReceiptAmount
} from './TransactionSuccessLayout';

export interface BridgeSuccessProps extends TransactionSuccessProps {
  /** Typed bridged-send payload, narrowed by the dispatcher. */
  bridgedInputs: IBridgedSendExtraInputs;
}

/**
 * Success receipt for a send that was routed out of Miden through a bridge.
 * Adds an "Arriving on Ethereum" sub-line (with a FAST/SLOW speed badge) under
 * the amount and a "Route" row naming the provider, on top of the shared
 * recipient / total-paid / source-tx rows.
 */
export const BridgeSuccess: FC<BridgeSuccessProps> = ({
  transaction,
  txHash,
  onDoneClick,
  onViewExplorer,
  bridgedInputs
}) => {
  const { t } = useTranslation();
  const { amountText } = useReceiptAmount(transaction);
  const destinationAddress = bridgedInputs.destinationAddress ?? transaction?.secondaryAccountId;

  const rows = useMemo(
    () =>
      buildReceiptRows(t, {
        destinationAddress,
        amountText,
        txHash,
        onViewExplorer,
        route: bridgeRouteValue(t, bridgedInputs.provider)
      }),
    [amountText, bridgedInputs.provider, destinationAddress, onViewExplorer, t, txHash]
  );

  return (
    <TransactionSuccessLayout
      headerTitle={t('success', { defaultValue: 'Success!' })}
      title={t('transactionComplete', { defaultValue: 'Transaction Complete!' })}
      footerDescription={t('transactionSuccessDescription')}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      onClose={onDoneClick}
    >
      <SuccessDivider />
      <SuccessAmountBlock
        amountText={amountText}
        subline={
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-base leading-none text-[#8E8E93]">
            <span>{t('arrivingOnNetwork', { defaultValue: 'Arriving on Ethereum' })}</span>
            <span className="rounded-md bg-[#EEEEF0] px-2.5 py-1 text-sm font-bold leading-none text-heading-gray">
              {bridgeSpeedBadge(bridgedInputs.provider)}
            </span>
          </div>
        }
      />
      <ReceiptRows rows={rows} className="mt-[68px]" />
    </TransactionSuccessLayout>
  );
};
