import { v4 as uuid } from 'uuid';

import { ConsumableNote, NoteType } from '../types';

export interface IInputNote {
  noteId: string;
  noteBytes: Uint8Array;
}

export enum ITransactionStatus {
  Queued,
  GeneratingTransaction,
  Completed,
  Failed
}

export type ITransactionIcon = 'SEND' | 'RECEIVE' | 'SWAP' | 'FAILED' | 'MINT' | 'DEFAULT';
export type ITransactionType =
  | 'send'
  | 'consume'
  | 'execute'
  | 'bridged-send'
  | 'bridged-receive'
  | 'earn-deposit'
  | 'earn-withdraw'
  | 'switch-guardian'
  | 'replace-hot-key'
  | 'swap'
  | 'update-procedure-threshold';

/** Which cross-chain bridge route a `bridged-send` used. */
export type IBridgeProvider = 'epoch' | 'agglayer';

/** Lifecycle of a tracking-only EVM → Miden bridge row. */
export type IBridgedReceivePhase = 'submitting' | 'delivering' | 'ready' | 'received' | 'failed';

/** One faucet's summed amount inside a batch consume. */
export interface IConsumedAssetTotal {
  faucetId: string;
  amount: bigint;
}

/** Metadata persisted on a tracking-only EVM → Miden bridge row. */
export interface IBridgedReceiveExtraInputs {
  provider: IBridgeProvider;
  /** Connected EVM account that funded the bridge. */
  sourceAddress: string;
  /** Human-readable source-chain input, retained even if the Miden output differs. */
  sourceAmount: string;
  sourceSymbol: string;
  phase: IBridgedReceivePhase;
  /** Expected destination output shown until the real note is consumed. */
  outputAmount?: string;
  outputSymbol?: string;
  evmTxHash?: string;
  intentNonce?: string;
  midenNoteId?: string;
  error?: string;
}

/** Audit metadata for a Guardian operator switch. `previousGuardianEndpoint`
 * is optional so rows created before the audit trail remain readable. */
export interface ISwitchGuardianExtraInputs {
  previousGuardianEndpoint?: string;
  newGuardianEndpoint: string;
}

/**
 * Lifecycle of the EVM-side claim for a `bridged-send`. Epoch (Fast) auto-settles
 * on the destination chain, so it is `'not-applicable'`. Agglayer (Slow) requires
 * the recipient to claim on L1: it starts `'pending'`, flips to `'ready'` once the
 * deposit is claimable, then `'claiming'` → `'claimed'` (or `'failed'`).
 */
export type IBridgeClaimStatus = 'not-applicable' | 'pending' | 'ready' | 'claiming' | 'claimed' | 'failed';

/** `extraInputs` shape for a `BridgedSendTransaction`. */
export interface IBridgedSendExtraInputs {
  provider: IBridgeProvider;
  /** 0x EVM recipient. */
  destinationAddress: string;
  /** EVM destination network: `EVM_AGGLAYER_NETWORK_ID` (agglayer) or chain id (epoch). */
  destinationNetwork: number;
  /** Miden faucet the bridged asset was sourced from. */
  sourceFaucetId: string;
  claimStatus: IBridgeClaimStatus;
  /** agglayer: a deposit to `destinationAddress` is claimable on L1. */
  depositReady?: boolean;
  /** agglayer: L1 claim tx hash once claimed. */
  claimTxHash?: string;
  /** epoch: solver/intent hash (informational). */
  evmTxHash?: string;
  /**
   * epoch: blocks-until-reclaim for the send-style P2IDE bridge note. Read by
   * `sendTransaction` (its presence makes the note a recallable P2IDE).
   */
  recallBlocks?: number;
  /**
   * epoch: absolute Miden block after which the P2IDE bridge note becomes
   * reclaimable by the sender. Recorded when the row is demoted to Failed so the
   * activity detail can gate the "Reclaim funds" affordance.
   */
  reclaimHeight?: number;
  /**
   * epoch: intent nonce (SIO `userAddress:intentNonce`) used to poll
   * `getIntentStatus` for the receiving-chain fill, captured at send time.
   */
  intentNonce?: string;
  /** epoch: quoted destination output amount (human-formatted) for the activity hero. */
  outputAmount?: string;
  /** epoch: destination output token symbol (e.g. `USDC`). */
  outputSymbol?: string;
  /** epoch: receiving-chain (destination EVM) settlement tx hash, once the intent fills. */
  fillTxHash?: string;
  /** epoch: chain id the fill tx landed on (drives the destination explorer link). */
  fillChainId?: number;
  /** epoch: settlement status derived from polling `getIntentStatus`. */
  epochStatus?: 'pending' | 'confirmed' | 'failed';
}

