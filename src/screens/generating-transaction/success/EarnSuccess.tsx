import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

import { buildReceiptRows } from './receipt';
import {
  ReceiptRows,
  SuccessDivider,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps
} from './TransactionSuccessLayout';
import { earnMarketLabel, EarnDepositArrowGlyph } from '../TransactionSummaryBadge';

/** USDC fallback decimals when the collateral faucet has no metadata (mirrors `MIDEN_USDC_DECIMALS`). */
const EARN_USDC_DECIMALS = 6;

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

  // Mirrors the in-progress badge: earn collateral is USDC-denominated, and the
  // CLI/testnet faucet may be absent from `assetsMetadata` — fall back to the
  // USDC symbol/decimals rather than the native-asset defaults
  // `useReceiptAmount` would pick.
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const tokenMetadata = transaction?.faucetId ? assetsMetadata?.[transaction.faucetId] : undefined;
  const amountText =
    transaction?.amount !== undefined
      ? `${formatAmount(transaction.amount, tokenMetadata?.decimals ?? EARN_USDC_DECIMALS)} ${
          tokenMetadata?.symbol ?? 'USDC'
        }`
      : undefined;

  const marketUid: unknown = transaction?.extraInputs?.marketUid;
  const market = typeof marketUid === 'string' ? earnMarketLabel(marketUid) : undefined;

  const rows = useMemo(() => {
    const receiptRows = buildReceiptRows(t, {
      amountText,
      amountLabel: t('earnTotalDeposited', { defaultValue: 'Total Deposited' }),
      txHash,
      onViewExplorer
    });
    if (market) {
      receiptRows.unshift({ label: t('earnMarketLabel', { defaultValue: 'Market' }), value: market });
    }
    return receiptRows;
  }, [amountText, market, onViewExplorer, t, txHash]);

  return (
    <TransactionSuccessLayout
      headerTitle=""
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
      <SuccessDivider />
      <ReceiptRows rows={rows} className="mt-2" />
    </TransactionSuccessLayout>
  );
};
