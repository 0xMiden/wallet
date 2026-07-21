import React, { FC, ReactNode, useMemo } from 'react';

import classNames from 'clsx';

import { formatEarnWithdrawAmount } from 'app/templates/history/transactionUtils';
import { ITransaction } from 'lib/miden/db/types';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { AssetMetadata } from 'lib/miden/metadata/types';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';
import { truncateAddress } from 'utils/string';

export interface TransactionSummaryBadgeProps {
  /** Rendered before the separator. */
  lhs?: ReactNode;
  /** Rendered after the separator. */
  rhs?: ReactNode;
  /** Applied to the pill root; lets the caller own outer spacing so the badge can render `null` without leaving a gap. */
  className?: string;
  /**
   * Glyph rendered between `lhs` and `rhs`. Defaults to the horizontal arrow
   * (tinted by `fillForArrow`); pass a node to override — e.g. the up-arrow used
   * when opening an earn position.
   */
  separator?: ReactNode;
  /** Tints the default horizontal arrow. Ignored when `separator` is provided. */
  fillForArrow?: string;
}

export interface TransactionSummaryBadgeContent {
  lhs: ReactNode;
  rhs: ReactNode;
  separator?: ReactNode;
  fillForArrow?: string;
}

/** Default separator — the horizontal "→" arrow, tinted by `fill`. */
const HorizontalArrowGlyph: FC<{ fill?: string }> = ({ fill }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="12" fill={fill ?? '#91ACC1'} />
    <path d="M6.22266 12.0889H16.5071" stroke="white" stroke-width="2.20995" stroke-linecap="round" />
    <path
      d="M14.6582 9.77832L17.0849 12.0894L14.6582 14.4006"
      stroke="white"
      stroke-width="2.20995"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

/** Separator used when opening an earn position — an up "↑" arrow in a grey circle. */
export const EarnDepositArrowGlyph: FC = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="12" fill="#6E6E73" />
    <path d="M11.6523 17.5195L11.6523 7.23506" stroke="white" stroke-width="2.20995" stroke-linecap="round" />
    <path
      d="M9.3418 9.08398L11.6529 6.65731L13.964 9.08398"
      stroke="white"
      stroke-width="2.20995"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

/**
 * Dynamic one-line summary pill shown under the "Generating transaction"
 * title.
 */
export const TransactionSummaryBadge: FC<TransactionSummaryBadgeProps> = ({
  lhs,
  rhs,
  className,
  separator,
  fillForArrow
}) => {
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
      <div className="flex shrink-0 font-heading items-center gap-1.5 whitespace-nowrap font-extrabold text-heading-gray text-xl dark:text-pure-white">
        {lhs}
      </div>
      <span className="shrink-0" aria-hidden="true">
        {separator ?? <HorizontalArrowGlyph fill={fillForArrow} />}
      </span>
      <div className="flex min-w-0 items-center gap-2 font-bold text-heading-gray text-xl font-heading dark:text-pure-white">
        {rhs}
      </div>
    </div>
  );
};

interface ResolvedAsset {
  symbol: string;
  decimals?: number;
}

/**
 * Two-tone swap-side amount — dark amount immediately followed by the grey
 * symbol (".15ETH"), matching the mock's logo-less pill.
 */
const SwapAmountText: FC<{ amount: string; symbol: string }> = ({ amount, symbol }) => (
  <span className="min-w-0 truncate whitespace-nowrap text-2xl font-extrabold">
    <span className="text-heading-gray">{amount}</span>
    <span className="text-gray">{symbol}</span>
  </span>
);

/**
 * Resolve a swap-side faucet to a display symbol/decimals. The DEX token
 * registry is the source of truth for the fixed swap tokens (whose faucets may
 * not be present in `assetsMetadata`); fall back to wallet metadata, then to
 * the native asset.
 */
export const resolveSwapAsset = (
  faucetId: string | undefined,
  assetsMetadata: Record<string, AssetMetadata> | undefined
): ResolvedAsset => {
  const swapToken = getSwapTokenByFaucetId(faucetId);
  const metadata = faucetId ? assetsMetadata?.[faucetId] : undefined;
  return {
    symbol: swapToken?.symbol ?? metadata?.symbol ?? MIDEN_METADATA.symbol,
    decimals: swapToken?.decimals ?? metadata?.decimals
  };
};

