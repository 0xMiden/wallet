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

/**
 * Off-chain bridge provider for a bridged send. `epoch` settles quickly
 * (FAST badge); `agglayer` settles on the slower path (SLOW badge). See
 * `TransactionSuccess` for the badge mapping.
 */
export type IBridgeProvider = 'epoch' | 'agglayer';

/**
 * `extraInputs` payload carried by a bridged send (sending an asset out of
 * Miden to another network). Populated when the user routes a send through a
 * bridge; absent for plain in-network sends.
 */
export interface IBridgedSendExtraInputs {
  /** Recipient address on the destination network. */
  destinationAddress: string;
  /** Destination network chain id. */
  destinationNetwork: number;
  /** Which bridge provider carries the transfer. */
  provider: IBridgeProvider;
}

export type ITransactionIcon = 'SEND' | 'RECEIVE' | 'SWAP' | 'FAILED' | 'MINT' | 'DEFAULT';
export type ITransactionType =
  | 'send'
  | 'consume'
  | 'execute'
  | 'switch-guardian'
  | 'replace-hot-key'
  | 'swap'
  | 'update-procedure-threshold';

/**
 * Sub-phase of a transaction while `status === GeneratingTransaction` (or
 * still `Queued` during the initial sync). Drives the modal's per-stage
 * label so users see what the wallet is actually doing during the 3-8s
 * spinner window. Not all stages apply to all tx types:
 *   - syncing              : all types, before `syncState()`
 *   - sending              : all types, during the SDK execute→prove→submit→apply span
 *   - creating-proposal    : Guardian only, while building the multisig proposal
 *   - signing-proposal     : Guardian only, while the guardian signs the proposal
 *   - submitting           : Guardian only, after the signed tx submit span returns
 *   - confirming           : send-private + switch-guardian, during `waitForTransactionCommit`
 *   - registering-guardian : switch-guardian only, during post-commit guardian re-registration
 *   - delivering           : send-private only, during `sendPrivateNote`
 */
export type ITransactionStage =
  | 'syncing'
  | 'sending'
  | 'creating-proposal'
  | 'signing-proposal'
  | 'submitting'
  | 'confirming'
  | 'registering-guardian'
  | 'delivering';

export type ITransactionTimedStep = 'guardian-approving' | 'generating-proof';

export interface ITransactionStepTiming {
  startedAt: number;
  endedAt?: number;
}

export type ITransactionStepTimings = Partial<Record<ITransactionTimedStep, ITransactionStepTiming>>;

export interface ITransaction {
  id: string;
  type: ITransactionType;
  accountId: string;
  amount?: bigint;
  delegateTransaction?: boolean;
  secondaryAccountId?: string;
  faucetId?: string;
  noteId?: string;
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
  /** Backend timings for transaction-progress rows, in epoch milliseconds. */
  stepTimings?: ITransactionStepTimings;
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
  noteId: string;
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
  // Background/auto-consume (vs. a user-initiated claim). Guardian accounts use
  // this to route the signature through the cold key, avoiding a biometric
  // prompt for a silent background claim — see generateGuardianTransaction.
  background?: boolean;

  constructor(accountId: string, note: ConsumableNote, delegateTransaction?: boolean, background?: boolean) {
    this.id = uuid();
    this.type = 'consume';
    this.accountId = accountId;
    this.noteId = note.id;
    this.faucetId = note.faucetId;
    this.secondaryAccountId = note.senderAddress;
    this.amount = note.amount !== '' ? BigInt(note.amount) : undefined;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.displayIcon = 'RECEIVE';
    this.displayMessage = 'Consuming';
    this.delegateTransaction = delegateTransaction;
    this.background = background;
  }
}

/**
 * Swap one asset for another. The user offers `offeredAmount` of
 * `offeredFaucetId` and requests `requestedAmount` of `requestedFaucetId`.
 * The offered side maps onto the shared `faucetId`/`amount` fields; the
 * requested side lives in `extraInputs`.
 *
 * TODO: actual swap generation/completion is not wired up yet — see the
 * `case 'swap'` TODOs in the transaction dispatch (activity/transactions.ts).
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
