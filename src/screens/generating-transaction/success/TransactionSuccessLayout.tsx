import React, { FC, ReactNode, useEffect, useRef } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { Button, ButtonVariant } from 'components/Button';
import { FlowAccent } from 'components/flow/accent';
import { FlowLayout } from 'components/flow/FlowLayout';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { ITransaction } from 'lib/miden/db/types';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';

import { TransactionHeroIcon } from '../components';
import { formatConsumeAssetParts, TransactionSummaryBadge } from '../TransactionSummaryBadge';

/**
 * Shared presentational kit for the post-transaction success screens.
 *
 * The visual chrome (header, hero check, title, footer buttons) is identical
 * across every transaction type — only the body (summary pill, amount block,
 * receipt rows) and the footer copy/actions vary. Each per-type view
 * (`SendSuccess`, `BridgeSuccess`, future `SwapSuccess`/`EarnSuccess`)
 * composes these primitives rather than duplicating the layout. Mirrors the
 * `TransactionSummaryBadge` + `useTransactionSummaryBadgeContent` split used by
 * the in-progress screen.
 */

/** Props shared by every per-type success view and the dispatcher. */
export interface TransactionSuccessProps {
  transaction?: ITransaction;
  txHash?: string | null;
  onDoneClick: () => void;
  onViewExplorer?: () => void;
}

export interface SuccessAction {
  label: string;
  onClick: () => void;
  /** Defaults to `Primary`. */
  variant?: ButtonVariant;
}

export interface ReceiptRow {
  label: string;
  value: ReactNode;
  /** Optional secondary line under the value (e.g. "No fee", a fee breakdown). */
  subValue?: ReactNode;
  /** When set, the value renders as a button wired to this handler. */
  onClick?: () => void;
  /** Accessible label for the clickable value (e.g. "View on Midenscan"). */
  actionLabel?: string;
  /** Stack the value under the label, for long values like a full address. */
  stacked?: boolean;
}

/**
 * Resolves the token symbol + formatted amount for a transaction.
 *
 * A claim reports EVERY faucet it swept up ("20 A, 10 B"), via the same helper
 * the in-progress badge uses — this receipt replaces that badge on the same
 * screen, so deriving the two separately makes the total appear to drop the
 * moment the transaction succeeds.
 */
/**
 * The formatted network fee for a receipt row, or `undefined` when there is none to
 * show (a zero-fee chain, or a row written before fees were recorded).
 *
 * Its own hook because the fee is orthogonal to the amount: the earn and bridge
 * receipts derive their amount themselves — earn deposits are USDC-denominated, so
 * `useReceiptAmount`'s native-asset resolution is wrong for them — and so could not
 * reach the fee without also taking an amount they discard. That is why those two
 * receipts silently showed no fee while the send receipt did.
 */
export const useReceiptFeeText = (transaction?: ITransaction) => {
  const assetsMetadata = useWalletStore(state => state.assetsMetadata) ?? {};
  const nativeFaucetId = useMidenFaucetId();

  // The fee is always paid in the native asset, so it resolves against the native
  // faucet rather than the transaction's own token.
  const feeMetadata = resolveDisplayMetadata(transaction?.feeFaucetId, assetsMetadata, nativeFaucetId);
  return transaction?.feeAmount !== undefined && hasKnownScale(feeMetadata)
    ? `${formatAmount(transaction.feeAmount, feeMetadata.decimals)} ${feeMetadata.symbol}`
    : undefined;
};

export const useReceiptAmount = (transaction?: ITransaction) => {
  const assetsMetadata = useWalletStore(state => state.assetsMetadata) ?? {};
  const nativeFaucetId = useMidenFaucetId();

  const tokenMetadata = resolveDisplayMetadata(transaction?.faucetId, assetsMetadata, nativeFaucetId);
  const tokenSymbol = tokenMetadata.symbol;
  const consumeParts =
    transaction?.type === 'consume' ? formatConsumeAssetParts(transaction, assetsMetadata, nativeFaucetId) : [];
  // Same rule as the in-progress badge this receipt replaces: a faucet whose
  // decimals were never resolved has no honest scale, so the asset is named
  // without a quantity instead of being shown at the placeholder's guess.
  const amount =
    transaction?.amount !== undefined && hasKnownScale(tokenMetadata)
      ? formatAmount(transaction.amount, tokenMetadata.decimals)
      : undefined;
  const amountText =
    consumeParts.length > 0 ? consumeParts.join(', ') : amount ? `${amount} ${tokenSymbol}` : undefined;

  const feeText = useReceiptFeeText(transaction);

  return { tokenMetadata, tokenSymbol, amountText, feeText };
};

/** The success check, the same animated hero the Processing screen settles on. */
export const SuccessHero: FC = () => <TransactionHeroIcon state="success" />;

/** Emphasized amount block ("12 MDN") with an optional sub-line below it. */
export const SuccessAmountBlock: FC<{ amountText?: string; subline?: ReactNode }> = ({ amountText, subline }) => {
  if (!amountText) return null;

  return (
    <div className="mt-4 flex w-full flex-col items-center">
      <div className="font-heading text-center text-3xl font-bold leading-none text-pure-black">{amountText}</div>
      {subline}
    </div>
  );
};