/** USDC fallback decimals for an earn deposit when the faucet has no metadata (mirrors `MIDEN_USDC_DECIMALS`). */
const EARN_USDC_DECIMALS = 6;

/** Human protocol labels per Epoch lender key (the `LENDER` segment of a `marketUid`). */
const EARN_LENDER_LABELS: Record<string, string> = { DUMMY_LENDING: 'AAVE' };

/** Build the "AAVE-USDC" pair label from an Epoch `marketUid` (`LENDER:chainId:token`). USDC-only today. */
const earnMarketLabel = (marketUid: string): string | undefined => {
  const lenderKey = marketUid.split(':')[0];
  if (!lenderKey) return undefined;
  const protocol = EARN_LENDER_LABELS[lenderKey] ?? lenderKey;
  return `${protocol}-USDC`;
};

/**
 * Implemented variants:
 *
 *   send          →  {amount} {symbol}        ->  {recipient}
 *   bridged-send  →  {amount} {symbol}        ->  {EVM recipient}
 *   swap          →  (logo) {amount} {symbol} ->  (logo) {amount} {symbol}
 *   earn-deposit  →  {amount} {symbol}        ↑  {protocol}-USDC   (up-arrow separator)
 *   earn-withdraw →  {sourceAmount} {sourceSymbol}  ->  Miden
 *
 * Other transaction types (consume/claim, switch-guardian) render nothing for
 * now. See CLAUDE.md -> "Transaction summary badge" for how to add a variant
 * and where each type's data lives.
 */
export const useTransactionSummaryBadgeContent = (
  transaction?: ITransaction
): TransactionSummaryBadgeContent | undefined => {
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);

  return useMemo(() => {
    if (transaction?.type === 'earn-deposit') {
      const tokenMetadata = transaction.faucetId ? assetsMetadata?.[transaction.faucetId] : undefined;
      const decimals = tokenMetadata?.decimals ?? EARN_USDC_DECIMALS;
      const symbol = tokenMetadata?.symbol ?? 'USDC';
      const amount = transaction.amount !== undefined ? formatAmount(transaction.amount, decimals) : undefined;
      const marketUid: unknown = transaction.extraInputs?.marketUid;
      const rhs = typeof marketUid === 'string' ? earnMarketLabel(marketUid) : undefined;

      if (!amount || !rhs) return undefined;

      return {
        lhs: `${amount} ${symbol}`,
        rhs,
        separator: <EarnDepositArrowGlyph />
      };
    }

    // Smart Withdraw: the source side is the human-formatted USDC being
    // redeemed on Epoch; the funds land back on Miden.
    if (transaction?.type === 'earn-withdraw') {
      const sourceAmount: unknown = transaction.extraInputs?.sourceAmount;
      const sourceSymbol: unknown = transaction.extraInputs?.sourceSymbol;
      if (typeof sourceAmount !== 'string' || typeof sourceSymbol !== 'string') return undefined;

      return {
        lhs: `${formatEarnWithdrawAmount(sourceAmount)} ${sourceSymbol}`,
        rhs: <span className="min-w-0 truncate">Miden</span>
      };
    }

    // Cross-chain (0x recipient) send. `outputAmount`/`outputSymbol` are only
    // filled in later by the Epoch poller, so at generating time we show the
    // send-style "{amount} {symbol} -> {EVM recipient}" from the always-present
    // source amount + destination address.
    if (transaction?.type === 'bridged-send') {
      const tokenMetadata = transaction.faucetId ? assetsMetadata?.[transaction.faucetId] : undefined;
      const symbol = tokenMetadata?.symbol ?? MIDEN_METADATA.symbol;
      const amount =
        transaction.amount !== undefined ? formatAmount(transaction.amount, tokenMetadata?.decimals) : undefined;
      const destination: unknown = transaction.extraInputs?.destinationAddress;
      const recipient = typeof destination === 'string' ? truncateAddress(destination, false, 8, 8) : undefined;

      if (!amount || !recipient) return undefined;

      return {
        lhs: `${amount} ${symbol}`,
        rhs: <span className="min-w-0 truncate">{recipient}</span>
      };
    }

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
        lhs: <SwapAmountText amount={offeredAmount} symbol={offered.symbol} />,
        rhs: <SwapAmountText amount={requestedAmount} symbol={requested.symbol} />,
        fillForArrow: '#BEACD2'
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
