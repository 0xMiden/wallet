import type { HotKeyActivationMode, IOneClickTrackingData } from 'lib/miden/db/types';
import { ClaimFeeNote, claimFeeDecisions, isWorthClaiming, totalClaimableAmount } from 'lib/miden/fees/spendable';
import { getOrCreateMultisigService, type GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import { resolveGuardianEndpoint } from 'lib/miden/guardian/account';
import { GuardianRotationInProgressError } from 'lib/miden/guardian/rotation-in-progress';
import { importedNoteIds } from 'lib/miden/note-quarantine';
import * as Repo from 'lib/miden/repo';
import { assertSwapQueueAvailable } from 'lib/miden/swap/admission';
import { assertSwapVaultBalance } from 'lib/miden/swap/balance';
import {
  getActiveOverride,
  getEffectiveNetworkName,
  hasCustomEndpointOverride,
  isNoteTransportConfigured
} from 'lib/miden-chain/effective-endpoints';
import { cacheScope, getNativeAssetId } from 'lib/miden-chain/native-asset';
import { assertOneClickQuoteBinding } from 'lib/one-click/client';
import { assertOneClickFundingDeadlineMatches } from 'lib/one-click/deadline';
import type { AgglayerRecoveryConfig } from 'lib/remote-config/schema';
import { sameGuardianEndpoint } from 'lib/settings/helpers';
import { WalletAccount } from 'lib/shared/types';
import type { ConsumeEntryPoint } from 'lib/telemetry/transaction-failure';
import { getUsdcxRemoteDomain, usdcxSourceChains } from 'lib/usdcx/constant';
import type { UsdcxSourceChain } from 'lib/usdcx/constant';
import { WalletType } from 'screens/onboarding/types';

import { queueNoteImport } from '../activity/notes';
import { compareAccountIds } from '../activity/utils';
import { midenClientProxy } from '../back/miden-client-proxy';
import {
  BridgedReceiveTransaction,
  BridgedSendTransaction,
  ConsumeTransaction,
  EarnDepositTransaction,
  EarnWithdrawTransaction,
  IAgglayerDelivery,
  IBridgedSendNoteParams,
  IBridgeProvider,
  IConsumedAssetTotal,
  IConsumeSwapSettleExtraInputs,
  isLiveTransaction,
  ITransaction,
  ITransactionStatus,
  IUsdcxBurn,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwapTransaction,
  SwitchGuardianTransaction,
  Transaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { assertValidRecallBlocks, toNoteTypeString } from '../helpers';
import { sameWalletAccountId } from '../sdk/helpers';
import { withWasmClientLock } from '../sdk/miden-client';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';
import {
  admitOutgoingTransaction,
  hasSpendingLimits,
  queueOutgoingTransaction,
  resolveOutgoingSpendUsd,
  spendsOf
} from '../spending-limits/queue';
import { SpendingLimitAuthorization, SpendingLimitPriceUnavailableError } from '../spending-limits/types';
import { ConsumableNote, NoteTypeEnum, NoteType as NoteTypeString } from '../types';
import {
  ClaimFeeContext,
  ClaimFeeRefusedError,
  claimFeeNotes,
  getClaimFeeAhead,
  readClaimFeeContext
} from './claim-fee';
import { EARN_DEPOSIT_MISSING_REQUEST_ERROR, NOTE_HELD_BY_ANOTHER_TRANSACTION_ERROR } from './constants';
import { getNoteHoldingTransactions } from './get';
import { hotKeyRotationLockName, isLiveRotationRow } from './rotation-funding';
import { holdsNotes } from './verdict-rules';

export { ClaimFeeRefusedError } from './claim-fee';

// A network-only onboarding choice uses canonical endpoints; a developer override does not prove a chain.
const badgeNetwork = () => (hasCustomEndpointOverride(getActiveOverride()) ? undefined : getEffectiveNetworkName());

/** A worker claim refused at a row write because its caller can no longer sign it; the call's rows are rolled back. */
export class ClaimInsertRefusedError extends Error {
  constructor() {
    super('Claim not queued: its caller can no longer sign it');
    this.name = 'ClaimInsertRefusedError';
  }
}

/** A custom transaction inserted before a carried-note import failed; callers must retain its queued id. */
export class TransactionQueuedError extends Error {
  readonly transactionId: string;

  constructor(transactionId: string, options: { cause: unknown }) {
    super(`Transaction ${transactionId} is queued but its carried notes could not be queued`, options);
    this.name = 'TransactionQueuedError';
    this.transactionId = transactionId;
  }
}

export const requestCustomTransaction = async (
  accountId: string,
  transactionRequestBytes: string,
  inputNoteIds?: string[],
  importNotes?: string[],
  delegateTransaction?: boolean,
  recipientAccountId?: string,
  /** Per-faucet value leaving the account, from the approval-time dry run. */
  spentAssetTotals?: IConsumedAssetTotal[],
  spendingLimitAuthorization?: SpendingLimitAuthorization,
  /** The dApp origin asking; see `ITransaction.dappOrigins`. */
  dappOrigin?: string
): Promise<string> => {
  const byteArray = new Uint8Array(Buffer.from(transactionRequestBytes, 'base64'));
  const transaction = new Transaction(
    accountId,
    byteArray,
    inputNoteIds,
    delegateTransaction,
    recipientAccountId,
    spentAssetTotals
  );
  // On the row from its insert, before the confirm releases the carried notes' quarantine and a sync lap can list them.
  transaction.heldNoteIds = [...new Set([...(inputNoteIds ?? []), ...importedNoteIds(importNotes)])];
  if (dappOrigin !== undefined) transaction.dappOrigins = [dappOrigin];
  // A custom request that moves nothing is not a spend, so it keeps the plain insert. One that
  // does goes through the same chokepoint as every other outgoing transaction.
  if (spentAssetTotals !== undefined && spentAssetTotals.length > 0) {
    await queueOutgoingTransaction({ ...transaction, spentAssetTotals }, spentAssetTotals, spendingLimitAuthorization);
  } else {
    await Repo.transactions.add(transaction);
  }

  if (importNotes) {
    try {
      for (const noteBytes of importNotes) {
        await queueNoteImport(noteBytes);
      }
    } catch (cause) {
      throw new TransactionQueuedError(transaction.id, { cause });
    }
  }

  return transaction.id;
};

export const initiateConsumeTransactionFromId = async (
  accountId: string,
  noteId: string,
  delegateTransaction?: boolean,
  // Forwarded to `initiateConsumeNotesTransaction`'s bounded-retry gate. Every
  // caller of this helper runs behind an explicit user approval (the dApp
  // consume sheet, the failed-bridge "Reclaim funds" button), so they pass
  // `true`: auto-consume's backoff must not swallow a claim the user just
  // approved and answer it with the previous attempt's Failed row.
  manualRetry?: boolean,
  // A dApp's own consume request, by its origin. The dedup may answer with the dApp transaction holding the note, and
  // that id would let this dApp read another transaction's outcome and output notes, private ones included
  // (`waitForTransaction`), so only a claim may answer it, and the claim then lists the origin so the dApp may wait on
  // it. The wallet's own callers pass none and link the user to the holder instead.
  dappOrigin?: string,
  entryPoint?: ConsumeEntryPoint
): Promise<string> => {
  // Routed through `midenClientProxy.getInputNoteSummary` (issue #260, slice 7a):
  // flag-ON it reads the OFFSCREEN client that owns the note (the SW client is
  // dormant then and may not have it → a spurious "not found"); flag-OFF is the
  // byte-identical inline `getInputNote(noteId)` reduction under the caller lock.
  const summary = await withWasmClientLock(async () => midenClientProxy.getInputNoteSummary(noteId));
  if (!summary) {
    throw new Error(`Note with id ${noteId} not found`);
  }
  const note: ConsumableNote = {
    id: noteId,
    faucetId: '',
    amount: '',
    senderAddress: '',
    isBeingClaimed: false,
    type: summary.noteType !== undefined ? toNoteTypeString(summary.noteType) : 'unknown'
  };
  const feeNotes: ClaimFeeNote[] =
    summary.assets === null
      ? [{ faucetId: '', amount: '', assetsUnknown: true }]
      : summary.assets.map(asset => ({ ...asset, carriesMoreAssets: false }));

  const { committedId } = await queueConsumeRows(
    accountId,
    [note],
    delegateTransaction,
    manualRetry,
    undefined,
    undefined,
    undefined,
    dappOrigin,
    undefined,
    entryPoint,
    undefined,
    undefined,
    new Map([[noteId, feeNotes]])
  );
  if (dappOrigin !== undefined) await grantDappOrigin(committedId, dappOrigin);
  return committedId;
};

// One write, so a row the dedup answered with cannot become another transaction's holder between the check and the
// grant. A fresh row already lists the origin from its insert.
const grantDappOrigin = async (id: string, origin: string): Promise<void> => {
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    const row = await Repo.transactions.where({ id }).first();
    // A dApp transaction carries `heldNoteIds` whatever its type, since completion can re-type it as a consume.
    if (row?.type !== 'consume' || row.heldNoteIds !== undefined) {
      throw new Error(NOTE_HELD_BY_ANOTHER_TRANSACTION_ERROR);
    }
    if (row.dappOrigins?.includes(origin)) return;
    await Repo.transactions.where({ id }).modify((dbTx: ITransaction) => {
      dbTx.dappOrigins = [...(dbTx.dappOrigins ?? []), origin];
    });
  });
};

