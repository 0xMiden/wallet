// Layout ideas for the Send success screen. Every piece is the production component; only the
// arrangement inside the layout differs. Nothing here ships: it exists to be looked at.
import React, { FC, ReactNode, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as InfoIcon } from '../../../src/app/icons/information.svg';
import { ButtonVariant } from '../../../src/components/Button';
import { accentForTransactionType } from '../../../src/components/flow/accent';
import { buildReceiptRows } from '../../../src/screens/generating-transaction/success/receipt';
import {
  ReceiptRows,
  SuccessAmountBlock,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps,
  useReceiptAmount,
  useReceiptFeeText
} from '../../../src/screens/generating-transaction/success/TransactionSuccessLayout';
import { formatAmountDisplay } from '../../../src/lib/i18n/amount-display';
import { useTransactionSummaryBadgeContent } from '../../../src/screens/generating-transaction/TransactionSummaryBadge';
import { truncateAddress } from '../../../src/utils/string';

export type IdeaVariant = 'today' | 'a' | 'b' | 'c' | 'r1' | 'r2' | 'r3' | 'r4' | 'l1' | 'l2' | 'r3b' | 'p1' | 'p2' | 'pa1' | 'pa2' | 'pa3' | 'pa4';

export const SendIdea: FC<TransactionSuccessProps & { variant: IdeaVariant }> = ({
  transaction,
  txHash,
  onDoneClick,
  onViewExplorer,
  variant
}) => {
  const { t } = useTranslation();
  const { amountText, feeText } = useReceiptAmount(transaction);
  const destinationAddress = transaction?.secondaryAccountId;
  const recipient = destinationAddress ? truncateAddress(destinationAddress, false, 8, 8) : undefined;
  const rows = useMemo(
    () => buildReceiptRows(t, { destinationAddress, amountText, feeText, txHash, onViewExplorer }),
    [amountText, destinationAddress, feeText, onViewExplorer, t, txHash]
  );
  // The amount as plain text for a sentence headline: the fixture's 25 USDCX.
  const amountLabel = '25 USDCX';
  const half = destinationAddress ? Math.ceil(destinationAddress.length / 2) : 0;
  const pill = <SuccessSummaryPill lhs={amountText} rhs={recipient} />;
  // The receipt's rows, re-aligned per idea. Today the address row alone is stacked and left-aligned.
  const toLabel = t('to');
  const shownRows =
    variant === 'r1' || variant === 'l2'
      ? rows.map(row => (row.label === toLabel ? { ...row, stacked: false, value: recipient } : row))
      : variant === 'r2'
        ? rows.map(row =>
            row.label === toLabel
              ? { ...row, stacked: false, value: <span className="break-all text-right">{destinationAddress}</span> }
              : row
          )
        : variant === 'r3' || variant === 'r3b' || variant === 'p2'
          ? rows.map(row => ({ ...row, stacked: true }))
          : variant === 'r4' || variant === 'l1' || variant === 'p1' || variant.startsWith('pa')
            ? rows.filter(row => row.label !== toLabel)
            : rows;
  const fullAddress = <p className="mt-2 w-full break-all text-center text-caption text-muted">{destinationAddress}</p>;
  const receipt = (
    <ReceiptRows
      rows={shownRows}
      surface="outline"
      face={variant === 'r3b' ? 'heading' : undefined}
      className={variant === 'c' ? '' : 'mt-6'}
    />
  );

  return (
    <TransactionSuccessLayout
      headerTitle=""
      accent={accentForTransactionType(transaction?.type)}
      // Proposed copy, written here in English only: the app's key still reads "Payment Sent!".
      title={variant === 'pa3' ? `You sent ${amountLabel}` : variant.startsWith('pa') ? 'You sent!' : t('paymentSent')}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{ label: t('viewInActivities'), onClick: () => undefined, variant: ButtonVariant.Secondary }}
      onClose={onDoneClick}
    >
      {variant === 'today' && (
        <>
          {pill}
          {receipt}
        </>
      )}
      {variant === 'a' && (
        <>
          <div className="mt-3 w-full">{pill}</div>
          {receipt}
        </>
      )}
      {variant === 'b' && (
        <>
          <SuccessAmountBlock
            amountText={amountText}
            subline={<p className="mt-2 text-body-sm text-muted">{`${t('to')} ${recipient ?? ''}`}</p>}
          />
          {receipt}
        </>
      )}
      {(variant === 'r1' || variant === 'r2' || variant === 'r3') && (
        <>
          {pill}
          {receipt}
        </>
      )}
      {variant === 'r4' && (
        <>
          {pill}
          {fullAddress}
          {receipt}
        </>
      )}
      {variant === 'l1' && (
        <>
          <SuccessAmountBlock amountText={<span className="text-ink">{amountText}</span>} subline={fullAddress} />
          {receipt}
        </>
      )}
      {variant === 'l2' && (
        <>
          <div className="mt-3 w-full">{pill}</div>
          {receipt}
        </>
      )}
      {variant === 'r3b' && (
        <>
          {pill}
          {receipt}
        </>
      )}
      {variant === 'p1' && (
        <>
          {/* Phantom's detail sheet: the counterparty is the headline, in full, on the left edge. */}
          <div className="mt-4 w-full text-left">
            <div className="text-body-sm text-muted">{toLabel}</div>
            <div className="mt-1 break-all font-heading text-xl font-extrabold leading-7 text-ink">{destinationAddress}</div>
          </div>
          {receipt}
        </>
      )}
      {variant === 'p2' && (
        <>
          {/* Phantom's review: one very large amount on the left edge, then label-over-value rows. */}
          <div className="mt-4 w-full text-left font-heading text-5xl font-extrabold leading-none text-ink">{amountText}</div>
          {receipt}
        </>
      )}
      {variant.startsWith('pa') && (
        <>
          <div className="mt-4 w-full text-left">
            <div className="text-body-sm text-muted">{toLabel}</div>
            {variant === 'pa1' && (
              // One line: the address shortened in the middle, at the headline size.
              <div className="mt-1 font-heading text-xl font-extrabold leading-7 text-ink">
                {destinationAddress ? truncateAddress(destinationAddress, false, 12, 10) : null}
              </div>
            )}
            {(variant === 'pa2' || variant === 'pa3') && (
              // One line: the full address at the rows' own value size.
              <div className="mt-1 text-value text-ink">{destinationAddress}</div>
            )}
            {variant === 'pa4' && (
              // Two even lines: the full address broken at its middle instead of where it overflows.
              <div className="mt-1 font-heading text-xl font-extrabold leading-7 text-ink">
                <div>{destinationAddress?.slice(0, half)}</div>
                <div>{destinationAddress?.slice(half)}</div>
              </div>
            )}
          </div>
          {receipt}
        </>
      )}
      {variant === 'c' && (
        <>
          <div className="mt-3 w-full">{pill}</div>
          <div className="mt-auto w-full pt-6">{receipt}</div>
        </>
      )}
    </TransactionSuccessLayout>
  );
};

