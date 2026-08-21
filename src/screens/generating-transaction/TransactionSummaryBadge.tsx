import React, { FC, ReactNode, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { ITransaction } from 'lib/miden/db/types';
import { DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from 'lib/miden/metadata';
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
    // The OUTER row deliberately does not wrap. `lhs → rhs` is the pill's whole
    // grammar, and letting the three siblings wrap as units breaks every
    // one-line variant — a send at the 360px popup would put the amount and the
    // recipient on separate lines with the arrow stranded between them.
    //
    // Only `lhs` wraps internally, because only it is unbounded: a batch claim
    // lists every asset it swept up. Both of this pill's ancestors hide
    // overflow, so the old `shrink-0 whitespace-nowrap` simply dropped the tail
    // — and the activity row's "+N more" pointed here for a full list this could
    // not show. The arrow stays vertically centred, so on a wrapped claim it
    // reads as "this whole list → Consumed".
    <div
      className={classNames(
        'flex w-full items-center justify-center gap-2 rounded-3xl bg-surface-interactive px-4 py-4 text-base',
        className
      )}
    >
      <div className="flex min-w-0 flex-wrap justify-center font-heading items-center gap-1.5 font-extrabold text-heading-gray text-xl dark:text-pure-white">
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

/**
 * Format a claim's assets as `["20 A", "10 B"]`, one entry per faucet swept up.
 *
 * Shared by the in-progress badge and the success receipt because they render
 * the SAME claim seconds apart on the SAME screen: the receipt replaces the
 * badge once the row completes. Deriving them separately is what let the receipt
 * silently drop every secondary asset and label an unresolved faucet MIDEN while
 * the badge called it Unknown.
 *
 * A batch claim sums per faucet (`assetTotals`); legacy rows without it fall
 * back to the first faucet's `amount`/`faucetId`. Empty when the row carries no
 * amount at all, which callers should render as no summary rather than a blank.
 *
 * `nativeFaucetId` is passed in rather than read here: the synchronous accessor
 * returns `null` until discovery lands and firing it from inside this function
 * gave no way to re-render afterwards, so a claim of the native asset kept the
 * `Unknown` label for the life of the screen while the activity row — which
 * awaits the id — called the same claim MIDEN. Callers pass `useMidenFaucetId()`,
 * which re-renders when the id arrives. `null` means "not yet known", so the
 * native branch simply does not match until it is.
 */
export const formatConsumeAssetParts = (
  transaction: ITransaction,
  assetsMetadata: Record<string, AssetMetadata> | undefined,
  nativeFaucetId: string | null
): string[] => {
  const totals =
    transaction.assetTotals && transaction.assetTotals.length > 0
      ? transaction.assetTotals
      : transaction.amount !== undefined && transaction.faucetId
        ? [{ faucetId: transaction.faucetId, amount: transaction.amount }]
        : [];

  return totals.map(total => {
    const tokenMetadata = assetsMetadata?.[total.faucetId];
    // Mirrors `getTokenMetadata`, which the activity row for this same claim
    // goes through: an unresolved NON-native faucet is Unknown, not MIDEN.
    // Labelling it MIDEN would name a foreign token after the native one —
    // and a batch claim's secondary faucets are exactly the ones the wallet
    // has no metadata for, since it has never held them.
    const fallback =
      nativeFaucetId !== null && total.faucetId === nativeFaucetId ? MIDEN_METADATA : DEFAULT_TOKEN_METADATA;
    const symbol = tokenMetadata?.symbol ?? fallback.symbol;
    const decimals = tokenMetadata?.decimals ?? (fallback === MIDEN_METADATA ? fallback.decimals : undefined);
    // No decimals means no honest way to scale this faucet's base units — the
    // unknown-token fallback's 6 is a placeholder, not a fact, and using it
    // renders an 18-decimal token 10^12 too large. Name the asset, withhold the
    // quantity until metadata resolves.
    return decimals === undefined ? symbol : `${formatAmount(total.amount, decimals)} ${symbol}`;
  });
};

/**
 * Build the market label from an Epoch `marketUid` (`LENDER:chainId:token`) —
 * the lender key itself, hyphenated (e.g. `DUMMY_LENDING` → "DUMMY-LENDING").
 * No hardcoded aliases: the badge shows the real market name.
 */
export const earnMarketLabel = (marketUid: string): string | undefined => {
  const lenderKey = marketUid.split(':')[0];
  if (!lenderKey) return undefined;
  return lenderKey.replaceAll('_', '-');
};

/**
 * Implemented variants:
 *
 *   send          →  {amount} {symbol}        ->  {recipient}
 *   swap          →  (logo) {amount} {symbol} ->  (logo) {amount} {symbol}
 *   earn-deposit  →  {amount} {symbol}        ↑   {market name}     (up-arrow separator)
 *   consume       →  {amount} {symbol}        ->  Consumed
 *
 * Other transaction types (switch-guardian, bridged sends) render nothing for
 * now. See CLAUDE.md -> "Transaction summary badge" for how to add a variant
 * and where each type's data lives.
 */
export const useTransactionSummaryBadgeContent = (
  transaction?: ITransaction
): TransactionSummaryBadgeContent | undefined => {
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeFaucetId = useMidenFaucetId();
  const { t } = useTranslation();

  return useMemo(() => {
    if (transaction?.type === 'consume') {
      const parts = formatConsumeAssetParts(transaction, assetsMetadata, nativeFaucetId);

      // Consume amount is optional (batch claims may not carry one) — no pill then.
      if (parts.length === 0) return undefined;

      return {
        lhs: parts.join(', '),
        rhs: t('consumed', { defaultValue: 'Consumed' })
      };
    }

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
  }, [assetsMetadata, nativeFaucetId, t, transaction]);
};