// NOTE: this used to take a `background` flag that routed Guardian auto-consume
// through the COLD key, because iOS hot-key signing was gated behind Face ID
// (`.userPresence` on the SE key) and a silent background claim must not pop a
// biometric prompt every AutoSync tick. That gate has been removed — the SE hot
// key is `.privateKeyUsage`-only again and signs silently — so background and
// user-initiated consumes are identical and both take the standard hot-bound
// path (see generateGuardianTransaction).
/** Single-note consume — a thin wrapper over the batch path. */
export const initiateConsumeTransaction = async (
  accountId: string,
  note: ConsumableNote,
  delegateTransaction?: boolean,
  manualRetry?: boolean,
  entryPoint?: ConsumeEntryPoint,
  canSign?: () => boolean
): Promise<string> => {
  return initiateConsumeNotesTransaction(
    accountId,
    [note],
    delegateTransaction,
    manualRetry,
    undefined,
    undefined,
    entryPoint,
    canSign
  );
};

/** What {@link queueConsumeNotes} committed: the row id callers link to, and the row covering each note. */
export interface ConsumeNotesQueueResult {
  committedId: string;
  /** The row each note joined, or the live, Completed, note-holding or Failed row that kept it out. */
  coveringTxIdByNoteId: Map<string, string>;
  feeRefusedNoteIds: string[];
}

/**
 * Queue ONE consume transaction for many notes (Claim All / Claim Group) —
 * both the wallet's consume request (`buildConsumeTransactionRequest`) and the
 * Guardian consume proposal take many notes, so batching is one proof/submit
 * instead of N.
 *
 * Per-note dedup against all non-Failed consume txs, including Completed ones.
 * Reason: getConsumableNotes() can still return a note for a short window after a local
 * consume completes (chain-sync lag). Without this, auto-consume polling creates a new
 * tx every 5s until the sync catches up. Notes that are already covered by a live row
 * (scalar `noteId` or batch `noteIds` index) are dropped from the batch. Failed txs are
 * excluded by the existing-non-Failed dedup so retries can recover from transient
 * failures, but bounded by the terminal-safe exponential-backoff policy
 * (RETRY_COOLDOWN_SEC · 2^(n-1), capped at MAX_RETRY_BACKOFF_SEC) so a deterministic
 * failure decays to a daily probe instead of an endless drip (#215, #313).
 *
 * The check-and-add is wrapped in a Dexie `rw` transaction so concurrent callers for the
 * same noteId are serialized at the DB layer. Without this, two callers that slip past
 * the isBeingClaimed gate (e.g. two Explore re-renders racing the NoteClaimStarted
 * intercom round-trip) both see `[]` from the check and both `.add()`, producing two
 * queued consume rows — the second of which fails on-chain with "note has already been
 * consumed" and spuriously trips the connectivity-issue banner.
 *
 * Returns the queued batch row id, or — when every note was deduped away — the
 * id of the row that blocked the most recent note (live/Completed dedup winner
 * or the most recent Failed row from the backoff gate), so callers always get
 * a stable "this note already has a tx" response. `coveringTxIdByNoteId` names the
 * row covering EACH note, because a partly deduplicated batch's id covers only the
 * notes that joined it.
 *
 * `settlementLink` is swap settlement's: the order a row settles, written in the insert that creates the row, so
 * no running processor ever sees a settlement claim without it (#1644).
 */
export const queueConsumeNotes = async (
  accountId: string,
  notes: ConsumableNote[],
  delegateTransaction?: boolean,
  manualRetry?: boolean,
  isolateNotesWithFailedBatch?: boolean,
  verificationBaseFee?: number | null,
  entryPoint?: ConsumeEntryPoint,
  canSign?: () => boolean,
  settlementLink?: IConsumeSwapSettleExtraInputs
): Promise<ConsumeNotesQueueResult> =>
  queueConsumeRows(
    accountId,
    notes,
    delegateTransaction,
    manualRetry,
    isolateNotesWithFailedBatch,
    verificationBaseFee,
    undefined,
    undefined,
    settlementLink
      ? row => {
          row.extraInputs = { ...(row.extraInputs ?? {}), ...settlementLink };
        }
      : undefined,
    entryPoint,
    canSign
  );

/**
 * Queue the creator-side reclaim of a zero-fill PSWAP tip. Its tip is still an
 * output note, so the ordinary consume builder (which resolves input-note ids)
 * cannot build it later. Persist the already fee-aware request and settlement
 * link in the same Dexie transaction that inserts the row; an active processing
 * loop must never observe the row in between those writes.
 */
export const initiatePswapReclaimTransaction = async (
  accountId: string,
  note: ConsumableNote,
  requestBytes: Uint8Array,
  swapOrderTxId: string,
  delegateTransaction?: boolean,
  canSign?: () => boolean
): Promise<string> =>
  (
    await queueConsumeRows(
      accountId,
      [note],
      delegateTransaction,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      row => {
        row.requestBytes = requestBytes;
        row.extraInputs = { swapOrderTxId, swapSettleKind: 'reclaim' };
      },
      'swap_settlement',
      canSign
    )
  ).committedId;

/** The sale a GC purchase fills, as `findLiveGcSale` (`lib/miden/arcade/gc-sale.ts`) quotes it. */
export interface GcPurchaseQuote {
  saleNoteId: string;
  sellerAccountId: string;
  /** The pay faucet (USDCx) and the fill, in base units. */
  payFaucetId: string;
  fillAmount: bigint;
  /** The GC faucet and what the fill buys, in base units. */
  gcFaucetId: string;
  expectedAmount: bigint;
}

/**
 * Queue an Arcade GC purchase: a consume row on the seller's public PSWAP sale note, with the fill and the GC it
 * buys recorded on the row. The row carries no request yet: the fee-aware fill request is built from the node's
 * copy of the note right before it runs (`gcPurchaseOf` in `lib/miden/transaction`), so nothing here needs the
 * WASM client and the extension popup can queue it. Dedup is per sale note, like every claim: a purchase that is
 * live or completed on this note blocks another, which is right, since the note is spent once it completes and
 * the next purchase fills the remainder under a new id. A deliberate tap retries a failed note at once.
 */
