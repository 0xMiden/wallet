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
  // `registerFailed`: the on-chain `update_guardian` committed but registering
  // the account on the NEW operator did not land, so that operator has no record
  // of the account. Recovery is owned by guardian-sync's missing-registration
  // self-heal (`attemptMissingRegistrationSelfHeal`) — deliberately NOT the 401
  // cold-re-register self-heal, which needs a guardian state load and therefore
  // cannot run against an operator that has never seen the account.
  //
  // That self-heal talks to whatever endpoint the vault names, so it reaches the
  // NEW operator only if the endpoint write ATTEMPTED before it actually landed.
  // Completion attempts it first but does not guarantee it: both can fail, and
  // this flag and `endpointPersistFailed` can both be set on one row. When they
  // are, the vault still names the old operator, the missing-registration
  // self-heal is pointed at the wrong host, and drift reconciliation — the repair
  // `endpointPersistFailed` already names — is what recovers the account.
  registerFailed?: boolean;
  // `endpointPersistFailed`: the rotation committed on chain but the vault still
  // names the previous operator (e.g. the wallet auto-locked mid-rotation, so the
  // encrypted write was refused). Guardian drift reconciliation is the repair
  // path; recorded so a support log can tell this apart from a clean switch.
  endpointPersistFailed?: boolean;
  // `switchedDirectly` / `directSwitchReason`: this row rotated the guardian by a
  // UNILATERAL on-chain `update_guardian` instead of a proposal co-signed by the
  // outgoing operator, and the classified error that made the wallet choose that.
  // Written before the leaf executes, so the marker survives a row that then
  // fails — which is what lets `reconcileStructuralApplyFailure` read it: on a
  // post-submit apply failure it skips rebuilding a service from the operator
  // this row already found unreachable, rather than spending the WASM lock
  // waiting on it. Absent (an older row, or a coordinated switch) the reconcile
  // falls back to a deadline-bounded attempt, so a missing marker costs 30s and
  // never correctness. The two paths also differ in what state can be left
  // behind (see `registerFailed` above), and without `directSwitchReason` a
  // support log cannot tell whether the unreachability verdict was right.
  switchedDirectly?: boolean;
  directSwitchReason?: string;
  // `commitUnconfirmed`: the direct rotation was SUBMITTED but the wallet never
  // established that it committed. The commit wait failed without a verdict and
  // the follow-up node read came back neither committed nor discarded, so
  // `didDirectSwitchLand` answered `undefined`. Completion proceeds anyway —
  // deliberately, since the alternative strands the account on an operator the
  // direct path has already judged unreachable — but "we went ahead on no
  // evidence" is not the same fact as "it committed", and every other surface
  // used to render them identically.
  //
  // It matters more here than the optimism usually would: if the rotation did
  // NOT land, the OLD operator is still the on-chain guardian while the vault
  // now names the new one, and nothing detects that afterwards — drift compares
  // the on-chain guardian against its cached baseline, and both still name the
  // old operator, so it reports `in-sync` without ever reading the stored
  // endpoint. The receipt is the last place the user can be told, which is why
  // this is persisted rather than merely logged.
  commitUnconfirmed?: boolean;
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
 *   - signing-locally      : direct switch-guardian only, while the wallet's own
 *                            hot+cold keys sign — no operator is contacted, which
 *                            is why this cannot reuse `signing-proposal`: that
 *                            stage's copy says the guardian is signing, and the
 *                            direct path exists precisely because it is not
 *   - executing            : Guardian only, while executing the signed request
 *   - proving              : Guardian only, while proving the executed transaction
 *   - submitting           : Guardian only, while submitting the proven transaction
 *   - confirming           : send-private + switch-guardian, during `waitForTransactionCommit`
 *   - registering-guardian : switch-guardian only, during post-commit guardian re-registration
 *   - delivering           : send-private only, during `sendPrivateNote`
 *   - guardian-syncing     : Guardian only, while syncing guardian state after submission
 *   - complete             : final stage marker before/at terminal status
 *
 * Declared as a runtime tuple with {@link ITransactionStage} DERIVED from it, so
 * the list exists at runtime for code that must validate a stage it did not
 * produce — the SW's reverse-IPC listener takes stage stamps off the extension
 * message bus, where a `stage: ITransactionStage` field on a message type is a
 * compile-time claim about a value the compiler never saw. Deriving the union
 * from the tuple (rather than keeping a hand-copied parallel array) makes that
 * check impossible to drift from the union.
 */
