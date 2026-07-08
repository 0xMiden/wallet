import { format } from 'date-fns';

import { getDateFnsLocale } from 'lib/i18n';
import { ITransaction, ITransactionType } from 'lib/miden/db/types';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { formatAmount } from 'lib/shared/format';

import { IHistoryEntry } from './IHistoryEntry';

/** Requested side of a swap transaction, persisted on `SwapTransaction.extraInputs`. */
interface SwapExtraInputs {
  requestedFaucetId?: string;
  requestedAmount?: bigint;
}

export interface SwapHistoryFields {
  /** Offered side, resolved against the DEX registry (correct symbol/decimals). */
  amount?: string;
  token?: string;
  /** Requested side — what the activity row shows on the right. */
  requestedAmount?: string;
  requestedToken?: string;
}

/**
 * Resolves both sides of a swap tx for history entries. The DEX token registry
 * is the source of truth for the fixed swap tokens — their faucets are usually
 * absent from wallet metadata, where `getTokenMetadata` would fall back to the
 * native asset — with wallet metadata as the fallback.
 */
export const resolveSwapHistoryFields = async (tx: ITransaction): Promise<SwapHistoryFields> => {
  const extra: SwapExtraInputs = tx.extraInputs ?? {};
  const offered = getSwapTokenByFaucetId(tx.faucetId) ?? (await getTokenMetadata(tx.faucetId ?? null));
  const requested =
    getSwapTokenByFaucetId(extra.requestedFaucetId) ?? (await getTokenMetadata(extra.requestedFaucetId ?? null));

  return {
    amount: tx.amount !== undefined ? formatAmount(tx.amount, offered.decimals) : undefined,
    token: offered.symbol,
    requestedAmount:
      extra.requestedAmount !== undefined ? formatAmount(extra.requestedAmount, requested.decimals) : undefined,
    requestedToken: requested.symbol
  };
};

export const isFaucetRequest = (entry: IHistoryEntry): boolean => {
  const midenFaucetId = getNativeAssetIdSync();
  if (!midenFaucetId) return false;
  return (
    entry.transactionIcon === 'RECEIVE' && entry.faucetId === midenFaucetId && entry.secondaryAddress === midenFaucetId
  );
};

export const fontColorForType = (type: ITransactionType): string => {
  return type === 'send' ? 'text-send-blue' : type === 'consume' ? 'text-receive-green' : TRANSACTION_COLORS.faucet;
};

export const TRANSACTION_COLORS = {
  send: '#91ACC1',
  receive: '#99AC94',
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