export const initiateGcPurchaseTransaction = async (
  accountId: string,
  quote: GcPurchaseQuote,
  delegateTransaction?: boolean,
  spendingLimitAuthorization?: SpendingLimitAuthorization
): Promise<string> =>
  (
    await queueConsumeRows(
      accountId,
      [
        {
          id: quote.saleNoteId,
          faucetId: quote.gcFaucetId,
          amount: quote.expectedAmount.toString(),
          senderAddress: quote.sellerAccountId,
          isBeingClaimed: false,
          type: NoteTypeEnum.Public,
          carriesMoreAssets: false
        }
      ],
      delegateTransaction,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      row => {
        row.extraInputs = {
          gcPurchase: {
            saleNoteId: quote.saleNoteId,
            sellerAccountId: quote.sellerAccountId,
            payFaucetId: quote.payFaucetId,
            fillAmount: quote.fillAmount.toString(),
            gcFaucetId: quote.gcFaucetId,
            expectedAmount: quote.expectedAmount.toString()
          }
        };
      },
      'arcade_gc_purchase',
      undefined,
      undefined,
      undefined,
      {
        spends: [{ faucetId: quote.payFaucetId, amount: quote.fillAmount }],
        authorization: spendingLimitAuthorization
      }
    )
  ).committedId;

/** Options for {@link initiateRotationFundingClaim}; each has the meaning of its `initiateConsumeNotesTransaction` twin. */
export interface RotationFundingClaimOptions {
  delegate?: boolean;
  manualRetry?: boolean;
  verificationBaseFee?: number | null;
  canSign?: () => boolean;
}

/**
 * Queue the everyday-key rotation gate's claim (#805): native notes only, on rows stamped
 * `rotationFunding`, which generation signs with the recovery key. Refuses before any
 * write when given no notes, the native asset is unknown, or a note's `faucetId` is
 * anything else - the empty-list and native-asset refusals name this entry, not
 * `queueConsumeRows`' shared one, and the native-asset refusal is an early refusal only:
 * a `ConsumableNote` names just its note's first fungible asset, so the actual guarantee
 * that every asset in the row is native is `assertRotationFundingNotesNative`, checked
 * again at generation time.
 *
 * Otherwise the shared queue, with isolation on: per-note dedup against every live
 * consume row of the account, flagged or not. Only the #215 backoff differs, counting
 * nothing but earlier flagged failures (see `queueConsumeRows`).
 *
 * Callers must hold the `hotKeyRotationLockName` Web Lock for the account before calling
 * this; only `enqueueRotationFundingClaim` below does.
 */
export const initiateRotationFundingClaim = async (
  accountId: string,
  notes: ConsumableNote[],
  opts: RotationFundingClaimOptions = {}
): Promise<string> => {
  if (notes.length === 0) {
    throw new Error('initiateRotationFundingClaim requires at least one note');
  }
  let nativeFaucetId: string | null;
  try {
    nativeFaucetId = await getNativeAssetId();
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) throw error;
    nativeFaucetId = null;
  }
  if (!nativeFaucetId) {
    throw new Error('Rotation funding claim refused: the native asset is not known yet');
  }
  const foreign = notes.find(note => note.faucetId !== nativeFaucetId);
  if (foreign) {
    throw new Error(`Rotation funding claim refused: note ${foreign.id} is not the native asset`);
  }
  const { committedId } = await queueConsumeRows(
    accountId,
    notes,
    opts.delegate,
    opts.manualRetry,
    true,
    opts.verificationBaseFee,
    true,
    undefined,
    undefined,
    'rotation_funding',
    opts.canSign
  );
  return committedId;
};

/**
 * Queue the gate's funding claim unless the rotation is live, under the rotation's own
 * lock. Resolves to the id `initiateRotationFundingClaim` returns, or `null` when a
 * rotation row blocked it.
 */
export async function enqueueRotationFundingClaim(
  accountPublicKey: string,
  notes: ConsumableNote[],
  opts: RotationFundingClaimOptions
): Promise<string | null> {
  let txId: string | null = null;
  await navigator.locks.request(hotKeyRotationLockName(accountPublicKey), async () => {
    const rotation = await Repo.transactions.filter(row => isLiveRotationRow(row, accountPublicKey)).first();
    if (rotation) return;
    txId = await initiateRotationFundingClaim(accountPublicKey, notes, opts);
  });
  return txId;
}

/** What this account's consume rows say about a new claim of one note. */
export interface NoteClaimCoverage {
  /** This account's consume rows covering the note, rows restored from a backup excluded. */
  rows: ITransaction[];
  /** A claim that keeps any other out: live, completed, or holding its notes while the reconciler judges it. */
  liveOrCompleted?: ITransaction;
  /** The note's most recent failed claim, while the backoff since it still runs. */
  backingOff?: ITransaction;
}

/**
 * The dedup and backoff reads `queueConsumeRows` makes for one note. Shared with swap settlement, so a reclaim the
 * queue would refuse is never built; the queue runs it inside its rw transaction, so its check and add stay atomic.
 */
export const noteClaimCoverage = async (
  accountId: string,
  noteId: string,
  nowSec: number,
  // The rotation gate's claim (#805) counts only earlier rotation-funding failures in its backoff.
  rotationFunding?: boolean
): Promise<NoteClaimCoverage> => {
  // Read every consume row covering this noteId once (scalar `noteId` index for legacy/single rows, multi-entry
  // `noteIds` for batch rows), then partition: the blocking rows (dedup) and every lifetime Failed (backoff).
  const byScalar = await Repo.transactions.where('noteId').equals(noteId).toArray();
  const byBatch = await Repo.transactions.where('noteIds').equals(noteId).toArray();
  const dedupedRows = new Map([...byScalar, ...byBatch].map(tx => [tx.id, tx]));
  const rows = [...dedupedRows.values()].filter(
    // `restoredFromBackup` rows are excluded: dedup asks "did THIS wallet
    // already claim this note", and a restored row is not evidence of that -
    // it is whatever the backup's author wrote. Counting one would let a
    // dump naming a note id block that note from ever being claimed, for
    // auto-consume and for an explicit Claim alike.
    tx => tx.type === 'consume' && !tx.restoredFromBackup && compareAccountIds(tx.accountId, accountId)
  );

  // A live or completed claim wins, and so does one that holds its notes while the reconciler still judges it
  // (#1081): a second consume would compete for the nullifier the reconciler reads. One that holds nothing does
  // not block, since only a verdict would ever release it.
  const liveOrCompleted = rows.find(
    tx => isLiveTransaction(tx) || tx.status === ITransactionStatus.Completed || holdsNotes(tx, nowSec)
  );

  const failures = rows
    .filter(tx => tx.status === ITransactionStatus.Failed && (!rotationFunding || tx.rotationFunding === true))
    .sort((a, b) => (b.completedAt ?? b.initiatedAt) - (a.completedAt ?? a.initiatedAt));
  const mostRecentFailed = failures[0];
  // Exponential backoff keyed on the note+account's LIFETIME failure count:
  // the required idle gap doubles with every failure (RETRY_COOLDOWN_SEC ·
  // 2^(n-1)), capped at MAX_RETRY_BACKOFF_SEC. Counting lifetime failures -
  // not a sliding window - is what terminates the storm; see the policy note
  // on the constants below (#215, #313).
  const backoffSec = Math.min(RETRY_COOLDOWN_SEC * 2 ** (failures.length - 1), MAX_RETRY_BACKOFF_SEC);
  const backingOff =
    mostRecentFailed && nowSec - (mostRecentFailed.completedAt ?? mostRecentFailed.initiatedAt) < backoffSec
      ? mostRecentFailed
      : undefined;

  return { rows, liveOrCompleted, backingOff };
};