/**
 * Hero summary pill under the title — "{amount} {symbol} → {recipient}" in a
 * rounded pill whose arrow carries the flow's colour (or a caller-provided
 * `separator` glyph, e.g. the earn up-arrow). Reuses the in-progress screen's
 * `TransactionSummaryBadge`, so it renders `null` when either side is missing.
 */
export const SuccessSummaryPill: FC<{
  lhs?: ReactNode;
  rhs?: ReactNode;
  separator?: ReactNode;
  /** The arrow's fill, as the badge content reports it — swap purple, receive green, send blue. */
  fillForArrow?: string;
}> = ({ lhs, rhs, separator, fillForArrow }) => (
  <TransactionSummaryBadge lhs={lhs} rhs={rhs} separator={separator} fillForArrow={fillForArrow} className="mt-1" />
);

/** Key/value receipt rows, as the shared compact details card. Renders nothing when there are no rows. */
export const ReceiptRows: FC<{ rows: ReceiptRow[]; className?: string }> = ({ rows, className }) => {
  if (rows.length === 0) return null;

  return (
    <DetailCard className={classNames('w-full', className)}>
      {rows.map(row => (
        <DetailRow key={row.label} label={row.label} sub={row.subValue} stacked={row.stacked}>
          {row.onClick ? (
            <button
              type="button"
              aria-label={row.actionLabel}
              onClick={row.onClick}
              // `accent-tint-ink` — same as `DetailRow`'s own inline action — is the
              // accent pair that actually clears 4.5:1 on `fill`; the flow's own
              // accent (e.g. `accent-send`) sat at ~2:1 here.
              className="min-w-0 bg-transparent p-0 text-right font-heading font-bold text-accent-tint-ink underline-offset-2 hover:underline"
            >
              {row.value}
            </button>
          ) : (
            row.value
          )}
        </DetailRow>
      ))}
    </DetailCard>
  );
};

// Every call passed the same layout classes, so they live here.
const FooterAction: FC<{ action: SuccessAction; accent: FlowAccent }> = ({ action, accent }) => (
  <Button
    type="button"
    variant={action.variant ?? ButtonVariant.Primary}
    accent={accent}
    title={action.label}
    onClick={action.onClick}
    className="w-full max-w-none"
  />
);

export interface TransactionSuccessLayoutProps {
  /** Header-bar title (e.g. "Success!"). */
  headerTitle: string;
  /** Large centered title (e.g. "Transaction Complete!"). */
  title: string;
  /** Custom hero artwork; defaults to the green check circle. */
  hero?: ReactNode;
  /**
   * The flow this receipt closes, so its CTA matches the pages that led here
   * (design-system.md, "Action colours"). Derive it with `accentForTransactionType`.
   */
  accent?: FlowAccent;
  /** Body content between the title and the footer (pill, amount block, rows). */
  children?: ReactNode;
  /** Paragraph shown above the footer buttons. */
  footerDescription?: ReactNode;
  /** Primary call to action. */
  primaryAction: SuccessAction;
  /** Optional secondary call to action. */
  secondaryAction?: SuccessAction;
  /** Render the secondary action above the primary one. */
  secondaryFirst?: boolean;
  /** Invoked by the header close button. */
  onClose: () => void;
}

export const TransactionSuccessLayout: FC<TransactionSuccessLayoutProps> = ({
  headerTitle,
  title,
  hero,
  accent = 'brand',
  children,
  footerDescription,
  primaryAction,
  secondaryAction,
  secondaryFirst = false,
  onClose
}) => {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // The success view owns the whole screen — keep the bottom tab navbar
  // hidden for as long as it's mounted (no-op on full-screen routes that
  // already render outside TabLayout).
  useHideNavbarWhileOpen();

  // The receipt replaces the in-progress view in place, after a delay, with no
  // navigation and no live region — so the outcome of the transaction the user
  // just authorized was never announced. The view they were on unmounts, which
  // drops focus to `<body>`; moving it to the title both names the new screen
  // and puts the user at the top of it. Same shape as PageHeader's
  // `focusTitleOnMount`, and this layout only ever mounts on that transition.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // One ordered list rather than a branch per arrangement: the order is the only difference.
  const ordered = secondaryAction
    ? secondaryFirst
      ? [secondaryAction, primaryAction]
      : [primaryAction, secondaryAction]
    : [primaryAction];
  const actions = ordered.map(action => <FooterAction key={action.label} action={action} accent={accent} />);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
      {/* The receipt replaces Processing in place, so it keeps the same frame: close top right, a
          title where Processing's was, the hero and heading below, the CTAs pinned to the bottom.
          Only the body scrolls on a short popup, so the CTAs stay reachable (#463). */}
      <FlowLayout
        title={headerTitle || t('success')}
        onClose={onClose}
        footer={
          <div className="flex w-full flex-col items-center gap-3">
            {footerDescription && <p className="text-center text-sm text-gray">{footerDescription}</p>}
            {actions}
          </div>
        }
      >
        <section className="flex w-full flex-col items-center pt-6">
          {/* The moment's heading and the focus target on the view change, so the outcome is
              announced. `tabIndex={-1}` makes it focusable without joining the tab order. */}
          <Hero visual={hero ?? <SuccessHero />} name={title} nameRef={titleRef} nameProps={{ tabIndex: -1 }} />

          {children}
        </section>
      </FlowLayout>
    </div>
  );
};
