import React, { FC, ReactNode, useMemo } from 'react';

import classNames from 'clsx';

import { TokenLogo } from 'components/TokenLogo';
import { ITransaction } from 'lib/miden/db/types';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { AssetMetadata } from 'lib/miden/metadata/types';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
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
        'flex w-full items-center justify-center gap-2 rounded-full bg-surface-interactive py-4 text-base',
        className
      )}
    >
      <div className="flex shrink-0 font-heading items-center gap-1.5 whitespace-nowrap font-extrabold text-heading-gray text-xl">
        {lhs}
      </div>
      <span className="shrink-0" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="24" height="24" rx="12" fill="#91ACC1" />
          <path d="M6.22266 12.0889H16.5071" stroke="white" stroke-width="2.20995" stroke-linecap="round" />
          <path
            d="M14.6582 9.77832L17.0849 12.0894L14.6582 14.4006"
            stroke="white"
            stroke-width="2.20995"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <div className="flex min-w-0 items-center gap-2 font-bold text-heading-gray text-xl font-heading">{rhs}</div>
    </div>
  );
};

interface ResolvedAsset {
  symbol: string;
  decimals?: number;
  /** Symbol understood by TokenLogo (MIDEN/ETH/USDC/BTC). */
  logoSymbol: string;
}

/**
 * Resolve a swap-side faucet to a display symbol/decimals/logo. The DEX token
 * registry is the source of truth for the fixed swap tokens (whose faucets may
 * not be present in `assetsMetadata`); fall back to wallet metadata, then to
 * the native asset.
 */
const resolveSwapAsset = (
  faucetId: string | undefined,
  assetsMetadata: Record<string, AssetMetadata> | undefined
): ResolvedAsset => {
  const swapToken = getSwapTokenByFaucetId(faucetId);
  const metadata = faucetId ? assetsMetadata?.[faucetId] : undefined;
  return {
    symbol: swapToken?.symbol ?? metadata?.symbol ?? MIDEN_METADATA.symbol,
    decimals: swapToken?.decimals ?? metadata?.decimals,
    logoSymbol: swapToken?.logoSymbol ?? metadata?.symbol ?? MIDEN_METADATA.symbol
  };
};

/**
 * Implemented variants:
 *
 *   send  →  {amount} {symbol}        ->  {recipient}
 *   swap  →  (logo) {amount} {symbol} ->  (logo) {amount} {symbol}
 *
 * Other transaction types (consume/claim, switch-guardian, bridged sends)
 * render nothing for now. See CLAUDE.md -> "Transaction summary badge" for how
 * to add a variant and where each type's data lives.
 */
export const useTransactionSummaryBadgeContent = (
  transaction?: ITransaction
): TransactionSummaryBadgeContent | undefined => {
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);

  return useMemo(() => {
    if (transaction?.type === 'swap') {
      const offered = resolveSwapAsset(transaction.faucetId, assetsMetadata);
      const requestedFaucetId = transaction.extraInputs?.requestedFaucetId;
      const requested = resolveSwapAsset(requestedFaucetId, assetsMetadata);

      const offeredAmount =
        transaction.amount !== undefined ? formatAmount(transaction.amount, offered.decimals) : undefined;
      const requestedRaw = transaction.extraInputs?.requestedAmount;
      const requestedAmount = requestedRaw !== undefined ? formatAmount(requestedRaw, requested.decimals) : undefined;

      if (!offeredAmount || !requestedAmount) return undefined;

      return {
        lhs: (
          <>
            <TokenLogo symbol={offered.logoSymbol} size="sm" />
            <span className="whitespace-nowrap">
              {offeredAmount} {offered.symbol}
            </span>
          </>
        ),
        rhs: (
          <>
            <TokenLogo symbol={requested.logoSymbol} size="sm" />
            <span className="min-w-0 truncate">
              {requestedAmount} {requested.symbol}
            </span>
          </>
        )
      };
    }

    if (transaction?.type !== 'send') return undefined;

    const tokenMetadata = transaction.faucetId ? assetsMetadata?.[transaction.faucetId] : undefined;
    const symbol = tokenMetadata?.symbol ?? MIDEN_METADATA.symbol;
    const amount =
      transaction.amount !== undefined ? formatAmount(transaction.amount, tokenMetadata?.decimals) : undefined;
    const recipient = transaction.secondaryAccountId
      ? truncateAddress(transaction.secondaryAccountId, false, 8, 8)
      : undefined;

    if (!amount || !recipient) return undefined;

    return {
      lhs: `${amount} ${symbol}`,
      rhs: (
        <>
          <span className="min-w-0 truncate">{recipient}</span>
        </>
      )
    };
  }, [assetsMetadata, transaction]);
};
