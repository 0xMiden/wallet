import { ITransactionIcon } from 'lib/miden/db/types';

export interface IHistoryEntry {
  key: string;
  address: string;
  timestamp: number;
  message: string;
  type: HistoryEntryType;

  // Optional properties
  token?: string;
  amount?: string;
  secondaryAddress?: string;
  cancel?: () => Promise<void>;
  explorerLink?: string;
  transactionIcon?: ITransactionIcon;
  txId?: string;
  fee?: string;
  noteType?: string;
  noteId?: string;
  externalTxId?: string;
  faucetId?: string;
  blockNumber?: number;
}

/// The history entry type. For sorting purposes, the order matters. In a given transaction
/// within a given block, many entries can occur at the exact same timestamp (multiple notes sent and received).
/// Lower numbers are displayed as having happened before higher numbers -- e.g. a
/// record spent should sequentially happen before a record received in the same transaction.
export enum HistoryEntryType {
  PendingTransaction = 1,
  ProcessingTransaction = 2,
  CompletedTransaction = 3
}
