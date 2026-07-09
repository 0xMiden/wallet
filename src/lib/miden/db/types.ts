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
  | 'switch-guardian'
  | 'replace-hot-key'
  | 'swap'
  | 'update-procedure-threshold';

/** Which cross-chain bridge route a `bridged-send` used. */
export type IBridgeProvider = 'epoch' | 'agglayer';

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
}

/** `extraInputs` shape for a `consume` row that claimed a bridged-in note. */
export interface IConsumeBridgeInExtraInputs {
  bridgeIn: IBridgeInInfo;
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
  error?: string;
  resultBytes?: Uint8Array;
  /**
   * Current sub-phase during active processing. Readers should treat this
   * as informational only — it is overwritten without coordination with
   * `status`, and is stale once `status` reaches `Completed`/`Failed`.
   */
  stage?: ITransactionStage;
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
    // Display amount: sum of the notes sharing the first note's faucet. Notes
    // of other faucets in a mixed batch aren't reflected here (display only).
    this.amount =
      first.amount !== ''
        ? list.filter(n => n.faucetId === first.faucetId && n.amount !== '').reduce((s, n) => s + BigInt(n.amount), 0n)
        : undefined;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'RECEIVE';
    this.displayMessage = 'Consuming';
    this.delegateTransaction = delegateTransaction;
  }
}

/**
 * Swap one asset for another. The user offers `offeredAmount` of
 * `offeredFaucetId` and requests `requestedAmount` of `requestedFaucetId`.
 * The offered side maps onto the shared `faucetId`/`amount` fields; the
 * requested side lives in `extraInputs`.
 *
 * TODO: actual swap generation/completion is not wired up yet — see the
 * `case 'swap'` TODOs in the transaction dispatch (lib/miden/transaction).
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
  // `orderId` is actually output info but a little hack until I decide if I want to change the schema or not
  extraInputs: { requestedFaucetId: string; requestedAmount: bigint; orderId?: bigint };
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
    delegateTransaction?: boolean
  ) {
    this.id = uuid();
    this.type = 'swap';
    this.accountId = accountId;
    this.faucetId = offeredFaucetId;
    this.amount = offeredAmount;
    this.extraInputs = { requestedFaucetId, requestedAmount };
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
  extraInputs: { newGuardianEndpoint: string };
  delegateTransaction?: boolean | undefined;

  constructor(accountId: string, newGuardianEndpoint: string, delegateTransaction?: boolean) {
    this.id = uuid();
    this.type = 'switch-guardian';
    this.accountId = accountId;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'DEFAULT';
    this.displayMessage = 'Switching guardian';
    this.extraInputs = { newGuardianEndpoint };
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
  extraInputs: { newHotPublicKey?: string };
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