/**
 * `extraInputs` shape for an `EarnDepositTransaction`. Opening an Epoch lending
 * position spends Miden-held collateral by sending a recallable P2IDE note to the
 * solver's allocator (same mechanics as an Epoch `bridged-send`), while the EVM
 * lending leg is solver-fulfilled — so there is no manual claim. The typed EVM
 * address is the position owner / intent sponsor.
 */
export interface IEarnDepositExtraInputs {
  /** 0x EVM address that owns the resulting lending position (intent sponsor). */
  evmRecipient: string;
  /** Epoch market identifier (`PROTOCOL:chainId:token`) the deposit targets. */
  marketUid: string;
  /** Miden faucet the deposited collateral was sourced from. */
  sourceFaucetId: string;
  /** blocks-until-reclaim for the P2IDE note — its presence makes the note recallable. */
  recallBlocks?: number;
  /** intent nonce (SIO `userAddress:intentNonce`) used to poll `getIntentStatus`. */
  intentNonce?: string;
  /** solver/intent hash (informational). */
  evmTxHash?: string;
  /** quoted destination deposit size (human-formatted) for the activity detail. */
  outputAmount?: string;
  /** destination token symbol (e.g. `USDC`). */
  outputSymbol?: string;
  /** settlement status derived from polling `getIntentStatus`. */
  epochStatus?: 'pending' | 'confirmed' | 'failed';
}

/**
 * Lifecycle of an `earn-withdraw` row. The row is born `Completed` (never enters
 * the prove/submit FIFO loop — see `EarnWithdrawTransaction`); its in-flight look
 * comes entirely from this phase, mirroring `bridged-send`'s `epochStatus` chip.
 *   - redeeming  : row created, the gasless withdraw+swap+bridge intent is in flight
 *   - delivering : the Epoch intent settled; the bridged note is on its way to Miden
 *   - received   : the bridged note was auto-consumed; `outputAmount` patched from it
 *   - failed     : the intent failed / expired, or the row was reconciled dead
 */
export type IEarnWithdrawPhase = 'redeeming' | 'delivering' | 'received' | 'failed';

/**
 * `extraInputs` shape for an `EarnWithdrawTransaction`. Smart Withdraw redeems an
 * Epoch lending position and bridges the underlying back to Miden as a single
 * gasless intent (`sdk.helpers.executeActions`), so there is no Miden-side note to
 * prove/submit — the row is a tracking-only record whose lifecycle lives in `phase`.
 */
export interface IEarnWithdrawExtraInputs {
  /** 0x EVM address that owned the redeemed lending position (intent sponsor). */
  evmOwner: string;
  /** Epoch market identifier (`PROTOCOL:chainId:token`) the withdrawal redeemed. */
  marketUid: string;
  /** Miden faucet the bridged funds land on (destination asset). */
  destinationFaucetId: string;
  /** Human-decimal amount the user asked to withdraw (source side). */
  sourceAmount: string;
  /** Source token symbol (e.g. `USDC`). */
  sourceSymbol: string;
  phase: IEarnWithdrawPhase;
  /** intent nonce (SIO `userAddress:intentNonce`) used to poll `getIntentStatus`. */
  withdrawIntentNonce?: string;
  /** solver/settlement EVM tx hash, once known. */
  evmTxHash?: string;
  /** Miden note id of the bridged-in note, once it lands and is consumed. */
  midenNoteId?: string;
  /** actual bridged amount (human-formatted) from the consumed note. */
  outputAmount?: string;
  /** destination token symbol of the consumed note. */
  outputSymbol?: string;
  /** failure reason, set alongside `phase === 'failed'`. */
  error?: string;
}

