import { IBridgeProvider } from 'lib/miden/db/types';
import { truncateAddress, truncateHash } from 'utils/string';

import { ReceiptRow } from './TransactionSuccessLayout';

/** Narrow `t` signature — only the call shape these builders use. */
type TFn = (key: string, options?: { defaultValue?: string }) => string;

interface BuildReceiptRowsArgs {
  /** Recipient / destination address shown in the address row. */
  destinationAddress?: string;
  /** Label for the address row; defaults to "To" (consume receipts pass "From" — the note sender). */
  destinationLabel?: string;
  /** Formatted "amount symbol" shown in the amount row. */
  amountText?: string;
  /** Label for the amount row; defaults to "Total Paid" (consume receipts pass "Total Consumed"). */
  amountLabel?: string;
  /** Ids of the notes a consume claimed; rendered as a "Notes Consumed" row. */
  noteIds?: string[];
  /** On-chain hash shown in the "Transaction ID" row. */
  txHash?: string | null;
  /** When provided, the transaction-id value becomes a button. */
  onViewExplorer?: () => void;
  /** Formatted "amount symbol" for the network fee this transaction paid. */
  feeText?: string;
  /** Optional "Route" row value (e.g. "Slow"); bridge sends only. */
  route?: string;
  /** Optional sub-line under the "Route" value (e.g. "Via Epoch"). */
  routeSub?: string;
}

/**
 * Builds the shared key/value receipt rows for the amount-led success views.
 * Rows are appended only when their data exists, so the same builder serves a
 * minimal plain send, a fully-populated bridged send, and a consume/claim.
 * Order matches the design: To/From → Route → Total → Notes Consumed → Transaction ID.
 */
export const buildReceiptRows = (
  t: TFn,
  {
    destinationAddress,
    destinationLabel,
    amountText,
    amountLabel,
    noteIds,
    feeText,
    txHash,
    onViewExplorer,
    route,
    routeSub
  }: BuildReceiptRowsArgs
): ReceiptRow[] => {
  const rows: ReceiptRow[] = [];

  if (destinationAddress) {
    rows.push({
      label: destinationLabel ?? t('to'),
      value: truncateAddress(destinationAddress, true, 6, 4, 4)
    });
  }

  if (route) {
    rows.push({
      label: t('transactionRoute', { defaultValue: 'Route' }),
      value: route,
      subValue: routeSub
    });
  }

  if (amountText) {
    rows.push({
      label: amountLabel ?? t('totalPaid', { defaultValue: 'Total Paid' }),
      value: amountText
    });
  }

  // After the amount, before the transaction id: the fee is part of what the
  // transfer cost, not metadata about it. Omitted entirely on a zero-fee chain,
  // where an empty row would look like a failed read.
  if (feeText) {
    rows.push({
      label: t('networkFee'),
      value: feeText
    });
  }

  if (noteIds && noteIds.length > 0) {
    rows.push({
      label: t('notesConsumed', { defaultValue: 'Notes Consumed' }),
      value: noteIds.map(id => truncateHash(id, 6, 4)).join(', ')
    });
  }

  if (txHash) {
    rows.push({
      label: t('sourceTx', { defaultValue: 'Transaction ID' }),
      value: truncateHash(txHash, 6, 4),
      onClick: onViewExplorer,
      actionLabel: t('viewOnMidenscan')
    });
  }

  return rows;
};

/** Human label for the bridge "Route" row, by provider. */
export const bridgeRouteValue = (t: TFn, provider: IBridgeProvider): string =>
  provider === 'epoch'
    ? t('bridgeRouteViaEpoch', { defaultValue: 'Via Epoch' })
    : t('bridgeRouteViaAgglayer', { defaultValue: 'Via Agglayer' });

/** Human speed label used as the "Route" row value, by provider. */
export const bridgeSpeedLabel = (t: TFn, provider: IBridgeProvider): string =>
  provider === 'epoch'
    ? t('bridgeSpeedFast', { defaultValue: 'Fast' })
    : t('bridgeSpeedSlow', { defaultValue: 'Slow' });