export const TRANSACTION_STAGES = [
  'syncing',
  'sending',
  'creating-proposal',
  'signing-proposal',
  'signing-locally',
  'executing',
  'proving',
  'submitting',
  'confirming',
  'registering-guardian',
  'delivering',
  'guardian-syncing',
  'guardian-synced',
  'complete'
] as const;

export type ITransactionStage = (typeof TRANSACTION_STAGES)[number];

/**
 * Whether a private note's body has reached the transport layer.
 *
 * Separate from `status` because they answer different questions and can disagree
 * in the way that matters most. `status` tracks the TRANSACTION, which is on chain
 * and irreversible; this tracks DELIVERY, which is the only thing that makes a
 * private note reachable at all — the chain carries a commitment, not the note. A
 * send can be legitimately Completed (the assets have left the account, so Failed
 * would be untrue and would offer a Retry that spends again) while its note
 * reached nobody.
 *
 * Absent means the question does not apply or predates this field: a public send
 * needs no relay, and rows written by an older build never recorded one.
 *
 *   - `pending`     — a relay is OWED. Written BEFORE the relay is attempted,
 *                     together with the evidence needed to reason about it later,
 *                     so an interruption mid-relay leaves a record rather than
 *                     nothing. This is the state the wallet previously had no way
 *                     to represent, which is why an interrupted relay was
 *                     indistinguishable from a successful one.
 *   - `relayed`     — the transport is believed to HOLD the note: either it accepted
 *                     the push, or it rejected a re-push as a duplicate, which is
 *                     itself evidence the body is already there. Deliberately not
 *                     terminal, for two separate reasons. An empty
 *                     `SendNoteResponse` means acceptance is not proof of storage, so
 *                     the row stays eligible for the re-push sweep, which tests
 *                     exactly that. And even a genuinely stored note can be
 *                     unreachable: the recipient's opaque pagination cursor never
 *                     goes back, so one that advanced past the note leaves it
 *                     invisible forever (note-transport-service#77) — a case NO
 *                     re-push can repair (see `note-delivery-sweep.ts`) and only the
 *                     nullifier can settle. `relayed` therefore means "believed to be
 *                     in flight", never "delivered".
 *   - `confirmed`   — the note was CONSUMED on chain. This is the only positive
 *                     proof of delivery available: the recipient cannot consume a
 *                     private note without having received its body, so the
 *                     nullifier is the receipt. Terminal.
 *   - `undelivered` — the relay was attempted and did not succeed. Not necessarily
 *                     permanent (the SDK's own outbox may still retry it, and that
 *                     retry replays the ORIGINAL block hint, so it stays correct
 *                     however late it runs) — but it may equally mean nothing was
 *                     ever queued, so it is surfaced rather than assumed benign.
 */