/**
 * Bridge-in (EVM → Miden) metadata attached to the `consume` row that claimed
 * the bridged note. Epoch auto-consumes the note, so that consume row is the
 * only Miden-side trace of the deposit — tagging it lets the activity views
 * render it as a bridge row instead of a plain receive.
 */
export interface IBridgeInInfo {
  provider: IBridgeProvider;
  /** Human-readable EVM-side input amount the user deposited. */
  sourceAmount?: string;
  /** EVM-side input token symbol (e.g. USDC). */
  sourceSymbol?: string;
  /** epoch: intent nonce (SIO `userAddress:intentNonce`) of the originating intent. */
  intentNonce?: string;
  /** EVM-side deposit/fill tx hash, when known. */
  evmTxHash?: string;
  /** Miden-side note id the bridge-in resolved to, copied on by `takeBridgeInInfoForNotes`. */
  midenNoteId?: string;
  /**
   * When the bridged note originates from a Smart Withdraw, the `earn-withdraw`
   * row id it belongs to. On consume, that row is patched to `received` and this
   * consume row is suppressed from the activity list (the withdraw row is the
   * single trace). Absent for plain EVM→Miden deposits.
   */
  earnWithdrawTxId?: string;
  /** Tracking-only `bridged-receive` row this consumed note completes. */
  bridgeReceiveTxId?: string;
}

/** `extraInputs` shape for a `consume` row that claimed a bridged-in note. */
export interface IConsumeBridgeInExtraInputs {
  bridgeIn: IBridgeInInfo;
}

/**
 * `extraInputs` shape for a `consume` row queued by swap settlement
 * (`reconcileSwapOrderNotes`). History suppresses these rows while the linked
 * swap row exists — the swap row is the single trace of the whole order.
 */
export interface IConsumeSwapSettleExtraInputs {
  /** The `SwapTransaction.id` whose order this consume settles. */
  swapOrderTxId: string;
  /** Payback claim on fill vs. expiry-driven reclaim of the remaining tip. */
  swapSettleKind: 'settle' | 'reclaim';
}

/**
 * Sub-phase of a transaction while `status === GeneratingTransaction` (or
 * still `Queued` during the initial sync). Drives the modal's per-stage
 * label so users see what the wallet is actually doing during the 3-8s
 * spinner window. Not all stages apply to all tx types:
 *   - syncing              : all types, before `syncState()`
 *   - sending              : legacy broad SDK execute→prove→submit→apply span
 *   - creating-proposal    : Guardian only, while building the multisig proposal
 *   - signing-proposal     : Guardian only, while the guardian signs the proposal
 *   - executing            : Guardian only, while executing the signed request
 *   - proving              : Guardian only, while proving the executed transaction
 *   - submitting           : Guardian only, while submitting the proven transaction
 *   - confirming           : send-private + switch-guardian, during `waitForTransactionCommit`
 *   - registering-guardian : switch-guardian only, during post-commit guardian re-registration
 *   - delivering           : send-private only, during `sendPrivateNote`
 *   - guardian-syncing     : Guardian only, while syncing guardian state after submission
 *   - complete             : final stage marker before/at terminal status
 */
export type ITransactionStage =
  | 'syncing'
  | 'sending'
  | 'creating-proposal'
  | 'signing-proposal'
  | 'executing'
  | 'proving'
  | 'submitting'
  | 'confirming'
  | 'registering-guardian'
  | 'delivering'
  | 'guardian-syncing'
  | 'guardian-synced'
  | 'complete';

