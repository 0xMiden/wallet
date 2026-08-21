import {
  IBridgeClaimStatus,
  IBridgeProvider,
  IBridgedReceivePhase,
  IEarnDepositExtraInputs,
  IEarnWithdrawPhase,
  ITransactionIcon,
  ITransactionStatus,
  ITransactionType,
  ISwitchGuardianExtraInputs
} from 'lib/miden/db/types';

/** A formatted secondary asset on a batch-consume row. */
export interface IHistoryExtraAmount {
  /** Source faucet — the only field guaranteed distinct between two entries. */
  faucetId: string;
  /**
   * Formatted display amount, or `undefined` when the faucet's decimals are not
   * known yet.
   *
   * A batch claim's secondary faucets are exactly the ones the wallet has never
   * held, so their metadata is often absent — and the unknown-token fallback
   * carries a *guessed* 6 decimals. Scaling an 18-decimal token by that renders
   * it 10^12 too large, which is indistinguishable from a correct number. When
   * the scale is unknown the asset is named and its amount withheld until
   * metadata resolves; a missing number is recoverable, a wrong one is not.
   */
  amount?: string;
  token: string;
}

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
  /**
   * Formatted for display, like `requestedAmount` below — every producer assigns
   * the result of `formatAmount`, so this is decimal-shifted text and NOT base
   * units. It was declared `bigint` behind an `as IHistoryEntry` cast at both
   * construction sites, which would have let a reader scale a money figure a
   * second time with no type error.
   */
  amount?: string;
  /**
   * Consume only: formatted totals of every OTHER asset in a batch claim, after
   * the primary `amount`/`token`, rendered inline after it. "10 A, 10 A, 10 B" →
   * amount "20", token "A", extraAmounts [{ amount: "10", token: "B" }].
   */
  extraAmounts?: IHistoryExtraAmount[];
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
  /** Input notes claimed by a `consume` row (every note in a batch claim). */
  consumedNoteIds?: string[];
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