const queueConsumeRows = async (
  accountId: string,
  notes: ConsumableNote[],
  delegateTransaction?: boolean,
  // True when this is an explicit user-initiated claim/retry (the Claim,
  // Retry, Claim All / Claim Group buttons) rather than auto-consume's
  // background polling. The bounded-retry failure gate below exists only to
  // throttle auto-consume's retry storms (#215); it must NOT suppress a user
  // who deliberately taps Retry.
  manualRetry?: boolean,
  // Auto-consume only. A note that already carries a FAILED BATCH row is given a
  // row of its own instead of rejoining a batch.
  //
  // This is what actually delivers the poison-note isolation the auto-consume call
  // sites describe. Their own `try/catch` around this function cannot: this is a
  // queue write, so it throws only on a DB error or the empty-notes guard, while an
  // un-consumable note fails much later, at generation time, inside the processing
  // loop. A Miden transaction is atomic, so that failure fails the whole batch and
  // — because the backoff gate above counts a shared row's failure once for EVERY
  // note id it carries — one poison note dragged its healthy batch-mates into the
  // same doubling backoff, up to the 24h cap. Per-note rows used to confine that to
  // the offending note; batching reinstated it.
  //
  // Splitting on the NEXT enqueue rather than at the moment of failure is deliberate:
  // it keeps this decision inside the same dedup/backoff transaction that already
  // owns "what may be queued for this note", and it never requeues a row as a fresh
  // write — an abandoned pipeline can still submit, so a requeue there could become a
  // second payment. The cost is one recovery pass at N fees after a batch failure,
  // which is the trade the call sites already promise and strictly better than
  // stranding every healthy note for a day.
  //
  // Off by default, because it changes how many rows one call creates: the swap
  // settlement path links its returned id to a swap order, and manual Claim All
  // navigates to it.
  isolateNotesWithFailedBatch?: boolean,
  // The chain's base fee, when the caller is an unattended auto-consumer. Required for
  // isolation to be SAFE, not merely for it to happen.
  //
  // Auto-consume admits a batch when the notes are worth one fee TOGETHER. Isolation
  // then turns that one transaction into N, each paying its own fee -- so a note that
  // only ever justified a shared claim must not be isolated, or the wallet spends more
  // than it collects on its own initiative. With the fee in hand, such a note stays
  // batched instead (see the isolation branch for why batched, not dropped).
  //
  // `null`/omitted isolates every candidate, which is right for a manual retry: the user
  // asked, and `isWorthClaiming` fails open on an unknown fee everywhere else too.
  verificationBaseFee?: number | null,
  // The rotation gate's claim (#805): stamped on every row this creates, and the only
  // earlier failures its backoff counts. An ordinary row's failure (a hot-bound claim, a
  // dApp request) says nothing about whether a recovery-key claim can succeed, and must
  // not park the only way out of the gate.
  rotationFunding?: boolean,
  // The dApp origin whose consume request this is (`initiateConsumeTransactionFromId`): every row this creates lists it
  // from its insert. See `ITransaction.dappOrigins`.
  dappOrigin?: string,
  // Applied before insertion. Used by prepared request rows whose bytes and
  // routing metadata must become visible atomically with the queued row.
  initializeRow?: (row: ConsumeTransaction) => void,
  // Stamped on every row this creates, in the same insert, so a failed claim's report can name it from the row.
  entryPoint?: ConsumeEntryPoint,
  // The service worker's own claims only, which nobody signs while the vault is locked. Asked right before each row
  // is written, after every await of the call, so a lock that landed meanwhile queues nothing: a refusal throws
  // `ClaimInsertRefusedError`, which aborts this Dexie transaction and rolls back the rows the call already wrote.
  canSign?: () => boolean,
  feeContext?: ClaimFeeContext,
  feeNotesById?: ReadonlyMap<string, readonly ClaimFeeNote[]>,
  outgoing?: { spends: readonly IConsumedAssetTotal[]; authorization?: SpendingLimitAuthorization }
): Promise<ConsumeNotesQueueResult> => {
  if (notes.length === 0) {
    throw new Error('initiateConsumeNotesTransaction requires at least one note');
  }

  // This pre-pass saves a WASM probe only; the rw transaction still decides what may be written.
  const mayWrite = await Repo.db.transaction('r', Repo.transactions, async () => {
    const heldNoteIds = new Set((await getNoteHoldingTransactions(accountId)).flatMap(row => row.heldNoteIds ?? []));
    const nowSec = Math.floor(Date.now() / 1000);
    for (const note of notes) {
      const { liveOrCompleted, backingOff } = await noteClaimCoverage(accountId, note.id, nowSec, rotationFunding);
      if (!liveOrCompleted && !heldNoteIds.has(note.id) && (manualRetry || !backingOff)) return true;
    }
    return false;
  });
  const context =
    feeContext ??
    (mayWrite
      ? await readClaimFeeContext(accountId)
      : { vaultFeeAsset: null, nativeAssetId: null, verificationBaseFee: null });

  let outgoingPrice: bigint | SpendingLimitPriceUnavailableError | undefined;
  if (outgoing !== undefined && mayWrite && (await hasSpendingLimits(accountId))) {
    outgoingPrice = await resolveOutgoingSpendUsd(outgoing.spends);
  }
  const tables = outgoing !== undefined ? [Repo.spendingLimits, Repo.transactions] : [Repo.transactions];
  const insertRows = async (): Promise<ConsumeNotesQueueResult | undefined> => {
    const queueable: ConsumableNote[] = [];
    // Notes that have already lost a shared batch row and so must not join another.
    const isolate: ConsumableNote[] = [];
    let blockingId: string | null = null;
    // A skipped note's row is the one that kept it out, not the one the other notes joined.
    const coveringTxIdByNoteId = new Map<string, string>();
    const nowSec = Math.floor(Date.now() / 1000);
    // The notes a dApp transaction will consume, held while it is live or awaiting its verdict and for a grace window
    // after it completed (`isNoteHoldingRow`): a claim of one races that transaction for the note, or follows it into
    // a nullifier the note list has not read yet. Read by `heldNoteIds`, since completion can re-type the row.
    const heldByDappTransaction = new Map<string, string>();
    for (const row of await getNoteHoldingTransactions(accountId)) {
      for (const noteId of row.heldNoteIds ?? []) {
        if (!heldByDappTransaction.has(noteId)) heldByDappTransaction.set(noteId, row.id);
      }
    }

    for (const note of notes) {
      const {
        rows: sameAccount,
        liveOrCompleted,
        backingOff
      } = await noteClaimCoverage(accountId, note.id, nowSec, rotationFunding);
      if (liveOrCompleted) {
        blockingId = blockingId ?? liveOrCompleted.id;
        coveringTxIdByNoteId.set(note.id, liveOrCompleted.id);
        // An explicit user retry must take effect NOW, even when the blocking row
        // is one the loop has backed off (guardian 429 requeue → nextEligibleAt up
        // to 5 min, #617; likewise the 409 / prover-outage requeues). Dedup still
        // wins — we never queue a second row for the same note — but clearing the
        // cooldown lets the existing row be picked on the next cycle instead of
        // making a deliberate tap look like it did nothing. Same reasoning as
        // `requeueFailedTransaction`, which clears it for the Failed-row path.
        if (manualRetry && liveOrCompleted.status === ITransactionStatus.Queued && liveOrCompleted.nextEligibleAt) {
          await Repo.transactions.where({ id: liveOrCompleted.id }).modify((dbTx: ITransaction) => {
            dbTx.nextEligibleAt = undefined;
            // Same reasoning as the cooldown above: a deliberate tap earns a
            // fresh unauthorized-retry budget, or the row stays terminal on its
            // next unauthorized failure however long the user waits.
            dbTx.unauthorizedRetryUntil = undefined;
            // And the guardian backoff, so the tapped row's next requeue waits its arm's base cooldown (#1223).
            dbTx.requeueStreak = undefined;
          });
        }
        continue;
      }

      // Unlike a claim above, a tap leaves the dApp transaction's own backoff alone: it is not a retry of that row.
      const dappTransactionId = heldByDappTransaction.get(note.id);
      if (dappTransactionId !== undefined) {
        blockingId = blockingId ?? dappTransactionId;
        coveringTxIdByNoteId.set(note.id, dappTransactionId);
        continue;
      }

      // Bounded-retry gate: no row blocks this note+account, only Failed ones and claims that hold nothing remain.
      // Skipped entirely for explicit user retries (`manualRetry`) — a deliberate
      // tap must always queue a fresh attempt rather than be throttled by the
      // auto-consume backoff.
      if (!manualRetry && backingOff) {
        blockingId = blockingId ?? backingOff.id;
        coveringTxIdByNoteId.set(note.id, backingOff.id);
        continue;
      }

      // A shared row that failed is not evidence about THIS note — it names every note
      // it carried. Give the note its own row so its next outcome is its own.
      const failedBatchRow = sameAccount.find(
        tx =>
          tx.status === ITransactionStatus.Failed &&
          (tx.noteIds?.length ?? 0) > 1 &&
          (!rotationFunding || tx.rotationFunding === true)
      );
      // A row of its own means a FEE of its own, so only a note that can pay for a
      // transaction by itself may be isolated. Auto-consume admits a batch on what its
      // notes are worth TOGETHER, which says nothing about any one of them.
      //
      // A note that cannot fund its own transaction therefore STAYS IN THE BATCH, and
      // that is the whole answer for it: batched is the only way it can ever be claimed,
      // so removing it from batches means the wallet never claims it at all. Twenty
      // notes at 20x the base fee are each below the floor and together worth 400x — an
      // earlier revision of this dropped every one of them, permanently, because the
      // failed-batch row that made them isolation candidates is never pruned.
      //
      // The residual is that such a note can fail a batch again and cost its mates
      // another lap of the #215 backoff. That is bounded (the backoff doubles and the
      // batch total is re-checked each pass) and strictly better than stranding real
      // value forever, whereas isolating it would pay a fee larger than it collects.
      if (isolateNotesWithFailedBatch && failedBatchRow && isWorthClaiming(note.amount, verificationBaseFee ?? null)) {
        isolate.push(note);
      } else {
        queueable.push(note);
      }
    }

    // Isolation must not leave behind a batch that cannot pay for its own transaction.
    // The caller measured the FULL set against one fee; pulling the worthy notes out
    // into rows of their own leaves a remainder that was never measured on its own, and
    // a remainder of one below-floor note is simply that note claimed alone at a loss --
    // exactly what excluding it from isolation was meant to avoid.
    //
    // So when the remainder cannot stand by itself, nothing is isolated this pass: the
    // whole set goes out as one batch for one fee, which is what the caller verified.
    // The poison note keeps its mates for one more lap of the #215 backoff, and no note
    // is either claimed at a loss or stranded.
    if (
      isolate.length > 0 &&
      queueable.length > 0 &&
      !isWorthClaiming(totalClaimableAmount(queueable.map(n => n.amount)), verificationBaseFee ?? null)
    ) {
      queueable.push(...isolate);
      isolate.length = 0;
    }

    if (queueable.length === 0 && isolate.length === 0) {
      return { committedId: blockingId!, coveringTxIdByNoteId, feeRefusedNoteIds: [] };
    }

    // A cap created after the price probe needs a value before admission. Leave the lock and
    // resolve it, then run dedup again in the new write transaction before admitting any row.
    if (outgoing !== undefined && outgoingPrice === undefined && (await hasSpendingLimits(accountId))) {
      return undefined;
    }

    const ahead = await getClaimFeeAhead(accountId);
    const feeRefusedNoteIds: string[] = [];
    const createdIds: string[] = [];
    // No await between the check and the write it guards.
    const insert = async (rowNotes: ConsumableNote[]): Promise<void> => {
      const feeNotes = claimFeeNotes(rowNotes, feeNotesById);
      const [decision] = claimFeeDecisions(
        [feeNotes],
        ahead,
        context.vaultFeeAsset,
        context.nativeAssetId,
        context.verificationBaseFee
      );
      if (decision?.shortfall) {
        feeRefusedNoteIds.push(...rowNotes.map(note => note.id));
        return;
      }
      const row = newRow(rowNotes);
      row.feeAdmission = decision?.admission;
      if (canSign && !canSign()) throw new ClaimInsertRefusedError();
      const admitted =
        outgoing === undefined
          ? row
          : await admitOutgoingTransaction(row, outgoing.spends, outgoingPrice, outgoing.authorization, nowSec);
      await Repo.transactions.add(admitted);
      createdIds.push(row.id);
      for (const note of rowNotes) coveringTxIdByNoteId.set(note.id, row.id);
      // Keep the original facts: no earlier row's fee is charged against a later row.
      ahead.push(...feeNotes);
    };
    const newRow = (rowNotes: ConsumableNote[]): ConsumeTransaction => {
      const row = Object.assign(new ConsumeTransaction(accountId, rowNotes, delegateTransaction, feeNotesById), {
        badgeNetwork: badgeNetwork()
      });
      if (rotationFunding) row.rotationFunding = true;
      if (dappOrigin !== undefined) row.dappOrigins = [dappOrigin];
      if (entryPoint !== undefined) row.consumeEntryPoint = entryPoint;
      initializeRow?.(row);
      return row;
    };
    // One row EACH for the isolated notes, then one shared row for the remainder. A
    // single-note row is exactly what `initiateConsumeTransaction` produces, so an
    // isolated note rejoins the ordinary per-note lifecycle.
    for (const note of isolate) {
      await insert([note]);
    }
    if (queueable.length > 0) {
      await insert(queueable);
    }
    const committedId = createdIds[0] ?? blockingId;
    if (committedId === null) throw new ClaimFeeRefusedError();
    return { committedId, coveringTxIdByNoteId, feeRefusedNoteIds };
  };
  const result = await Repo.db.transaction('rw', tables, insertRows);
  if (result !== undefined) return result;
  outgoingPrice = await resolveOutgoingSpendUsd(outgoing!.spends);
  return (await Repo.db.transaction('rw', tables, insertRows))!;
};

