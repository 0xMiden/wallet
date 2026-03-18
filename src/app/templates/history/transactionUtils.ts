import { format } from 'date-fns';

import { getDateFnsLocale } from 'lib/i18n';
import { MidenTokens, TOKEN_MAPPING } from 'lib/miden-chain/constants';
import { ITransactionType } from 'lib/miden/db/types';

import { IHistoryEntry } from './IHistoryEntry';

export const isFaucetRequest = (entry: IHistoryEntry): boolean => {
  const midenFaucetId = TOKEN_MAPPING[MidenTokens.Miden]?.faucetId;
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
  send: '#2E80C4',
  receive: '#1A9C52',
  faucet: '#777487'
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