export interface ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount?: bigint;
  delegateTransaction?: boolean;
  secondaryAccountId?: string;
  faucetId?: string;
  noteId?: string;
  /** All note ids for batch consume transactions (noteId is the first) */
  noteIds?: string[];
  noteType?: NoteType;
  /** Consume only: per-faucet totals of a batch claim (see `ConsumeTransaction`). */
  assetTotals?: IConsumedAssetTotal[];
  transactionId?: string;
  requestBytes?: Uint8Array;
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  inputNoteIds?: string[];
  outputNoteIds?: string[];
  extraInputs?: any;
  /** User-facing failure reason (possibly a friendly rewrite — see `rawError`). */
  error?: string;
  /** The untouched thrown error, kept when `error` was rewritten to a friendlier message. */
  rawError?: string;
  resultBytes?: Uint8Array;
  /**
   * Current sub-phase during active processing. Readers should treat this
   * as informational only — it is overwritten without coordination with
   * `status`, and is stale once `status` reaches `Completed`/`Failed`.
   */
  stage?: ITransactionStage;
  /**
   * Earliest time (unix seconds) this Queued tx may be re-selected by the
   * processing loop. Set when a transient guardian pending-delta 409 requeues
   * the tx, so a persistently-conflicting op backs off and yields its slot to
   * other accounts instead of being re-picked every cycle as the oldest row
   * (head-of-line starvation). Absent ⇒ always eligible (backward compatible);
   * `MAX_QUEUED_AGE` remains the terminal cap.
   */
  nextEligibleAt?: number;
}

export interface ISuccessTransactionOutput {
  txHash: string;
  outputNotes: string[];
}
export interface IFailedTransactionOutput {
  errorMessage: string;
}

export type TransactionOutput = ISuccessTransactionOutput | IFailedTransactionOutput;

export class Transaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount?: bigint;
  noteType?: NoteType;
  delegateTransaction?: boolean;
  secondaryAccountId?: string;
  transactionId?: string;
  requestBytes?: Uint8Array;
  inputNoteIds?: string[];
  outputNoteIds?: string[];
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;

  constructor(
    accountId: string,
    requestBytes: Uint8Array,
    inputNoteIds?: string[],
    delegateTransaction?: boolean,
    recipientAccountId?: string
  ) {
    this.id = uuid();
    this.type = 'execute';
    this.accountId = accountId;
    this.requestBytes = requestBytes;
    this.inputNoteIds = inputNoteIds;
    this.delegateTransaction = delegateTransaction;
    this.secondaryAccountId = recipientAccountId;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'DEFAULT';
    this.displayMessage = 'Executing';
  }
}

export class SendTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount: bigint;
  secondaryAccountId: string;
  faucetId: string;
  noteType: NoteType;
  transactionId?: string;
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  delegateTransaction?: boolean;
  extraInputs: { recallBlocks?: number } = {
    recallBlocks: undefined
  };

  constructor(
    accountId: string,
    amount: bigint,
    recipientId: string,
    faucetId: string,
    noteType: NoteType,
    recallBlocks?: number,
    delegateTransaction?: boolean
  ) {
    this.id = uuid();
    this.type = 'send';
    this.accountId = accountId;
    this.amount = amount;
    this.secondaryAccountId = recipientId;
    this.faucetId = faucetId;
    this.noteType = noteType;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'SEND';
    this.displayMessage = 'Sending';
    this.extraInputs.recallBlocks = recallBlocks;
    this.delegateTransaction = delegateTransaction;
  }
}