/** {@link queueConsumeNotes}, for the callers that need only the committed row id. */
export const initiateConsumeNotesTransaction = async (...args: Parameters<typeof queueConsumeNotes>): Promise<string> =>
  (await queueConsumeNotes(...args)).committedId;

/**
 * Bounded-retry policy for auto-consume.
 *
 * Background: the consume dedup at `initiateConsumeTransaction` excludes
 * `Failed` rows by design so retries can recover from *transient* failures
 * (e.g., kernel `auth::request` errors that clear once chain state
 * advances). But without a brake, an upstream deterministic failure
 * combined with auto-consume's polling cadence + tab-switch remounts
 * produces an unbounded retry storm — one user empirically observed 122+
 * consume/Failed rows for 2 notes in 38 minutes (#215).
 *
 * The original #215 fix was a sliding *window* throttle (cap N failures per
 * 30 min, then one attempt per 5 min). That bounds the *rate* but never the
 * *lifetime*: old failures age out of the window, so a note that
 * `getConsumableNotes` keeps offering yet that fails on-chain every time (a
 * deterministic rejection the consumability annotation misses, a `mock`
 * network, an "already consumed" race) drips one failure every 5 min
 * forever — 49 failures over 4 days in the captured profile (#313).
 *
 * Policy (terminal-safe exponential backoff):
 *   - n = the note+account's LIFETIME Failed rows.
 *   - Require RETRY_COOLDOWN_SEC · 2^(n-1) of idle since the most recent
 *     Failed `completedAt` before allowing another attempt, capped at
 *     MAX_RETRY_BACKOFF_SEC.
 *
 * The interval therefore grows without bound (5 min → 10 → 20 → … → 24 h),
 * so the storm decays to at most a daily probe. It stays a *probe*, not a
 * permanent give-up: a note that later becomes consumable (its reclaim
 * height is reached, chain state advances) is retried at the next expiry and
 * recovers on its own — no failure-class parsing, no stuck-forever state. A
 * transient failure that clears early still retries promptly because a
 * Completed row reactivates the existing-non-Failed dedup branch, and an
 * explicit user Retry (`manualRetry`) bypasses the backoff entirely.
 */
export const RETRY_COOLDOWN_SEC = 5 * 60; // 5 minutes — base backoff after the first failure
export const MAX_RETRY_BACKOFF_SEC = 24 * 60 * 60; // 24 hours — backoff ceiling

/**
 * Queue a swap (PSWAP-create) transaction: the account offers `offeredAmount`
 * of `offeredFaucetId` in exchange for `requestedAmount` of `requestedFaucetId`.
 * The offered side maps onto `faucetId`/`amount`; the requested side lives in
 * `extraInputs`. Dispatched via `MidenClientInterface.swapTransaction`.
 */
