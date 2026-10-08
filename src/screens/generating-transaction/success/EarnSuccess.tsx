import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';
import { accentForTransactionType } from 'components/flow/accent';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

import { buildReceiptRows } from './receipt';
import {
  ReceiptRows,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps,
  useReceiptFeeText
} from './TransactionSuccessLayout';
import { earnMarketLabel, EarnDepositArrowGlyph, useEarnCollateralFallback } from '../TransactionSummaryBadge';

/**
 * "You're Earning!" receipt for a completed `earn-deposit` — routed from the
 * `TransactionSuccess` dispatcher on the tx type. Everything shown comes off
 * the tracking row (`IEarnDepositExtraInputs`): the summary pill is
 * "{amount} {symbol} ↑ {market}" (the market name derived from `marketUid`,
 * same as the in-progress badge), and the rows are Market / Total Deposited /
 * Transaction ID. No APY / earnings projections — the row doesn't carry them.
 *
 * "View Details" goes to the positions list (`/earn/positions`) — the freshly
 * opened position's id isn't known until the positions service indexes it, so
 * there is no per-position route to target from here.
 */
export const EarnSuccess: FC<TransactionSuccessProps> = ({ transaction, txHash, onDoneClick, onViewExplorer }) => {
  const { t } = useTranslation();

  // Mirrors the in-progress badge: the CLI/testnet faucet may be absent from
  // `assetsMetadata`, so fall back to the collateral the config names, and only
  // for a row of that very faucet, rather than the native-asset defaults
  // `useReceiptAmount` would pick.
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const stored = transaction?.faucetId ? assetsMetadata?.[transaction.faucetId] : undefined;
  const collateral = useEarnCollateralFallback(transaction?.faucetId);
  // A stored record only outranks the collateral's stated scale when it actually
  // resolved: the unknown-token placeholder is not evidence about this faucet.
  const tokenMetadata = hasKnownScale(stored) ? stored : undefined;
  const scale = tokenMetadata ?? collateral;
  const amountText =
    transaction?.amount !== undefined && scale
      ? `${formatAmount(transaction.amount, scale.decimals)} ${scale.symbol}`
      : undefined;

  const marketUid: unknown = transaction?.extraInputs?.marketUid;
  const market = typeof marketUid === 'string' ? earnMarketLabel(marketUid) : undefined;

  // A deposit pays a network fee like any other transaction, and the row records it.
  // Resolved on its own rather than through `useReceiptAmount`, whose amount is
  // native-denominated and wrong for a USDC deposit.
  const feeText = useReceiptFeeText(transaction);

  const rows = useMemo(() => {
    const receiptRows = buildReceiptRows(t, {
      amountText,
      amountLabel: t('earnTotalDeposited', { defaultValue: 'Total Deposited' }),
      feeText,
      txHash,
      onViewExplorer
    });
    if (market) {
      receiptRows.unshift({ label: t('earnMarketLabel', { defaultValue: 'Market' }), value: market });
    }
    return receiptRows;
  }, [amountText, feeText, market, onViewExplorer, t, txHash]);

  return (
    <TransactionSuccessLayout
      headerTitle=""
      accent={accentForTransactionType(transaction?.type)}
      title={t('youreEarning', { defaultValue: "You're Earning!" })}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewDetails', { defaultValue: 'View Details' }),
        onClick: () => navigate('/earn/positions'),
        variant: ButtonVariant.Secondary
      }}
      onClose={onDoneClick}
    >
      <SuccessSummaryPill lhs={amountText} rhs={market} separator={<EarnDepositArrowGlyph />} />
      <ReceiptRows rows={rows} surface="outline" className="mt-6" />
    </TransactionSuccessLayout>
  );
};