export class ConsumeTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount?: bigint;
  /** First note id — kept for back-compat (dedup index, single-note readers) */
  noteId: string;
  /** Every note consumed by this transaction (batch claims consume many in one tx) */
  noteIds: string[];
  secondaryAccountId?: string;
  faucetId: string;
  /** Storage mode of the consumed note(s); unset when unknown or when a batch mixes modes. */
  noteType?: NoteType;
  /**
   * Per-faucet totals for a batch claim, in first-seen order. `amount`/`faucetId`
   * above only cover the first note's faucet, so a mixed batch (10 A, 10 A, 10 B)
   * needs this to display "+20 A, +10 B". Absent on legacy rows.
   *
   * At queue time this is an estimate: a `ConsumableNote` carries only the first
   * fungible asset of its note, so a note holding two assets contributes one.
   * `completeConsumeTransaction` recomputes it from the executed transaction,
   * where every asset of every note is visible. The estimate does survive on a
   * row completed by `tryCompleteKilledConsume`, which has no transaction result
   * to recompute from.
   */
  assetTotals?: IConsumedAssetTotal[];
  transactionId?: string;
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  delegateTransaction?: boolean;

  // There is deliberately no background/user-initiated distinction here anymore:
  // it only existed so Guardian auto-consume could be cold-signed while the iOS
  // hot key was Face-ID-gated (`.userPresence`). Hot signing is silent again, so
  // every consume signs the same way. Old persisted rows may still carry a stray
  // `background` property; it's ignored.
  constructor(accountId: string, notes: ConsumableNote | ConsumableNote[], delegateTransaction?: boolean) {
    const list = Array.isArray(notes) ? notes : [notes];
    const first = list[0];
    if (!first) {
      throw new Error('ConsumeTransaction requires at least one note');
    }
    this.id = uuid();
    this.type = 'consume';
    this.accountId = accountId;
    this.noteId = first.id;
    this.noteIds = list.map(n => n.id);
    this.faucetId = first.faucetId;
    this.secondaryAccountId = first.senderAddress;
    // Surface the note type in history only when it is known and uniform
    // across the batch — a mixed private/public claim has no single answer.
    this.noteType = first.type !== 'unknown' && list.every(n => n.type === first.type) ? first.type : undefined;
    // Keyed rather than scanned: a Claim All is uncapped, and anyone can send the
    // account notes, so the batch length is not ours to bound.
    const totals = new Map<string, bigint>();
    for (const note of list) {
      if (note.amount === '') continue;
      totals.set(note.faucetId, (totals.get(note.faucetId) ?? 0n) + BigInt(note.amount));
    }
    // Display amount: sum of the notes sharing the first note's faucet. Notes of
    // other faucets in a mixed batch aren't reflected here (display only). Read
    // off the same map rather than re-scanning, so the headline amount can never
    // disagree with its own entry in `assetTotals`.
    this.amount = first.amount !== '' ? totals.get(first.faucetId) : undefined;
    // A note with no faucet has no identifiable asset, so it can carry a headline
    // amount but never its own per-faucet total.
    const identifiedTotals = Array.from(totals, ([faucetId, amount]) => ({ faucetId, amount })).filter(
      total => total.faucetId !== ''
    );
    this.assetTotals = identifiedTotals.length > 0 ? identifiedTotals : undefined;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'RECEIVE';
    this.displayMessage = 'Consuming';
    this.delegateTransaction = delegateTransaction;
  }
}

/**
 * Requested side of a swap, persisted on `SwapTransaction.extraInputs`.
 *
 * `orderId` is strictly output info (the PSWAP lineage id resolved by
 * `completeSwapTransaction`) rather than an input, but it rides here to avoid a
 * Dexie schema change; it is absent until completion, and so are the stamps
 * below. Exported because readers of persisted rows — which predate any of these
 * optional fields — need the same shape without hand-rolling their own copy.
 */
export interface ISwapExtraInputs {
  requestedFaucetId: string;
  requestedAmount: bigint;
  orderId?: bigint | string;
  expirySeconds?: number;
  /** Absent on orders placed before expiry stamping; those never auto-settle. */
  expiresAt?: number;
  expiryTriggeredAt?: number;
  autoConsume?: boolean;
  /** Stamped when a payback-claim settlement consume completes. */
  settledAt?: number;
  /** Stamped when an expiry-reclaim settlement consume completes. */
  reclaimedAt?: number;
}

/**
 * Swap one asset for another. The user offers `offeredAmount` of
 * `offeredFaucetId` and requests `requestedAmount` of `requestedFaucetId`.
 * The offered side maps onto the shared `faucetId`/`amount` fields; the
 * requested side lives in `extraInputs`. Generation and completion run through
 * the `case 'swap'` branches in `lib/miden/transaction` (PSWAP-create via
 * `MidenClientInterface.swapTransaction`, completion via
 * `completeSwapTransaction`).
 */