export const initiateSwapTransaction = async (
  accountId: string,
  offeredFaucetId: string,
  offeredAmount: bigint,
  requestedFaucetId: string,
  requestedAmount: bigint,
  delegateTransaction?: boolean,
  expirySeconds: number = 120,
  autoConsume: boolean = true,
  slippageBps?: number,
  spendingLimitAuthorization?: SpendingLimitAuthorization
): Promise<string> => {
  const scope = cacheScope();
  await assertSwapVaultBalance(accountId, offeredFaucetId, offeredAmount, scope);
  const dbTransaction = new SwapTransaction(
    accountId,
    offeredFaucetId,
    offeredAmount,
    requestedFaucetId,
    requestedAmount,
    delegateTransaction,
    expirySeconds,
    autoConsume,
    slippageBps
  );
  dbTransaction.extraInputs.balanceScope = scope;
  await queueOutgoingTransaction(
    { ...dbTransaction, badgeNetwork: badgeNetwork() },
    spendsOf(dbTransaction),
    spendingLimitAuthorization,
    undefined,
    () => assertSwapQueueAvailable(accountId, scope)
  );

  return dbTransaction.id;
};

/**
 * Queue a send.
 *
 * Refuses a PRIVATE send outright when no note-transport endpoint is configured
 * for the effective network, rather than queueing one that cannot possibly be
 * delivered. Throwing here is the whole point: this runs BEFORE anything is
 * queued, proved or submitted, so the user keeps their assets and sees an error
 * they can act on. Allowing it through inverts that: with no transport every relay
 * fails with `NoteTransportError::Disabled` and no retry can do better, so the send
 * would land on chain and reach nobody. Every private send on such a network would
 * be an unrecoverable loss.
 *
 * This is not hypothetical: `MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS` has no mainnet
 * entry, and mainnet is a selectable network.
 *
 * Public sends are unaffected — the chain carries the whole note, so they need no
 * transport at all and must keep working on a transport-less network.
 */
export const initiateSendTransaction = async (
  senderAccountId: string,
  recipientAccountId: string,
  faucetId: string,
  noteType: NoteTypeString,
  amount: bigint,
  recallBlocks?: number,
  delegateTransaction?: boolean,
  spendingLimitAuthorization?: SpendingLimitAuthorization,
  /** The dApp origin asking; absent for the wallet's own sends. See `ITransaction.dappOrigins`. */
  dappOrigin?: string,
  oneClick?: IOneClickTrackingData
): Promise<string> => {
  // Every send funnels through here — the wallet's own review screen and the
  // dApp boundary both — so this is where the reclaim window has to be sound.
  // It is stored on chain as a 32-bit block height, and a value that does not
  // fit is truncated rather than refused: a window just past the limit wraps to
  // zero and the note becomes reclaimable the moment it lands, while the screen
  // that asked for consent says years. The review screen reaches this by
  // `parseInt`ing a date the user picked from a calendar, so an out-of-range
  // choice is a couple of taps away and needs no hostile page at all.
  assertValidRecallBlocks(recallBlocks);

  if (oneClick) {
    assertOneClickQuoteBinding(oneClick.request, oneClick.quote, false, oneClick.config);
    const fundingDeadline = assertOneClickFundingDeadlineMatches(
      oneClick.fundingDeadline,
      oneClick.request.deadline,
      oneClick.quote.quote.deadline
    );
    oneClick = { ...oneClick, fundingDeadline };
    const midenAsset = oneClick.originAsset;
    const configuredAsset = oneClick.config.midenAssets.find(asset => asset.assetId === midenAsset.assetId);
    if (
      oneClick.direction !== 'miden-to-evm' ||
      midenAsset.blockchain !== 'miden' ||
      oneClick.destinationAsset.blockchain === 'miden' ||
      oneClick.accountId !== senderAccountId ||
      !sameWalletAccountId(oneClick.request.refundTo, oneClick.accountAddress) ||
      !sameWalletAccountId(oneClick.accountAddress, senderAccountId) ||
      oneClick.quote.quote.depositAddress !== recipientAccountId ||
      oneClick.quote.quote.amountIn !== amount.toString() ||
      oneClick.faucetId !== faucetId ||
      !configuredAsset ||
      configuredAsset.faucetId !== faucetId
    ) {
      throw new Error('The 1Click send does not match the signed Miden route.');
    }
  }

  if (noteType === NoteTypeEnum.Private && !isNoteTransportConfigured()) {
    throw new Error(
      'Private sends are unavailable on this network: no note transport service is configured, so the recipient could never receive the note. Send publicly instead.'
    );
  }

  const dbTransaction = new SendTransaction(
    senderAccountId,
    amount,
    recipientAccountId,
    faucetId,
    noteType,
    recallBlocks,
    delegateTransaction
  );
  if (oneClick) dbTransaction.extraInputs = { ...dbTransaction.extraInputs, oneClick };
  if (dappOrigin !== undefined) dbTransaction.dappOrigins = [dappOrigin];
  await queueOutgoingTransaction(
    { ...dbTransaction, badgeNetwork: badgeNetwork() },
    spendsOf(dbTransaction),
    spendingLimitAuthorization
  );

  return dbTransaction.id;
};

/**
 * Queue a cross-chain Miden→EVM send (`bridged-send`). For the agglayer (Slow)
 * route, `requestBytes` is a pre-built B2AGG `TransactionRequest` (own output
 * note). For the epoch (Fast) route, `requestBytes` is the pre-built P2IDE
 * collateral request carrying the mandate-binding attachment (smallocator
 * PR #38, built by `buildEpochCollateralRequestBytes`) and `bridgeEpochSend`
 * drives the surrounding intent out-of-band. Either way the standard pipeline
 * proves + submits the request via `newTransaction`, then
 * `completeBridgedSendTransaction` records it.
 */
export const initiateBridgedSendTransaction = async (
  accountId: string,
  amount: bigint,
  faucetId: string,
  destinationAddress: string,
  destinationNetwork: number,
  provider: IBridgeProvider,
  requestBytes?: Uint8Array,
  delegateTransaction?: boolean,
  sendParams?: IBridgedSendNoteParams,
  spendingLimitAuthorization?: SpendingLimitAuthorization,
  agglayerExitTxHash?: string,
  usdcxBurn?: IUsdcxBurn,
  agglayerRoute?: AgglayerRecoveryConfig,
  epochAllocatorUrl?: string
): Promise<string> => {
  const dbTransaction = new BridgedSendTransaction(
    accountId,
    amount,
    destinationAddress,
    destinationNetwork,
    provider,
    faucetId,
    requestBytes,
    delegateTransaction,
    sendParams,
    agglayerExitTxHash
  );
  if (provider === 'agglayer') {
    if (!agglayerRoute) throw new Error('AggLayer recovery values are required');
    dbTransaction.extraInputs.agglayerRoute = agglayerRoute;
  }
  if (provider === 'epoch') dbTransaction.extraInputs.epochAllocatorUrl = epochAllocatorUrl;
  if (provider === 'usdcx') {
    if (!requestBytes || !usdcxBurn) throw new Error('USDCx burn requires a persisted request and note id');
    dbTransaction.extraInputs.usdcxBurn = usdcxBurn;
    dbTransaction.noteType = NoteTypeEnum.Public;
  }
  await queueOutgoingTransaction(dbTransaction, spendsOf(dbTransaction), spendingLimitAuthorization);

  return dbTransaction.id;
};

/**
 * Queue the recallable Miden P2IDE note that collateralizes an Earn deposit.
 * `requestBytes` is the pre-built P2IDE collateral request carrying the
 * mandate-binding attachment (smallocator PR #38, built by
 * `buildEpochCollateralRequestBytes`); the pipeline submits it verbatim.
 * Nothing downstream can rebuild that binding, so a call without the bytes
 * throws `EARN_DEPOSIT_MISSING_REQUEST_ERROR` before the row is queued or its
 * spend is booked.
 */
