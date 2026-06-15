import { format } from 'date-fns';

import { getDateFnsLocale } from 'lib/i18n';
import { ITransactionType } from 'lib/miden/db/types';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';

import { IHistoryEntry } from './IHistoryEntry';

export const isFaucetRequest = (entry: IHistoryEntry): boolean => {
  const midenFaucetId = getNativeAssetIdSync();
  if (!midenFaucetId) return false;
  return (
    entry.transactionIcon === 'RECEIVE' && entry.faucetId === midenFaucetId && entry.secondaryAddress === midenFaucetId
  );
};

export const isCompletedTransaction = (message: string): boolean => {
  return message === 'Sent' || message === 'Received' || message === 'Reclaimed' || message === 'Executed';
};

/**
 * Round a bridge's (USDC) destination output to 2 decimals for display. The
 * stored value is full 18-decimal precision; the row + detail only ever show 2.
 * Passes non-numeric input through unchanged.
 */
export const formatBridgeOutputAmount = (amount: string | undefined): string | undefined => {
  if (amount === undefined) return undefined;
  const n = Number(amount);
  return Number.isFinite(n) ? n.toFixed(2) : amount;
};

export type BridgeStatus = 'pending' | 'confirmed' | 'failed';

/**
 * Normalize a `bridged-send` row to a single Pending/Confirmed/Failed status
 * across both routes: Agglayer derives it from the L1 claim lifecycle, Epoch from
 * the polled intent fill status.
 */
export const bridgeStatusOf = (entry: IHistoryEntry): BridgeStatus => {
  if (entry.bridgeProvider === 'agglayer') {
    if (entry.bridgeClaimStatus === 'claimed') return 'confirmed';
    if (entry.bridgeClaimStatus === 'failed') return 'failed';
    return 'pending';
  }
  return entry.bridgeEpochStatus ?? 'pending';
};

/** i18n key for each bridge status (shared by the summary row + full Activity row). */
export const BRIDGE_STATUS_LABEL_KEY: Record<BridgeStatus, string> = {
  pending: 'pending',
  confirmed: 'confirmed',
  failed: 'bridgeFailed'
};

export interface BridgeRowDisplay {
  inSymbol: string;
  outSymbol: string;
  /** Quoted destination output (2dp), falling back to the input amount for legacy/in-flight rows. */
  outAmount?: string;
  providerLabel: string;
  network: string;
  status: BridgeStatus;
}

/**
 * Shared display fields for a `bridged-send` activity entry, so the summary row
 * (`HistoryItem`) and the full Activity row (`HistoryView` → `ActivityRow`) render
 * identically: "Bridge IN → OUT", "Via <provider> → <network>", output amount, status.
 */
export const bridgeRowDisplay = (entry: IHistoryEntry): BridgeRowDisplay => {
  const inSymbol = entry.token ?? '—';
  const outSymbol = entry.bridgeOutputSymbol ?? (entry.bridgeProvider === 'agglayer' ? 'ETH' : 'USDC');
  const outAmount = formatBridgeOutputAmount(entry.bridgeOutputAmount) ?? entry.amount?.toString();
  const providerLabel =
    entry.bridgeProvider === 'agglayer' ? 'Agglayer' : entry.bridgeProvider === 'epoch' ? 'Epoch' : 'Bridge';
  return { inSymbol, outSymbol, outAmount, providerLabel, network: 'Sepolia', status: bridgeStatusOf(entry) };
};

/** `consume` rows that claimed a bridged-in (EVM → Miden) note render as bridge rows. */
export const isBridgeInEntry = (entry: IHistoryEntry): boolean =>
  entry.txType === 'consume' && entry.bridgeInProvider !== undefined;

/**
 * Display fields for a bridge-in `consume` entry, mirroring `bridgeRowDisplay`
 * with the direction flipped: EVM-side input token → Miden token received. The
 * row is only tagged once the consume is on-chain-final, so status is always
 * confirmed.
 */
export const bridgeInRowDisplay = (entry: IHistoryEntry): BridgeRowDisplay => {
  const inSymbol = entry.bridgeInSourceSymbol ?? 'USDC';
  const outSymbol = entry.token ?? '—';
  const outAmount = entry.amount?.toString();
  const providerLabel = entry.bridgeInProvider === 'agglayer' ? 'Agglayer' : 'Epoch';
  return { inSymbol, outSymbol, outAmount, providerLabel, network: 'Sepolia', status: 'confirmed' };
};

export const fontColorForType = (type: ITransactionType): string => {
  return type === 'send' ? 'text-send-blue' : type === 'consume' ? 'text-receive-green' : TRANSACTION_COLORS.faucet;
};

export const TRANSACTION_COLORS = {
  send: '#024073',
  receive: '#38824A',
  faucet: '#891DB1'
} as const;

export const formatDate = (timestamp: number | string): string => {
  let date: Date;

  if (typeof timestamp === 'number') {
    date = new Date(timestamp * 1000);
  } else if (typeof timestamp === 'string') {
    const numericTimestamp = parseFloat(timestamp);
    if (!isNaN(numericTimestamp)) {
      date = new Date(numericTimestamp * 1000);
    } else {
      date = new Date(timestamp);
    }
  } else {
    return 'Invalid Date';
  }

  if (isNaN(date.getTime())) {
    return 'Invalid Date';
  }

  return format(date, 'dd MMM yyyy, HH:mm', { locale: getDateFnsLocale() });
};
