import { IBridgeProvider } from 'lib/miden/db/types';
import { truncateAddress, truncateHash } from 'utils/string';

import { ReceiptRow } from './TransactionSuccessLayout';

/** Narrow `t` signature — only the call shape these builders use. */
type TFn = (key: string, options?: { defaultValue?: string }) => string;

interface BuildReceiptRowsArgs {
  /** Recipient / destination address shown in the "To" row. */
  destinationAddress?: string;
  /** Formatted "amount symbol" shown in the "Total Paid" row. */
  amountText?: string;
  /** On-chain source hash shown in the "Source TX" row. */
  txHash?: string | null;
  /** When provided, the source-tx value becomes a button. */
  onViewExplorer?: () => void;
  /** Optional "Route" row value (e.g. "Via Epoch"); bridge sends only. */
  route?: string;
}

/**
 * Builds the shared key/value receipt rows for the amount-led success views.
 * Rows are appended only when their data exists, so the same builder serves a
 * minimal plain send and a fully-populated bridged send. Order matches the
 * design: To → Route → Total Paid → Source TX.
 */
export const buildReceiptRows = (
  t: TFn,
  { destinationAddress, amountText, txHash, onViewExplorer, route }: BuildReceiptRowsArgs
): ReceiptRow[] => {
  const rows: ReceiptRow[] = [];

  if (destinationAddress) {
    rows.push({
      label: t('to'),
      value: truncateAddress(destinationAddress, true, 6, 4, 4)
    });
  }

  if (route) {
    rows.push({
      label: t('transactionRoute', { defaultValue: 'Route' }),
      value: route
    });
  }

  if (amountText) {
    rows.push({
      label: t('totalPaid', { defaultValue: 'Total Paid' }),
      value: amountText
    });
  }

  if (txHash) {
    rows.push({
      label: t('sourceTx', { defaultValue: 'Source TX' }),
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

/** Arrival-speed badge shown next to "Arriving on Ethereum", by provider. */
export const bridgeSpeedBadge = (provider: IBridgeProvider): 'FAST' | 'SLOW' =>
  provider === 'epoch' ? 'FAST' : 'SLOW';
