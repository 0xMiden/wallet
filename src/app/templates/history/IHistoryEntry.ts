import {
  IBridgeClaimStatus,
  IBridgeProvider,
  IBridgedReceivePhase,
  IBuyBridgeProgress,
  IEarnDepositExtraInputs,
  IEarnWithdrawPhase,
  ITransactionIcon,
  ITransactionStatus,
  ITransactionType,
  ISwitchGuardianExtraInputs
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
  /** Failure reason (`tx.error`); set for failed transactions. */
  errorMessage?: string;
  /** The untouched thrown error (`tx.rawError`), present when `errorMessage` is a friendly rewrite. */
  rawErrorMessage?: string;
  /** User-requested cancellation, persisted as a failed terminal transaction. */
  isCancelled?: boolean;
  token?: string;
  amount?: bigint;
  /** Swap only: formatted requested-side amount, shown on the row's right. */
  requestedAmount?: string;
  /** Swap only: requested-side token symbol. */
  requestedToken?: string;
  /**
   * Swap only: requested-side faucet id. A swap row appears in BOTH sides'
   * token-scoped histories (see `matchesTokenId` in `lib/miden/transaction/get.ts`),
   * so the row needs this to tell which side the scoped token is on.
   */
  requestedFaucetId?: string;
  /**
   * Swap only: settlement state of the order, driving the single swap row's
   * status chip. Absent (rendered Confirmed) once settled, and for legacy /
   * manual-claim orders.
   */
  swapSettlement?: 'pending' | 'reclaimed';
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

  // Guardian switch audit trail. The previous endpoint is absent on legacy rows.
  previousGuardianEndpoint?: ISwitchGuardianExtraInputs['previousGuardianEndpoint'];
  newGuardianEndpoint?: ISwitchGuardianExtraInputs['newGuardianEndpoint'];

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
  /** epoch: absolute Miden block after which a failed bridge's P2IDE note is reclaimable. */
  bridgeReclaimHeight?: number;

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

  // `buy` (fiat on-ramp) rows: Agglayer bridge hand-off state + display fields.
  buyBridgeProgress?: IBuyBridgeProgress;
  buySourceAmount?: string;
  buySourceSymbol?: string;
  buyEvmTxHash?: string;

  // `earn-withdraw` (Smart Withdraw) lifecycle phase, driving the row's status chip.
  earnWithdrawPhase?: IEarnWithdrawPhase;

  /**
   * `earn-deposit` (Smart Deposit): settlement of the solver-fulfilled Sepolia
   * lending leg (`extraInputs.epochStatus`). The row is database-Completed as
   * soon as the Miden collateral note lands, so this — not the transaction
   * status — is what the row's status chip must reflect.
   */
  earnDepositStatus?: IEarnDepositExtraInputs['epochStatus'];
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