export class SwapTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount: bigint;
  faucetId: string;
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  extraInputs: ISwapExtraInputs;
  delegateTransaction?: boolean;
  /**
   * Serialized PSWAP-create `TransactionRequest`, populated lazily by the
   * Guardian path (`generateGuardianTransaction`) the first time the swap is
   * processed. Persisted so the custom proposal and the follow-up
   * `signAndCreateTransactionRequest` reuse identical bytes (the PSWAP serial
   * number is random — a rebuild would diverge).
   */
  requestBytes?: Uint8Array;

  constructor(
    accountId: string,
    offeredFaucetId: string,
    offeredAmount: bigint,
    requestedFaucetId: string,
    requestedAmount: bigint,
    delegateTransaction?: boolean,
    expirySeconds: number = 120,
    autoConsume: boolean = true
  ) {
    this.id = uuid();
    this.type = 'swap';
    this.accountId = accountId;
    this.faucetId = offeredFaucetId;
    this.amount = offeredAmount;
    this.extraInputs = { requestedFaucetId, requestedAmount, expirySeconds, autoConsume };
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'SWAP';
    this.displayMessage = 'Swapping';
    this.delegateTransaction = delegateTransaction;
  }
}

/**
 * Cross-chain Miden → EVM send. Two routes share this record:
 *   - agglayer (Slow): built from a pre-built B2AGG `TransactionRequest` (own
 *     output note) in `requestBytes`, so the standard pipeline proves + submits it
 *     via `newTransaction` like a custom `execute` tx, then `completeBridgedSendTransaction`
 *     records it. The EVM-side asset is claimed later by the recipient on L1.
 *   - epoch (Fast): driven out-of-band by `bridgeEpochSend` (no `requestBytes`);
 *     auto-settles on the destination chain, so there is no manual claim.
 * `extraInputs` (`IBridgedSendExtraInputs`) carries the route/provider, EVM
 * destination + network, and claim status for the activity detail view.
 */
/**
 * Send-style fields for an Epoch `bridged-send`. Epoch bridges by sending a
 * recallable P2IDE note to the solver's allocator account, so the row is
 * processed by the normal send pipeline (`sendTransaction`) rather than a
 * pre-built request. Absent for Agglayer, which carries `requestBytes`.
 */
export interface IBridgedSendNoteParams {
  /** Allocator account the P2IDE note is sent to. */
  recipientId: string;
  noteType: NoteType;
  recallBlocks: number;
}

export class BridgedSendTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount: bigint;
  faucetId: string;
  /** Set for the send-style (Epoch) path so `sendTransaction` can route the note. */
  secondaryAccountId?: string;
  noteType?: NoteType;
  requestBytes?: Uint8Array;
  transactionId?: string;
  outputNoteIds?: string[];
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  delegateTransaction?: boolean;
  extraInputs: IBridgedSendExtraInputs;

  constructor(
    accountId: string,
    amount: bigint,
    destinationAddress: string,
    destinationNetwork: number,
    provider: IBridgeProvider,
    faucetId: string,
    requestBytes?: Uint8Array,
    delegateTransaction?: boolean,
    sendParams?: IBridgedSendNoteParams
  ) {
    this.id = uuid();
    this.type = 'bridged-send';
    this.accountId = accountId;
    this.requestBytes = requestBytes;
    this.amount = amount;
    this.faucetId = faucetId;
    this.secondaryAccountId = sendParams?.recipientId;
    this.noteType = sendParams?.noteType;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'SEND';
    this.displayMessage = 'Bridging';
    this.delegateTransaction = delegateTransaction;
    this.extraInputs = {
      provider,
      destinationAddress,
      destinationNetwork,
      sourceFaucetId: faucetId,
      // Agglayer needs a manual L1 claim; Epoch auto-settles.
      claimStatus: provider === 'agglayer' ? 'pending' : 'not-applicable',
      recallBlocks: sendParams?.recallBlocks
    };
  }
}

