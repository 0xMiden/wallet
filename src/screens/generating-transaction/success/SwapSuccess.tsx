import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as InfoIcon } from 'app/icons/information.svg';
import { ButtonVariant } from 'components/Button';
import { ReviewLabel } from 'components/review/ReviewRow';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

import { resolveSwapAsset, useTransactionSummaryBadgeContent } from '../TransactionSummaryBadge';
import {
  SuccessDivider,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps
} from './TransactionSuccessLayout';

/**
 * "Swap Order Created!" success view: the token→token summary pill, an
 * Expiration Date row with the "funds return if unclaimed" note, and a
 * "sourcing liquidity" footer over Done + "View in Activities".
 *
 * The expiration value is the same static placeholder the review screen shows
 * (`swapExpiresValue`) — `SwapTransaction` carries no expiry yet. The mock's
 * "| Edit" link is deliberately omitted: the order is already on-chain and
 * there's no expiry-edit flow to wire it to.
 */
export const SwapSuccess: FC<TransactionSuccessProps> = ({ transaction, onDoneClick }) => {
  const { t } = useTranslation();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const badgeContent = useTransactionSummaryBadgeContent(transaction);

  // Offered side — this is what returns to the wallet if the order expires.
  const offered = resolveSwapAsset(transaction?.faucetId, assetsMetadata);
  const offeredAmount =
    transaction?.amount !== undefined ? formatAmount(transaction.amount, offered.decimals) : undefined;
  const returnAmountText = offeredAmount ? `${offeredAmount} ${offered.symbol}` : undefined;

  return (
    <TransactionSuccessLayout
      headerTitle=""
      title={t('swapOrderCreated')}
      footerDescription={
        <>
          {t('swapSuccessSourcingLiquidity')}
          <br />
          {t('swapSuccessTrackProgress')}
        </>
      }
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewInActivities'),
        onClick: () => navigate('/history'),
        variant: ButtonVariant.Secondary
      }}
      onClose={onDoneClick}
    >
      {badgeContent && <SuccessSummaryPill lhs={badgeContent.lhs} rhs={badgeContent.rhs} />}
      <SuccessDivider />

      <div className="w-full">
        <div className="flex items-center justify-between gap-3 py-5">
          <ReviewLabel>{t('expirationDate')}</ReviewLabel>
          <span className="min-w-0 font-heading text-base font-bold leading-tight text-heading-gray">
            {t('swapExpiresValue')}
          </span>
        </div>

        {returnAmountText && (
          <div className="flex items-start gap-1.5 text-xs text-[#6B6862]">
            <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 fill-current" />
            <span>{t('recallReturnsNote', { amount: returnAmountText })}</span>
          </div>
        )}
      </div>
    </TransactionSuccessLayout>
  );
};
