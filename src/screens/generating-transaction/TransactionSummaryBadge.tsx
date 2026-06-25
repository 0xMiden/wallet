import React, { FC, ReactNode, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { TokenLogo } from 'components/TokenLogo';
import { ITransaction } from 'lib/miden/db/types';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';
import { truncateAddress } from 'utils/string';

export interface TransactionSummaryBadgeProps {
  /** Rendered before the arrow. */
  lhs?: ReactNode;
  /** Rendered after the arrow. */
  rhs?: ReactNode;
  /** Applied to the pill root; lets the caller own outer spacing so the badge can render `null` without leaving a gap. */
  className?: string;
}

export interface TransactionSummaryBadgeContent {
  lhs: ReactNode;
  rhs: ReactNode;
}

/**
 * Dynamic one-line summary pill shown under the "Generating transaction"
 * title.
 */
export const TransactionSummaryBadge: FC<TransactionSummaryBadgeProps> = ({ lhs, rhs, className }) => {
  if (lhs === null || lhs === undefined || lhs === false || rhs === null || rhs === undefined || rhs === false) {
    return null;
  }

  return (
    <div
      className={classNames(
        'flex w-full items-center justify-center gap-2 rounded-2xl border border-[#ECEBE8] bg-surface-solid py-4 text-base',
        className
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold text-heading-gray text-base">
        {lhs}
      </div>
      <span className="shrink-0 text-[#8E8E93]" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M5 12h13M12.5 6l6 6-6 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="flex min-w-0 items-center gap-2 font-medium text-heading-gray text-base">{rhs}</div>
    </div>
  );
};

/**
 * Today only the `send` variant is implemented:
 *
 *   {amount} {symbol}  ->  {recipient}  on  (Miden) Miden
 *
 * Other transaction types (consume/claim, swap, switch-guardian, bridged
 * sends) render nothing for now. See CLAUDE.md -> "Transaction summary badge"
 * for how to add a variant and where each type's data lives.
 */
export const useTransactionSummaryBadgeContent = (
  transaction?: ITransaction
): TransactionSummaryBadgeContent | undefined => {
  const { t } = useTranslation();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);

  return useMemo(() => {
    if (transaction?.type !== 'send') return undefined;

    const tokenMetadata = transaction.faucetId ? assetsMetadata?.[transaction.faucetId] : undefined;
    const symbol = tokenMetadata?.symbol ?? MIDEN_METADATA.symbol;
    const amount =
      transaction.amount !== undefined ? formatAmount(transaction.amount, tokenMetadata?.decimals) : undefined;
    const recipient = transaction.secondaryAccountId
      ? truncateAddress(transaction.secondaryAccountId, true, 6, 4, 4)
      : undefined;

    if (!amount || !recipient) return undefined;

    return {
      lhs: `${amount} ${symbol}`,
      rhs: (
        <>
          <span className="min-w-0 truncate">{recipient}</span>
          <span className="shrink-0 text-[#8E8E93]">{t('onLowercase')}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <TokenLogo symbol={symbol} />
            <span className="font-semibold">{MIDEN_METADATA.name}</span>
          </span>
        </>
      )
    };
  }, [assetsMetadata, t, transaction]);
};