/**
 * Open an Epoch lending position: a recallable P2IDE note to the solver's allocator
 * account. On non-Guardian accounts it is send-style, processed by the normal send
 * pipeline (`sendTransaction`) like the Epoch `bridged-send`. On Guardian accounts the
 * multisig send proposal is P2ID-only, so the P2IDE is serialized into `requestBytes`
 * and proposed as a custom proposal (see `generateGuardianTransaction` 'earn-deposit').
 * The EVM lending deposit is solver-fulfilled, so there is no manual claim.
 */
export class EarnDepositTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount: bigint;
  faucetId: string;
  /** Allocator account the P2IDE note is sent to. */
  secondaryAccountId?: string;
  noteType?: NoteType;
  transactionId?: string;
  outputNoteIds?: string[];
  /**
   * Serialized P2IDE collateral request (own output note with the Epoch
   * mandate-binding attachment), built once at initiate time and reused
   * verbatim across the standard pipeline, guardian propose/sign, and retries.
   */
  requestBytes?: Uint8Array;
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  delegateTransaction?: boolean;
  extraInputs: IEarnDepositExtraInputs;

  constructor(
    accountId: string,
    amount: bigint,
    evmRecipient: string,
    marketUid: string,
    faucetId: string,
    sendParams: IBridgedSendNoteParams,
    delegateTransaction?: boolean,
    requestBytes?: Uint8Array
  ) {
    this.id = uuid();
    this.type = 'earn-deposit';
    this.accountId = accountId;
    this.amount = amount;
    this.faucetId = faucetId;
    this.secondaryAccountId = sendParams.recipientId;
    this.noteType = sendParams.noteType;
    this.requestBytes = requestBytes;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'DEFAULT';
    this.displayMessage = 'Depositing';
    this.delegateTransaction = delegateTransaction;
    this.extraInputs = {
      evmRecipient,
      marketUid,
      sourceFaucetId: faucetId,
      recallBlocks: sendParams.recallBlocks,
      epochStatus: 'pending'
    };
  }
}

/**
 * Tracking-only row for a Smart Withdraw (Epoch lending redeem → bridge to Miden).
 * There is NO Miden-side note to prove/submit, so this row must **never** be born
 * `Queued`: the FIFO prove/submit loop (`transaction/index.ts`) dispatches any
 * `Queued` row type-blind and would crash on the missing request bytes, and the
 * stale-queue canceller would kill a slow withdrawal. It is inserted `Completed`
 * with `completedAt = initiatedAt`; the in-flight look comes from `extraInputs.phase`.
 */
export class EarnWithdrawTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount: bigint;
  faucetId: string;
  status: ITransactionStatus;
  initiatedAt: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  extraInputs: IEarnWithdrawExtraInputs;

  constructor(
    accountId: string,
    amount: bigint,
    evmOwner: string,
    marketUid: string,
    faucetId: string,
    sourceAmount: string,
    sourceSymbol = 'USDC'
  ) {
    const now = Math.floor(Date.now() / 1000); // seconds
    this.id = uuid();
    this.type = 'earn-withdraw';
    this.accountId = accountId;
    this.amount = amount;
    this.faucetId = faucetId;
    this.status = ITransactionStatus.Completed;
    this.initiatedAt = now;
    this.completedAt = now;
    this.displayIcon = 'DEFAULT';
    this.displayMessage = 'Withdrawing from lending';
    this.extraInputs = {
      evmOwner,
      marketUid,
      destinationFaucetId: faucetId,
      sourceAmount,
      sourceSymbol,
      phase: 'redeeming'
    };
  }
}

/**
 * Tracking-only EVM → Miden bridge row. It is born Completed so the Miden
 * prove/submit FIFO never sees it; `extraInputs.phase` owns its live state.
 */
