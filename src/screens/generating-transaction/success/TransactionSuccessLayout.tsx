import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ReviewLabel } from 'components/review/ReviewRow';
import { ScreenHeader } from 'components/ScreenHeader';
import { ITransaction } from 'lib/miden/db/types';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';

import { TransactionSummaryBadge } from '../TransactionSummaryBadge';

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

const SUCCESS_HERO_BG = '#90BA89';

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
}

/** Resolves the token symbol + formatted amount for a transaction. */
export const useReceiptAmount = (transaction?: ITransaction) => {
  const assetsMetadata = useWalletStore(state => state.assetsMetadata) ?? {};

  const tokenMetadata = transaction?.faucetId ? assetsMetadata[transaction.faucetId] : undefined;
  const tokenSymbol = tokenMetadata?.symbol ?? MIDEN_METADATA.symbol ?? 'MDN';
  const amount =
    transaction?.amount !== undefined ? formatAmount(transaction.amount, tokenMetadata?.decimals) : undefined;
  const amountText = amount ? `${amount} ${tokenSymbol}` : undefined;

  return { tokenMetadata, tokenSymbol, amountText };
};

export const SuccessHero: FC = () => (
  <div
    className="flex size-30 items-center justify-center rounded-full"
    style={{ backgroundColor: SUCCESS_HERO_BG }}
    aria-hidden="true"
  >
    <svg width="57" height="43" viewBox="0 0 57 43" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M50.3513 6.00879L19.8658 36.4943L6.00879 22.6372"
        stroke="white"
        stroke-width="12.0176"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </div>
);

/** Full-width hairline shown under the title on the amount-led variants. */
export const SuccessDivider: FC = () => <div className="mt-6 h-1 w-full rounded-xs bg-[#F2F2F4]" />;

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
 * rounded pill with the blue-circle arrow. Reuses the in-progress screen's
 * `TransactionSummaryBadge`, so it renders `null` when either side is missing.
 */
export const SuccessSummaryPill: FC<{ lhs?: ReactNode; rhs?: ReactNode }> = ({ lhs, rhs }) => (
  <TransactionSummaryBadge lhs={lhs} rhs={rhs} className="mt-1" />
);

/**
 * Key/value receipt rows. The label is the shared grey `ReviewLabel` pill; the
 * value is right-aligned and bold, with an optional smaller sub-line beneath it.
 * Renders nothing when there are no rows.
 */
export const ReceiptRows: FC<{ rows: ReceiptRow[]; className?: string }> = ({ rows, className }) => {
  if (rows.length === 0) return null;

  return (
    <div className={classNames('w-full', className)}>
      {rows.map((row, index) => (
        <div
          key={row.label}
          className={classNames(
            'flex items-center justify-between gap-3 py-5',
            index < rows.length - 1 && 'border-b border-[#00000014]'
          )}
        >
          <ReviewLabel>{row.label}</ReviewLabel>
          <div className="flex min-w-0 flex-col items-end text-right">
            {row.onClick ? (
              <button
                type="button"
                aria-label={row.actionLabel}
                onClick={row.onClick}
                className="min-w-0 bg-transparent p-0 font-heading text-base font-bold leading-tight text-heading-gray underline-offset-2 hover:underline"
              >
                {row.value}
              </button>
            ) : (
              <span className="min-w-0 font-heading text-base font-bold leading-tight text-heading-gray">
                {row.value}
              </span>
            )}
            {row.subValue && <span className="mt-1 text-xs font-normal text-gray-secondary">{row.subValue}</span>}
          </div>
        </div>
      ))}
    </div>
  );
};

const FooterAction: FC<{ action: SuccessAction; className?: string }> = ({ action, className }) => (
  <Button
    type="button"
    variant={action.variant ?? ButtonVariant.Primary}
    title={action.label}
    onClick={action.onClick}
    className={className}
  />
);

export interface TransactionSuccessLayoutProps {
  /** Header-bar title (e.g. "Success!"). */
  headerTitle: string;
  /** Large centered title (e.g. "Transaction Complete!"). */
  title: string;
  /** Custom hero artwork; defaults to the green check circle. */
  hero?: ReactNode;
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
  children,
  footerDescription,
  primaryAction,
  secondaryAction,
  secondaryFirst = false,
  onClose
}) => {
  const { t } = useTranslation();

  // The success view owns the whole screen — keep the bottom tab navbar
  // hidden for as long as it's mounted (no-op on full-screen routes that
  // already render outside TabLayout).
  useHideNavbarWhileOpen();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg px-4 text-heading-gray">
      <ScreenHeader className="shrink-0" title={headerTitle} closeLabel={t('close')} onClose={onClose} />

      {/* Scroll region: only the receipt body scrolls when the popup is short, so
          the footer CTAs below stay pinned and fully reachable (#463). */}
      <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-3 pt-6">
        {hero ?? <SuccessHero />}

        <h2 className="mt-6 w-full text-center text-[2rem] font-heading font-bold text-heading-gray">{title}</h2>

        {children}
      </main>

      <div className="w-full shrink-0 px-1 pb-4 pt-6 flex flex-col items-center justify-center">
        {footerDescription && <p className="mb-4 text-center text-base font-normal  text-gray">{footerDescription}</p>}

        {secondaryAction ? (
          <div className="flex w-full flex-col gap-3 items-center justify-between">
            {secondaryFirst ? (
              <>
                <FooterAction action={secondaryAction} className="w-full" />
                <FooterAction action={primaryAction} className="w-full" />
              </>
            ) : (
              <>
                <FooterAction action={primaryAction} className="w-full" />
                <FooterAction action={secondaryAction} className="w-full" />
              </>
            )}
          </div>
        ) : (
          <FooterAction action={primaryAction} className="w-full" />
        )}
      </div>
    </div>
  );
};