export type SwapVariant = 'today' | 's1' | 's2' | 's3';

/** Swap success, rearranged three ways. The pill today cuts both token names short at phone width. */
export const SwapIdea: FC<TransactionSuccessProps & { variant: SwapVariant }> = ({ transaction, onDoneClick, variant }) => {
  const { t } = useTranslation();
  const badge = useTransactionSummaryBadgeContent(transaction);
  const feeText = useReceiptFeeText(transaction);
  // The fixture's two sides as plain text, at the scales the fixture's tokens state.
  const pays = `${formatAmountDisplay(transaction?.amount ?? 0n, { decimals: 6, rounding: 'down' })} USDCX`;
  const requested = BigInt(String(transaction?.extraInputs?.requestedAmount ?? 0));
  const receives = `${formatAmountDisplay(requested, { decimals: 18, rounding: 'down' })} Test iETH`;
  const note = t('swapOrderReservedNote', { amount: pays });
  const sourcing: ReactNode = (
    <>
      {t('swapSuccessSourcingLiquidity')}
      <br />
      {t('swapSuccessTrackProgress')}
    </>
  );
  const noteLine = (
    <div className="mt-6 flex w-full items-start gap-1.5 font-heading text-xs font-semibold text-ink">
      <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 fill-current" />
      <span>{note}</span>
    </div>
  );
  const feeRow = feeText ? [{ label: t('networkFee'), value: feeText }] : [];
  const grouped = variant === 's2' || variant === 's3';

  return (
    <TransactionSuccessLayout
      headerTitle=""
      accent={accentForTransactionType(transaction?.type)}
      title={t('swapOrderCreated')}
      footerDescription={grouped ? undefined : sourcing}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{ label: t('viewInActivities'), onClick: () => undefined, variant: ButtonVariant.Secondary }}
      onClose={onDoneClick}
    >
      {variant === 'today' && (
        <>
          {badge && <SuccessSummaryPill lhs={badge.lhs} rhs={badge.rhs} fillForArrow={badge.fillForArrow} />}
          <ReceiptRows rows={feeRow} className="mt-6" />
          {noteLine}
        </>
      )}
      {variant === 's1' && (
        <>
          {/* The pill's two sides on a line each, so neither name is cut. */}
          <div className="mt-3 flex w-full flex-col items-center gap-1 rounded-3xl bg-fill px-4 py-4 font-heading text-2xl font-extrabold text-ink">
            <span>{pays}</span>
            <span className="text-base text-muted" aria-hidden="true">
              ↓
            </span>
            <span>{receives}</span>
          </div>
          <ReceiptRows rows={feeRow} className="mt-6" />
          {noteLine}
        </>
      )}
      {variant === 's2' && (
        <>
          {/* No pill: both sides are rows of the one card, in full, with the fee. */}
          <ReceiptRows
            rows={[{ label: t('youPay'), value: pays }, { label: t('youReceive'), value: receives }, ...feeRow]}
            className="mt-6"
          />
          <p className="mt-4 w-full font-heading text-xs font-semibold text-muted">
            {note} {t('swapSuccessSourcingLiquidity')} {t('swapSuccessTrackProgress')}
          </p>
        </>
      )}
      {variant === 's3' && (
        <>
          {/* The pill kept on one line at a smaller size, and the two messages together under the card. */}
          <div className="mt-3 w-full">
            {badge && <SuccessSummaryPill lhs={badge.lhs} rhs={badge.rhs} fillForArrow={badge.fillForArrow} />}
          </div>
          <ReceiptRows rows={feeRow} className="mt-6" />
          <div className="mt-4 flex w-full flex-col gap-2 rounded-2xl bg-fill px-4 py-3 font-heading text-xs font-semibold text-ink">
            <span>{note}</span>
            <span className="text-muted">
              {t('swapSuccessSourcingLiquidity')} {t('swapSuccessTrackProgress')}
            </span>
          </div>
        </>
      )}
    </TransactionSuccessLayout>
  );
};