export class BridgedReceiveTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount: bigint;
  faucetId: string;
  status: ITransactionStatus;
  initiatedAt: number;
  completedAt: number;
  displayMessage: string;
  displayIcon: ITransactionIcon;
  extraInputs: IBridgedReceiveExtraInputs;

  constructor(
    accountId: string,
    amount: bigint,
    faucetId: string,
    provider: IBridgeProvider,
    sourceAddress: string,
    sourceAmount: string,
    sourceSymbol: string,
    outputAmount?: string,
    outputSymbol?: string
  ) {
    const now = Math.floor(Date.now() / 1000);
    this.id = uuid();
    this.type = 'bridged-receive';
    this.accountId = accountId;
    this.amount = amount;
    this.faucetId = faucetId;
    this.status = ITransactionStatus.Completed;
    this.initiatedAt = now;
    this.completedAt = now;
    this.displayMessage = 'Bridging from EVM';
    this.displayIcon = 'RECEIVE';
    this.extraInputs = {
      provider,
      sourceAddress,
      sourceAmount,
      sourceSymbol,
      outputAmount,
      outputSymbol,
      phase: 'submitting'
    };
  }
}

export class SwitchGuardianTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  transactionId?: string;
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  extraInputs: ISwitchGuardianExtraInputs;
  delegateTransaction?: boolean | undefined;

  constructor(
    accountId: string,
    newGuardianEndpoint: string,
    delegateTransaction?: boolean,
    previousGuardianEndpoint?: string
  ) {
    this.id = uuid();
    this.type = 'switch-guardian';
    this.accountId = accountId;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'DEFAULT';
    this.displayMessage = 'Switching guardian';
    this.extraInputs = { previousGuardianEndpoint, newGuardianEndpoint };
    this.delegateTransaction = delegateTransaction;
  }
}

/**
 * Proactive hot-key rotation for a Guardian account. Cold-signed (recovery key);
 * the on-chain proposal swaps the hot signer commitment in-place via
 * `update_signers`. extraInputs.newHotPublicKey is filled in during
 * `generateGuardianTransaction` once the new key is minted, and consumed by
 * `completeReplaceHotKeyTransaction` to swap the WalletAccount pointer.
 */
export class ReplaceHotKeyTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  transactionId?: string;
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  // `reRegisterFailed` (#619 gap 1): the on-chain rotation succeeded but the
  // best-effort post-rotation guardian re-register did not land. Observable-only
  // — it gates nothing (recovery is owned by the guardian-sync 401 self-heal);
  // it exists so telemetry/E2E can tell a fully-clean rotation from one whose
  // allowlist push needs the self-heal to catch up.
  extraInputs: { newHotPublicKey?: string; reRegisterFailed?: boolean };
  delegateTransaction?: boolean | undefined;

  constructor(accountId: string, delegateTransaction?: boolean) {
    this.id = uuid();
    this.type = 'replace-hot-key';
    this.accountId = accountId;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000);
    this.displayIcon = 'DEFAULT';
    this.displayMessage = 'Rotating device key';
    this.extraInputs = {};
    this.delegateTransaction = delegateTransaction;
  }
}

/**
 * Sets an on-chain procedure threshold on a Guardian account (cold-signed).
 * Used to bring migrated legacy accounts up to the same hardening a freshly
 * created 3-key account gets — notably `update_guardian` at threshold 2 — which
 * `update_signers` (the hot-key activation) cannot carry in the same tx.
 */
export class UpdateProcedureThresholdTransaction implements ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  transactionId?: string;
  status: ITransactionStatus;
  initiatedAt: number;
  processingStartedAt?: number;
  completedAt?: number;
  displayMessage?: string;
  displayIcon: ITransactionIcon;
  extraInputs: { procedure: string; threshold: number };
  delegateTransaction?: boolean | undefined;

  constructor(accountId: string, procedure: string, threshold: number, delegateTransaction?: boolean) {
    this.id = uuid();
    this.type = 'update-procedure-threshold';
    this.accountId = accountId;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000);
    this.displayIcon = 'DEFAULT';
    this.displayMessage = 'Securing account';
    this.extraInputs = { procedure, threshold };
    this.delegateTransaction = delegateTransaction;
  }
}

export function formatTransactionStatus(status: ITransactionStatus): string {
  const words = ITransactionStatus[status].split(/(?=[A-Z])/);
  return words.join(' ');
}