export const initiateEarnDepositTransaction = async (
  accountId: string,
  amount: bigint,
  evmRecipient: string,
  marketUid: string,
  faucetId: string,
  sendParams: IBridgedSendNoteParams,
  delegateTransaction: boolean,
  requestBytes: Uint8Array,
  spendingLimitAuthorization?: SpendingLimitAuthorization,
  epochAllocatorUrl?: string,
  protocol?: '1delta' | 'dummy-lending',
  chainId?: number
): Promise<string> => {
  if (!requestBytes?.length) throw new Error(EARN_DEPOSIT_MISSING_REQUEST_ERROR);
  const dbTransaction = new EarnDepositTransaction(
    accountId,
    amount,
    evmRecipient,
    marketUid,
    faucetId,
    sendParams,
    delegateTransaction,
    requestBytes,
    protocol,
    chainId
  );
  dbTransaction.extraInputs.epochAllocatorUrl = epochAllocatorUrl;
  await queueOutgoingTransaction(dbTransaction, spendsOf(dbTransaction), spendingLimitAuthorization);
  return dbTransaction.id;
};

/**
 * Insert the tracking-only row for a Smart Withdraw. The row is born `Completed`
 * (see `EarnWithdrawTransaction`) so it never enters the prove/submit FIFO loop;
 * its lifecycle is driven by `updateEarnWithdrawPhase` (complete.ts).
 */
export const initiateEarnWithdrawTransaction = async (
  accountId: string,
  amount: bigint,
  evmOwner: string,
  marketUid: string,
  faucetId: string,
  sourceAmount: string,
  sourceSymbol = 'USDC',
  submissionAttemptId?: string,
  attemptStartedAt?: number,
  sourceDecimals?: number,
  protocol?: '1delta' | 'dummy-lending',
  chainId?: number
): Promise<string> => {
  const dbTransaction = new EarnWithdrawTransaction(
    accountId,
    amount,
    evmOwner,
    marketUid,
    faucetId,
    sourceAmount,
    sourceSymbol,
    submissionAttemptId,
    attemptStartedAt,
    sourceDecimals,
    protocol,
    chainId
  );
  await Repo.transactions.add(dbTransaction);
  return dbTransaction.id;
};

/** Insert a tracking-only EVM → Miden bridge row. */
export const initiateBridgedReceiveTransaction = async (args: {
  accountId: string;
  amount: bigint;
  faucetId: string;
  provider: IBridgeProvider;
  sourceAddress: string;
  sourceChainId?: number;
  agglayerRoute?: AgglayerRecoveryConfig;
  /** agglayer: the deposited ERC-20's delivery faucet; absent on a native-ETH deposit. */
  agglayerDelivery?: IAgglayerDelivery;
  usdcxSource?: UsdcxSourceChain;
  epochAllocatorUrl?: string;
  sourceAmount: string;
  sourceSymbol: string;
  outputAmount?: string;
  outputSymbol?: string;
}): Promise<string> => {
  const dbTransaction = new BridgedReceiveTransaction(
    args.accountId,
    args.amount,
    args.faucetId,
    args.provider,
    args.sourceAddress,
    args.sourceAmount,
    args.sourceSymbol,
    args.outputAmount,
    args.outputSymbol
  );
  dbTransaction.extraInputs.sourceChainId = args.sourceChainId;
  if (args.provider === 'agglayer') {
    if (!args.agglayerRoute) throw new Error('AggLayer recovery values are required');
    dbTransaction.extraInputs.agglayerRoute = args.agglayerRoute;
    if (args.agglayerDelivery) dbTransaction.extraInputs.agglayerDelivery = args.agglayerDelivery;
  }
  if (args.provider === 'epoch') dbTransaction.extraInputs.epochAllocatorUrl = args.epochAllocatorUrl;
  if (args.provider === 'usdcx' && args.sourceChainId !== undefined) {
    dbTransaction.extraInputs.usdcxSource = args.usdcxSource ?? usdcxSourceChains().get(args.sourceChainId);
    dbTransaction.extraInputs.usdcxMidenDomain =
      dbTransaction.extraInputs.usdcxSource?.midenDomain ?? getUsdcxRemoteDomain();
  }
  await Repo.transactions.add({ ...dbTransaction, badgeNetwork: badgeNetwork() });
  return dbTransaction.id;
};

/**
 * The stored Guardian account a structural change targets, or `refusal` thrown. The row is queued under
 * its `publicKey`, not the caller's spelling: completion otherwise learns the stored id only from a
 * post-commit account read, and when that read fails it acts on the queued spelling, which the vault
 * matches exactly and so misses.
 */
const resolveGuardianWalletAccount = async (
  accountId: string,
  guardianProvider: GuardianAccountProvider,
  refusal: string
): Promise<WalletAccount> => {
  const accounts = await guardianProvider.getAccounts();
  const account = accounts.find(candidate => sameWalletAccountId(candidate.publicKey, accountId));
  if (!account || account.type !== WalletType.Guardian) {
    throw new Error(refusal);
  }
  return account;
};

/**
 * Queue a switch-guardian transaction for a Guardian account. The per-account
 * `guardianEndpoint` is NOT updated here — it's persisted only after the
 * on-chain proposal lands, in `completeSwitchGuardianTransaction`.
 *
 * Deduped against a rotation that is already in flight for this account. Unlike
 * the value-moving types, a duplicate here is not merely wasteful: rotations are
 * serialized per account (`withGuardianAccountLock`), so the second row starts
 * only AFTER the first has committed and persisted the new endpoint, and it then
 * performs a whole second on-chain `update_guardian` to the guardian the account
 * already has. Returning the live id instead sends the caller to the rotation
 * that is actually running — the UI navigates to `/generating-transaction/:txId`
 * with whatever comes back — but only when the in-flight row targets the SAME
 * operator; a request for a different one is refused rather than silently
 * redirected (see the check below).
 *
 * Completed and Failed rows are deliberately NOT deduped against: a finished
 * rotation must never block the next one, and a failed rotation is the case the
 * user most needs to be able to re-run (`switch-guardian` has no Retry).
 */
export const initiateSwitchGuardianTransaction = async (
  accountId: string,
  newGuardianEndpoint: string,
  delegateTransaction: boolean | undefined,
  guardianProvider: GuardianAccountProvider
): Promise<string> => {
  const account = await resolveGuardianWalletAccount(
    accountId,
    guardianProvider,
    'Switch guardian is only supported for Guardian accounts'
  );
  const storedAccountId = account.publicKey;
  const previousGuardianEndpoint = resolveGuardianEndpoint(account);

  // Check-and-add inside one rw transaction, like the consume dedup above, so
  // two taps landing together cannot both pass the check.
  //
  // `filter` rather than an index lookup: `type` is not an indexed key path (see
  // the v1.5 schema in repo.ts), and `accountId` is indexed but only matches an
  // exact string, whereas the same account can be spelled more than one way —
  // which is why `compareAccountIds` exists. A scan of the transaction table is
  // what `getAllUncompletedTransactions` already does per queue lap.
  return Repo.db.transaction('rw', Repo.transactions, async () => {
    const inFlightRows = await Repo.transactions
      .filter(
        row =>
          row.type === 'switch-guardian' &&
          !row.restoredFromBackup &&
          (row.status === ITransactionStatus.Queued || row.status === ITransactionStatus.GeneratingTransaction)
      )
      .toArray();
    const inFlight = inFlightRows.find(row => compareAccountIds(row.accountId, storedAccountId));
    if (inFlight) {
      // Returning the live id is right only for a genuine duplicate — the same
      // rotation, asked for twice. When the in-flight row targets a DIFFERENT
      // operator, handing back its id would navigate the user to a rotation to
      // an endpoint they did not choose and report it as theirs, and nothing
      // downstream would ever correct it (`TransactionSummaryBadge` renders
      // nothing for `switch-guardian`). Refuse instead, naming the rotation that
      // holds the account, so the caller can say what is actually running.
      //
      // An in-flight row with NO recorded endpoint is refused too. `type` says
      // it is always present, so an empty one means a corrupt or truncated row —
      // and "I cannot tell what that rotation targets" is not grounds for
      // claiming it is this one.
      const inFlightEndpoint = inFlight.extraInputs?.newGuardianEndpoint;
      if (!inFlightEndpoint || !sameGuardianEndpoint(inFlightEndpoint, newGuardianEndpoint)) {
        throw new GuardianRotationInProgressError(inFlightEndpoint);
      }
      return inFlight.id;
    }

    const dbTransaction = new SwitchGuardianTransaction(
      storedAccountId,
      newGuardianEndpoint,
      delegateTransaction,
      previousGuardianEndpoint
    );
    await Repo.transactions.add(dbTransaction);
    return dbTransaction.id;
  });
};

