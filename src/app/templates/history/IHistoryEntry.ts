import {
  IBridgeClaimStatus,
  IBridgeProvider,
  IBridgedReceivePhase,
  IEarnWithdrawPhase,
  ITransactionIcon,
  ITransactionStatus,
  ITransactionType
} from 'lib/miden/db/types';

export interface IHistoryEntry {
  key: string;
  address: string;
  timestamp: number;
  message: string;
  type: HistoryEntryType;
  txType: ITransactionType;

  // Optional properties
  /** Raw transaction status; set by the detail page for the status pill. */
  status?: ITransactionStatus;
  /** Failure reason (`tx.error`); set by the detail page for failed transactions. */
  errorMessage?: string;
  /** User-requested cancellation, persisted as a failed terminal transaction. */
  isCancelled?: boolean;
  token?: string;
  amount?: bigint;
  /** Swap only: formatted requested-side amount, shown on the row's right. */
  requestedAmount?: string;
  /** Swap only: requested-side token symbol. */
  requestedToken?: string;
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
  outputNoteIds?: string[];

  // `bridged-send` metadata (from `extraInputs`) for the activity detail view.
  bridgeProvider?: IBridgeProvider;
  bridgeDestinationAddress?: string;
  bridgeDestinationNetwork?: number;
  bridgeClaimStatus?: IBridgeClaimStatus;
  // Epoch (Fast) route: quoted destination output + intent-status tracking.
  bridgeOutputAmount?: string;
  bridgeOutputSymbol?: string;
  bridgeIntentNonce?: string;
  bridgeFillTxHash?: string;
  bridgeFillChainId?: number;
  bridgeEpochStatus?: 'pending' | 'confirmed' | 'failed';

  // `consume` rows that claimed a bridged-in (EVM → Miden) note render as
  // bridge rows instead of plain receives (see `bridgeInRowDisplay`).
  bridgeInProvider?: IBridgeProvider;
  bridgeInSourceAddress?: string;
  bridgeInSourceAmount?: string;
  bridgeInSourceSymbol?: string;
  bridgeInEvmTxHash?: string;
  bridgeInPhase?: IBridgedReceivePhase;
  bridgeInOutputAmount?: string;
  bridgeInOutputSymbol?: string;
  bridgeInMidenNoteId?: string;

  // `earn-withdraw` (Smart Withdraw) lifecycle phase, driving the row's status chip.
  earnWithdrawPhase?: IEarnWithdrawPhase;
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
