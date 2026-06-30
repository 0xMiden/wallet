import React, { FC, ReactNode } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { ITransaction } from 'lib/miden/db/types';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';

/**
 * Shared presentational kit for the post-transaction success screens.
 *
 * The visual chrome (header, hero check, title, footer buttons) is identical
 * across every transaction type — only the body (summary pill, amount block,
 * receipt rows) and the footer copy/actions vary. Each per-type view
 * (`DefaultSuccess`, `BridgeSuccess`, future `SwapSuccess`/`EarnSuccess`)
 * composes these primitives rather than duplicating the layout. Mirrors the
 * `TransactionSummaryBadge` + `useTransactionSummaryBadgeContent` split used by
 * the in-progress screen.
 */

const SUCCESS_GREEN = '#009B50';
const SUCCESS_GREEN_ACCENT = '#0EAA51';

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
    className="flex size-[124px] items-center justify-center rounded-[34px] border-2 border-[#44B474]"
    style={{ backgroundColor: SUCCESS_GREEN }}
    aria-hidden="true"
  >
    <div
      className="flex size-[68px] items-center justify-center rounded-full"
      style={{ backgroundColor: SUCCESS_GREEN_ACCENT }}
    >
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M12 25.5L20.25 33.75L36 16.5"
          stroke="white"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  </div>
);

/** Full-width hairline shown under the title on the amount-led variants. */
export const SuccessDivider: FC = () => (
  <div className="mt-8 h-1 w-full max-w-[650px] rounded-full bg-[#EEEEF0]" />
);

/** Emphasized amount block ("12 MDN") with an optional sub-line below it. */
export const SuccessAmountBlock: FC<{ amountText?: string; subline?: ReactNode }> = ({ amountText, subline }) => {
  if (!amountText) return null;

  return (
    <div className="mt-10 flex w-full flex-col items-center">
      <div className="font-heading text-center text-[32px] font-bold leading-none text-heading-gray">{amountText}</div>
      {subline}
    </div>
  );
};

/** Key/value receipt rows. Renders nothing when there are no rows. */
export const ReceiptRows: FC<{ rows: ReceiptRow[]; className?: string }> = ({ rows, className }) => {
  if (rows.length === 0) return null;

  return (
    <div className={classNames('w-full', className)}>
      {rows.map((row, index) => (
        <div
          key={row.label}
          className={classNames(
            'flex min-h-[54px] items-center justify-between gap-4 py-3',
            index < rows.length - 1 && 'border-b border-[#E4E4E6]'
          )}
        >
          <span className="text-lg font-normal leading-tight text-[#8E8E93]">{row.label}</span>
          {row.onClick ? (
            <button
              type="button"
              aria-label={row.actionLabel}
              onClick={row.onClick}
              className="min-w-0 bg-transparent p-0 text-right text-lg font-bold leading-tight text-heading-gray underline-offset-2 hover:underline"
            >
              {row.value}
            </button>
          ) : (
            <span className="min-w-0 text-right text-lg font-bold leading-tight text-heading-gray">{row.value}</span>
          )}
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
  /** Body content between the title and the footer (pill, amount block, rows). */
  children?: ReactNode;
  /** Paragraph shown above the footer buttons. */
  footerDescription?: ReactNode;
  /** Primary call to action. */
  primaryAction: SuccessAction;
  /** Optional secondary call to action. */
  secondaryAction?: SuccessAction;
  /**
   * Footer button arrangement. `stacked` = primary on top, secondary below;
   * `row` = secondary left, primary right. Defaults to `stacked`.
   */
  actionsLayout?: 'stacked' | 'row';
  /** Invoked by the header close button. */
  onClose: () => void;
}

export const TransactionSuccessLayout: FC<TransactionSuccessLayoutProps> = ({
  headerTitle,
  title,
  children,
  footerDescription,
  primaryAction,
  secondaryAction,
  actionsLayout = 'stacked',
  onClose
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-app-bg px-4 text-heading-gray">
      <ScreenHeader title={headerTitle} closeLabel={t('close')} onClose={onClose} />

      <main className="flex min-h-0 flex-1 flex-col">
        <section className="flex flex-1 flex-col items-center px-3 pt-[94px]">
          <SuccessHero />

          <h2 className="mt-8 w-full text-center text-[32px] font-bold leading-[1.16] text-heading-gray">{title}</h2>

          {children}
        </section>

        <div className="w-full shrink-0 px-1 pt-10">
          {footerDescription && (
            <p className="mb-8 text-center text-lg font-normal leading-[1.28] text-heading-gray/70">
              {footerDescription}
            </p>
          )}

          {secondaryAction ? (
            actionsLayout === 'row' ? (
              <div className="flex w-full gap-3">
                <FooterAction action={secondaryAction} className="flex-1 max-w-none" />
                <FooterAction action={primaryAction} className="flex-1 max-w-none" />
              </div>
            ) : (
              <div className="flex w-full flex-col gap-3">
                <FooterAction action={primaryAction} className="w-full" />
                <FooterAction action={secondaryAction} className="w-full" />
              </div>
            )
          ) : (
            <FooterAction action={primaryAction} className="w-full" />
          )}
        </div>
      </main>
    </div>
  );
};
