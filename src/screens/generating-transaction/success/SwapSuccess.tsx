import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { ReactComponent as InfoIcon } from 'app/icons/information.svg';
import { ButtonVariant } from 'components/Button';
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
 * "Swap Order Created!" success view: the token→token summary pill, a
 * truthful note that the offered funds stay reserved in the order until it's
 * filled, and a "sourcing liquidity" footer over Done + "View in Activities".
 *
 * No expiry / auto-return is shown: `SwapTransaction` carries no expiry and
 * there is no reclaim mechanism wired, so promising a concrete return date or
 * a "no funds are lost" guarantee would be fabricated. The order's live state
 * (active / filled / reclaimed) is surfaced by the Activities detail card.
 */
export const SwapSuccess: FC<TransactionSuccessProps> = ({ transaction, onDoneClick }) => {
  const { t } = useTranslation();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeFaucetId = useMidenFaucetId();
  const badgeContent = useTransactionSummaryBadgeContent(transaction);

  // Offered side — this is what returns to the wallet if the order expires.
  const offered = resolveSwapAsset(transaction?.faucetId, assetsMetadata, nativeFaucetId);
  // `scaleIsKnown` is the whole reason `resolveSwapAsset` reports it: an
  // off-registry faucet the wallet never resolved has no trustworthy decimals,
  // and quoting a reserved balance at a guessed scale is worse than quoting
  // none — the sentence below drops to naming the token.
  const offeredAmount =
    transaction?.amount !== undefined && offered.scaleIsKnown
      ? formatAmount(transaction.amount, offered.decimals)
      : undefined;
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
        onClick: () => navigate(transaction ? `/history-details/${transaction.id}` : '/history'),
        variant: ButtonVariant.Secondary
      }}
      onClose={onDoneClick}
    >
      {badgeContent && <SuccessSummaryPill lhs={badgeContent.lhs} rhs={badgeContent.rhs} />}
      <SuccessDivider />

      {returnAmountText && (
        <div className="flex w-full items-start gap-1.5 text-xs text-heading-gray">
          <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 fill-current" />
          <span>{t('swapOrderReservedNote', { amount: returnAmountText })}</span>
        </div>
      )}
    </TransactionSuccessLayout>
  );
};
