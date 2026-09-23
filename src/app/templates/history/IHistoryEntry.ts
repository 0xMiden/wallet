import {
  IBridgeClaimStatus,
  IBridgeProvider,
  IBridgedReceivePhase,
  IConsumeMidenNameExtraInputs,
  IConsumeMidenNameReturnExtraInputs,
  IPublishNameRecordExtraInputs,
  IEarnDepositExtraInputs,
  IEarnWithdrawPhase,
  INoteDeliveryState,
  IRegisterNameExtraInputs,
  ITransaction,
  ITransactionIcon,
  ITransactionStatus,
  ITransactionType,
  ISwitchGuardianExtraInputs
} from 'lib/miden/db/types';
import { formatMidenName } from 'lib/miden/name/encoding';

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
  /**
   * `tx.noteDelivery` — whether this send's private note reached the transport
   * layer. Read by the detail page to warn that a transaction which SUCCEEDED on
   * chain may still not be spendable by its recipient, since a private note is
   * unreachable without its relayed body. Absent for public sends and for rows
   * written before the field existed.
   */
  noteDelivery?: INoteDeliveryState;
  /**
   * `tx.processingStartedAt` — stamped atomically with the Queued →
   * GeneratingTransaction transition. The detail page's Retry gate reads it as
   * the double-send guard's "did this row ever execute?" signal: absent means the
   * failure is unambiguously pre-submit. Set by the detail page only.
   */
  processingStartedAt?: number;
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
  recipientName?: string;
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
  /**
   * Mirrors `ITransaction.restoredFromBackup`. Carried onto the entry so the
   * detail view can withhold affordances that turn a row back into work —
   * a restored row's note ids and amounts come from whoever wrote the dump.
   */
  restoredFromBackup?: boolean;

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

  /**
   * The Miden Name label (without `.miden`) of the row. Set on a `register-name`
   * row and on a `consume` row that claimed the name (`extraInputs.midenNameClaim`).
   * The row title then shows the name.
   */
  midenNameLabel?: string;
  /** Registration/publication whose name-NFA receipt this row completes. */
  midenNameParentTxId?: string;
  midenNameStatus?: 'pending' | 'confirmed' | 'failed';
  midenNameReceiptTxId?: string;
}

export function midenNameActivityOf(
  tx: Pick<ITransaction, 'type' | 'extraInputs'>
): Pick<IHistoryEntry, 'midenNameParentTxId' | 'midenNameStatus' | 'midenNameReceiptTxId'> {
  if (tx.type === 'consume') {
    const claim: Partial<IConsumeMidenNameExtraInputs> | undefined = tx.extraInputs;
    const returned: Partial<IConsumeMidenNameReturnExtraInputs> | undefined = tx.extraInputs;
    return { midenNameParentTxId: claim?.midenNameClaim?.registerTxId ?? returned?.midenNameReturn?.publishTxId };
  }
  if (tx.type === 'register-name' || tx.type === 'publish-name-record') {
    const inputs: Partial<IRegisterNameExtraInputs | IPublishNameRecordExtraInputs> | undefined = tx.extraInputs;
    const phase = inputs?.phase;
    const registration: Partial<IRegisterNameExtraInputs> | undefined = tx.extraInputs;
    const publication: Partial<IPublishNameRecordExtraInputs> | undefined = tx.extraInputs;
    return {
      midenNameReceiptTxId: tx.type === 'register-name' ? registration?.claimTxId : publication?.returnTxId,
      midenNameStatus: !phase
        ? undefined
        : phase === 'failed'
          ? 'failed'
          : phase === 'owned' || phase === 'done'
            ? 'confirmed'
            : 'pending'
    };
  }
  return {};
}

/**
 * The Miden Name label of a transaction row, for `IHistoryEntry.midenNameLabel`.
 * Returns undefined for all rows that are not a registration or a name claim.
 */
export function midenNameLabelOf(tx: Pick<ITransaction, 'type' | 'extraInputs'>): string | undefined {
  switch (tx.type) {
    case 'register-name': {
      const inputs: Partial<IRegisterNameExtraInputs> | undefined = tx.extraInputs;
      return inputs?.label || undefined;
    }
    case 'publish-name-record': {
      const inputs: Partial<IPublishNameRecordExtraInputs> | undefined = tx.extraInputs;
      return inputs?.label || undefined;
    }
    case 'consume': {
      const inputs: Partial<IConsumeMidenNameExtraInputs> | undefined = tx.extraInputs;
      const returnInputs: Partial<IConsumeMidenNameReturnExtraInputs> | undefined = tx.extraInputs;
      return inputs?.midenNameClaim?.label || returnInputs?.midenNameReturn?.label || undefined;
    }
    default:
      return undefined;
  }
}

/** True when the consume row takes back the NFA after a registry-record publish. */
export function isMidenNameReturnConsume(tx: Pick<ITransaction, 'type' | 'extraInputs'>): boolean {
  if (tx.type !== 'consume') return false;
  const inputs: Partial<IConsumeMidenNameReturnExtraInputs> | undefined = tx.extraInputs;
  return inputs?.midenNameReturn !== undefined;
}

/**
 * Title of a completed Miden Name row: "Registered alice.miden" for the
 * registration, "Received alice.miden" for the consume that claimed the name.
 * Returns undefined when the entry has no name. The caller decides which
 * states (completed, not failed) show this title.
 */
export function midenNameRowTitle(
  entry: Pick<IHistoryEntry, 'txType' | 'midenNameLabel'>,
  t: (key: string, options?: Record<string, unknown>) => string
): string | undefined {
  if (entry.midenNameLabel === undefined) return undefined;
  const name = formatMidenName(entry.midenNameLabel);
  switch (entry.txType) {
    case 'register-name':
      return t('historyRegisteredName', { name });
    case 'publish-name-record':
      return t('historyPublishedName', { name });
    case 'consume':
      return t('historyReceivedName', { name });
    default:
      return undefined;
  }
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

/** Fold successful NFA receipts into their loaded parent; never hide orphaned or failed receipts. */
export function reconcileMidenNameActivity(entries: IHistoryEntry[]): IHistoryEntry[] {
  const parents = new Set(
    entries
      .filter(entry => entry.txType === 'register-name' || entry.txType === 'publish-name-record')
      .map(entry => entry.txId)
  );
  return entries.filter(
    entry =>
      !(
        entry.txType === 'consume' &&
        entry.type === HistoryEntryType.CompletedTransaction &&
        entry.transactionIcon !== 'FAILED' &&
        !entry.isCancelled &&
        !entry.extraAmounts?.length &&
        entry.midenNameParentTxId &&
        parents.has(entry.midenNameParentTxId)
      )
  );
}