export type INoteDeliveryState = 'pending' | 'relayed' | 'confirmed' | 'undelivered';

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
  /**
   * Set on every row restored from a backup file. A dump is an archive of what
   * happened, so a restored row is a RECORD and must never become WORK: its
   * contents — recipient, amount, `requestBytes` — come from whoever authored
   * the file, and the FIFO loop and the Retry button both drive rows into the
   * signer without re-confirming any of that. `importDb` lands these rows in
   * `Failed`; this flag is what keeps them there.
   */
  restoredFromBackup?: boolean;
  resultBytes?: Uint8Array;
  /**
   * Current sub-phase during active processing. Readers should treat this
   * as informational only — it is overwritten without coordination with
   * `status`, and is stale once `status` reaches `Completed`/`Failed`.
   */
  stage?: ITransactionStage;
  /**
   * Wall-clock (ms since epoch) of the first time each processing stage was
   * entered, recorded by `setTransactionStage` (plus a synthetic `complete`
   * stamp written when the row reaches `Completed`). The generating-transaction
   * screen derives per-step durations from these persisted stamps rather than
   * observing live `stage` transitions — a Dexie `liveQuery` coalesces rapid
   * adjacent stage writes, which would otherwise drop a step's start/end and
   * leave its duration blank. First-entry-wins WITHIN one attempt: a stage
   * re-entered during the same run keeps its original entry time (the meaningful
   * boundary for step timing). A requeue clears the whole map, so the next
   * attempt records its own boundaries rather than the first attempt's.
   */
  stageTimestamps?: Partial<Record<ITransactionStage, number>>;
  /**
   * Earliest time (unix seconds) this Queued tx may be re-selected by the
   * processing loop. Set by every arm that requeues rather than fails — the
   * guardian pending-delta 409, a 429 rate limit, a remote-prover outage, a
   * locked-wallet deferral and an unauthorized-at-execution retry — so a
   * persistently-conflicting op backs off and yields its slot to other accounts
   * instead of being re-picked every cycle as the oldest row (head-of-line
   * starvation). Absent ⇒ always eligible (backward compatible);
   * `MAX_QUEUED_AGE` remains the terminal cap.
   */
  nextEligibleAt?: number;
  /**
   * Deadline (unix seconds) after which an execution-`unauthorized` guardian
   * failure stops being retried and becomes terminal. Stamped on the FIRST such
   * requeue and never RESTARTED by a later one, so the budget covers the whole
   * retry sequence rather than renewing each cycle.
   *
   * It is not fixed, though: a requeue down an UNRELATED arm (409, 429, prover
   * outage) pushes it out by that arm's own cooldown. The budget is a wall clock
   * and those waits are not retry attempts, so charging them against it would
   * let a single rate limit — which can park a row for 300s, longer than the
   * whole budget — leave a row with nothing left for its next genuine race. So
   * the floor is the budget; the ceiling is the budget plus whatever unrelated
   * backoff the row waited out, and `MAX_QUEUED_AGE` from `initiatedAt` remains
   * the terminal cap above both.
   *
   * Deliberately its own field rather than an offset from `initiatedAt`: that
   * clock starts at ENQUEUE, so a row that waited behind a deep queue — the
   * sustained-load case this retry exists for — would arrive with its whole
   * budget already spent and never retry at all. An absolute deadline also
   * avoids comparing against a timestamp whose unit or origin the row does not
   * control. Absent ⇒ not yet retried for this reason (backward compatible).
   */
  unauthorizedRetryUntil?: number;
  /**
   * Delivery state of this row's private output note — see
   * {@link INoteDeliveryState}. Absent for public sends and non-relaying types.
   *
   * This is the wallet's OWN record that a relay is owed. It previously had none:
   * durability was delegated entirely to the SDK's retry outbox, which Rust writes
   * from inside the relay call and only after it has resolved the transport API.
   * Every failure upstream of that write therefore queued nothing while throwing
   * exactly like a mid-transport timeout that DID queue — and under 0.16 there is a
   * new member of that class, since `notes.sendPrivateOutput` first resolves the
   * note by id from the calling client's store and rejects with `No output note
   * found for the given id` if it is not there as an applied output note.
   */
  noteDelivery?: INoteDeliveryState;
  /**
   * How many times this row's private note has been handed to the transport,
   * counting the first attempt. Bounds the re-push sweep so a note nobody ever
   * consumes cannot be re-pushed forever.
   */
  relayAttempts?: number;
  /**
   * Earliest time (unix seconds) the sweep may re-push this row's private note.
   *
   * Spread wide on purpose. Stamped from the clock at write time rather than from
   * when the sweep began, except for the first arming, which is measured from the
   * original relay (`completedAt`) so a row first seen long afterwards does not have
   * to serve the wait twice. See `note-delivery-sweep.ts` for what each re-push
   * outcome does and does not prove.
   */
  nextRelayAt?: number;
  /**
   * Sticky: set once some attempt on this row reached a point from which a
   * chain submit cannot be ruled out, and never unset. Guards the cached
   * `requestBytes` of a guardian recallable `send` from being rebuilt, since
   * those bytes pin the note id that makes the chain reject a duplicate —
   * rebuilding them after a possible submit risks paying the recipient twice.
   *
   * A per-attempt `stage` cannot carry this, for two independent reasons.
   * Requeueing clears `stage`, so the signal survived exactly one retry and the
   * next failure at an early stage looked pre-submit and cleared the bytes
   * anyway. And a row can be failed out from under a running pipeline by
   * `cancelTransaction`, which freezes `stage` wherever the cancel caught it
   * while the pipeline goes on to submit — so the stage can say 'proving'
   * about a transfer that landed. "May have submitted" is a property of the
   * row's history, not of the attempt currently running, so the leaves write it
   * directly at the submit crossing (`markMayHaveSubmitted`).
   *
   * Absent does NOT by itself mean "never submitted". It means no attempt
   * recorded a crossing, which for rows written by an older build — no leaf ever
   * stamped this — is simply unknown; `PRE_SUBMIT_STAGES` documents how those are
   * read conservatively from the stage and the presence of cached bytes.
   */
  mayHaveSubmitted?: boolean;
  /**
   * Unix seconds at which this row was failed from OUTSIDE its own pipeline —
   * the Cancel button — while that pipeline was still running. Not the same
   * claim as `mayHaveSubmitted`, and deliberately not merged into it.
   *
   * `mayHaveSubmitted` records a crossing that HAPPENED. This records that we
   * do not yet know whether one will: the cancel marks the row but does not
   * abort the work, so the pipeline runs on and may still submit. The GUARDIAN
   * leaves stamp `mayHaveSubmitted` before submitting and their writes go through
   * a terminal row, so a crossing that occurs there IS recorded — but only from
   * the moment the leaf reaches it. Between the cancel and that stamp the row
   * looks pre-submit, and a retry in that window would rebuild the request and pay
   * twice. This field covers exactly that gap.
   *
   * For a send from a non-guardian account there is no such stamp to supplement:
   * that leaf calls through to the proxy without recording anything, and the row
   * stays at the 'sending' its pipeline set once at pickup. This field is then the
   * only evidence that exists, which is why the retry guard refuses on it outright
   * rather than merely declining to rebuild.
   *
   * It has to expire, which is why it is a timestamp rather than a boolean. The
   * first version of this guard was a sticky flag, and a sticky "maybe" is
   * indistinguishable from "yes" forever: a send that failed while proving got
   * its bytes pinned permanently, so every retry replayed the identical bad
   * request instead of rebuilding it — defeating the callback-asset fix this
   * whole change exists for, and freezing an absolute reclaim height that a
   * later attempt could land already past. So:
   *
   *   - the pipeline's own catch CLEARS it, because reaching that catch proves
   *     the pipeline stopped; if it had submitted, the leaf already stamped
   *     `mayHaveSubmitted` and the guard holds on that instead;
   *   - failing that, it lapses after `MAX_WAIT_BEFORE_CANCEL`, the app's own
   *     definition of the longest a pipeline can plausibly still be alive.
   *
   * Both the Cancel button and the stuck reaper set it. The reaper used to be
   * excluded, on the reasoning that a row it takes has already exceeded that same
   * maximum and so cannot still be running — but the threshold is when the app
   * stops waiting, not when the work stops: nothing aborts the pipeline, a mobile
   * write has no deadline at all, and the maximum is counted in ACTIVE seconds, so
   * a reaped row can still be mid-submit. That made the reaper the widest instance
   * of the window this field exists to cover.
   */
  cancelledInFlightAt?: number;
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
