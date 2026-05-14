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