/**
 * Queue a replace-hot-key transaction for a Guardian account. The new hot key
 * is generated lazily inside `generateGuardianTransaction` (so the cold service
 * + secureHotKey facade are only touched once we're actually processing the
 * tx) and persisted to the vault BEFORE submission. Cold-signed; default
 * `update_signers` threshold (1) means cold alone satisfies on-chain.
 *
 * `mode` selects the target signer set. `replace` (the default) removes the
 * other device keys. `add` keeps them and adds the new hot key. The row
 * records the mode, so a later run of the row uses the same mode.
 */
export const initiateReplaceHotKeyTransaction = async (
  accountId: string,
  delegateTransaction: boolean | undefined,
  guardianProvider: GuardianAccountProvider,
  mode: HotKeyActivationMode = 'replace'
): Promise<string> => {
  const account = await resolveGuardianWalletAccount(
    accountId,
    guardianProvider,
    'Replace hot key is only supported for Guardian accounts'
  );
  const dbTransaction = new ReplaceHotKeyTransaction(account.publicKey, delegateTransaction);
  // Record the guardian now: the account's endpoint moves with any later switch, and the history row
  // must keep naming the one this rotation ran under. That is the endpoint every guardian operation
  // resolves (the account's own, else the network default), as the switch records its previous one.
  const guardianEndpoint = resolveGuardianEndpoint(account);
  dbTransaction.extraInputs = guardianEndpoint ? { mode, guardianEndpoint } : { mode };
  return queueRecoveryChange(dbTransaction);
};

// The on-chain hardening a freshly-created 3-key Guardian account gets (see
// createGuardianAccount): changing the guardian requires both device keys.
// Creation also pins `update_procedure_threshold` to 2 so this override can't be
// lowered by one signer; that pairing is only reachable at build time, so this
// self-heal — which repairs pre-0.17 accounts whose hardening tx was dropped —
// still checks and raises the one procedure it was written for.
const GUARDIAN_PROCEDURE_HARDENING = { procedure: 'update_guardian', threshold: 2 } as const;

/**
 * Ensure a Guardian account carries the `update_guardian` threshold-2 hardening
 * that fresh 3-key accounts have. Migrated legacy accounts lack it; recovered /
 * fresh accounts already have it (so this no-ops). Enqueues a cold-signed
 * `update_procedure_threshold` when missing.
 *
 * Best-effort with ONE exception: a WASM client eviction is re-thrown. This used
 * to be a blanket catch, and "never throws" is the wrong contract for a function
 * whose first act is `getOrCreateMultisigService` - a hold, reached on any
 * service-cache miss, whose `MultisigService.init` raises
 * `WasmClientPoisonedError` by design. Swallowed into `undefined`, an eviction
 * was answered as "the hardening is not worth doing": the guardian sync's own
 * poison `.catch` on this call was unreachable code, the pass went on to the
 * next account and took fresh holds while the abandoned call was still inside
 * WASM, and the lap was booked as a clean guardian success - the fuse falsely
 * exonerated for the very park it exists to record. An eviction is not a verdict
 * on the hardening; it is the realm telling every caller to stop taking holds,
 * and it has to reach them.
 *
 * The other side of that contract belongs to the caller: this function is called
 * PAST the terminal status write on the rotation-completion path, so a caller
 * whose catch marks the transaction failed must scope its own (see
 * `completeReplaceHotKeyTransaction`).
 *
 * Idempotent (gated on the on-chain threshold already being 2), so besides the
 * post-rotation call it's also invoked self-healingly from the guardian sync —
 * closing the window where a migrated account is 3-key but `update_guardian` is
 * still threshold-1 because the original hardening tx was dropped.
 *
 * Returns the queued transaction's id when it actually enqueued one, and
 * `undefined` when the account was already hardened or the check failed. The
 * `requestSWTransactionProcessing()` nudge below is EXTENSION-ONLY (it returns
 * immediately off-extension), and this function is deliberately kept free of any
 * frontend imports — pulling `lib/store` in here would drag Zustand into the
 * service-worker init chain. So a caller that runs off-extension and is not
 * itself inside `generateTransactionsLoop` must take the returned id as its cue
 * to start the loop (see `syncGuardianAccounts`); otherwise the row would sit
 * Queued until the next app launch reaped or resumed it.
 */
export const ensureGuardianProcedureThresholds = async (
  accountId: string,
  delegateTransaction: boolean | undefined,
  guardianProvider: GuardianAccountProvider,
  /**
   * Bound the service build's hold at the sync ceiling rather than the
   * five-minute backstop - passed by the cadence caller (the idle loop's
   * guardian sync) and nobody else, exactly as `getOrCreateMultisigService`
   * documents for its own parameter. Left unset, a hold reached from the ~3 s
   * loop armed at the backstop, which is five minutes of frozen wallet per lap
   * and four laps to light the account's fuse. Narrowly reachable - it needs a
   * service-cache miss - but that miss is precisely the post-eviction
   * generation bump the sync ceiling exists for.
   */
  boundAtSyncCeiling = false
): Promise<string | undefined> => {
  try {
    // Loading the service fetches the on-chain account config, including its
    // procedure thresholds.
    const service = await getOrCreateMultisigService(accountId, guardianProvider, boundAtSyncCeiling);
    if (
      service.getProcedureThreshold(GUARDIAN_PROCEDURE_HARDENING.procedure) === GUARDIAN_PROCEDURE_HARDENING.threshold
    ) {
      return undefined;
    }
    const txId = await initiateUpdateProcedureThresholdTransaction(
      accountId,
      GUARDIAN_PROCEDURE_HARDENING.procedure,
      GUARDIAN_PROCEDURE_HARDENING.threshold,
      delegateTransaction,
      guardianProvider
    );
    // Nudge the processor to pick up the freshly-queued tx. Dynamic import to
    // avoid a static cycle with the activity barrel. Scoped catch: the row is
    // already persisted at this point, so a failed nudge must not swallow its id —
    // the caller needs it to start the loop off-extension. A row left un-nudged is
    // still picked up by the next processing cycle.
    try {
      const { requestSWTransactionProcessing } = await import('lib/miden/activity');
      requestSWTransactionProcessing();
    } catch (nudgeError) {
      console.warn('[guardian] could not nudge the transaction processor for the hardening tx:', nudgeError);
    }
    return txId;
  } catch (e) {
    // The one error that is not about the hardening. See the contract above:
    // an eviction abandons a call that is still inside WASM, so it has to reach
    // the caller rather than be reported as "already hardened".
    if (isWasmClientPoisonedError(e)) throw e;
    console.warn('[guardian] procedure-threshold hardening skipped (non-fatal):', e);
    return undefined;
  }
};

export const initiateUpdateProcedureThresholdTransaction = async (
  accountId: string,
  procedure: string,
  threshold: number,
  delegateTransaction: boolean | undefined,
  guardianProvider: GuardianAccountProvider
): Promise<string> => {
  const account = await resolveGuardianWalletAccount(
    accountId,
    guardianProvider,
    'update-procedure-threshold is only supported for Guardian accounts'
  );
  const dbTransaction = new UpdateProcedureThresholdTransaction(
    account.publicKey,
    procedure,
    threshold,
    delegateTransaction
  );
  return queueRecoveryChange(dbTransaction);
};

async function queueRecoveryChange(transaction: ITransaction): Promise<string> {
  return Repo.db.transaction('rw', Repo.transactions, async () => {
    const existing = await Repo.transactions
      .filter(
        row =>
          !row.restoredFromBackup &&
          row.type === transaction.type &&
          compareAccountIds(row.accountId, transaction.accountId) &&
          (row.status === ITransactionStatus.Queued || row.status === ITransactionStatus.GeneratingTransaction) &&
          row.extraInputs?.procedure === transaction.extraInputs?.procedure &&
          row.extraInputs?.threshold === transaction.extraInputs?.threshold
      )
      .first();
    if (existing) return existing.id;
    await Repo.transactions.add(transaction);
    return transaction.id;
  });
}
