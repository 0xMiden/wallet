import { isWorthClaiming, totalClaimableAmount } from 'lib/miden/fees/spendable';
import {
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from 'lib/miden/front/guardian-manager';
import { resolveGuardianEndpoint } from 'lib/miden/guardian/account';
import { GuardianRotationInProgressError } from 'lib/miden/guardian/rotation-in-progress';
import * as Repo from 'lib/miden/repo';
import { isNoteTransportConfigured } from 'lib/miden-chain/effective-endpoints';
import { sanitizeGuardianUrl } from 'lib/settings/helpers';
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
  IBridgedSendNoteParams,
  IBridgeProvider,
  ITransaction,
  ITransactionStatus,
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
import { ConsumableNote, NoteTypeEnum, NoteType as NoteTypeString } from '../types';

export const requestCustomTransaction = async (
  accountId: string,
  transactionRequestBytes: string,
  inputNoteIds?: string[],
  importNotes?: string[],
  delegateTransaction?: boolean,
  recipientAccountId?: string
): Promise<string> => {
  const byteArray = new Uint8Array(Buffer.from(transactionRequestBytes, 'base64'));
  const transaction = new Transaction(accountId, byteArray, inputNoteIds, delegateTransaction, recipientAccountId);
  await Repo.transactions.add(transaction);

  if (importNotes) {
    for (const noteBytes of importNotes) {
      await queueNoteImport(noteBytes);
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
  manualRetry?: boolean
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

  return await initiateConsumeTransaction(accountId, note, delegateTransaction, manualRetry);
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
  manualRetry?: boolean
): Promise<string> => {
  return initiateConsumeNotesTransaction(accountId, [note], delegateTransaction, manualRetry);
};

/**
 * Queue ONE consume transaction for many notes (Claim All / Claim Group) —
 * both the WASM client (`transactions.consume({ notes })`) and the Guardian
 * consume proposal accept multiple note ids, so batching is one proof/submit
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
 * a stable "this note already has a tx" response.
 */
export const initiateConsumeNotesTransaction = async (
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
  verificationBaseFee?: number | null
): Promise<string> => {
  if (notes.length === 0) {
    throw new Error('initiateConsumeNotesTransaction requires at least one note');
  }

  const { committedId } = await Repo.db.transaction('rw', Repo.transactions, async () => {
    const queueable: ConsumableNote[] = [];
    // Notes that have already lost a shared batch row and so must not join another.
    const isolate: ConsumableNote[] = [];
    let blockingId: string | null = null;

    for (const note of notes) {
      // Read every consume row covering this noteId once (scalar `noteId`
      // index for legacy/single rows, multi-entry `noteIds` for batch rows),
      // then partition. We need both non-Failed (dedup) and every lifetime Failed
      // (exponential-backoff gate) inside the same rw transaction so the
      // check-and-add stays atomic.
      const byScalar = await Repo.transactions.where('noteId').equals(note.id).toArray();
      const byBatch = await Repo.transactions.where('noteIds').equals(note.id).toArray();
      const dedupedRows = new Map([...byScalar, ...byBatch].map(tx => [tx.id, tx]));
      const sameAccount = [...dedupedRows.values()].filter(
        // `restoredFromBackup` rows are excluded: dedup asks "did THIS wallet
        // already claim this note", and a restored row is not evidence of that —
        // it is whatever the backup's author wrote. Counting one would let a
        // dump naming a note id block that note from ever being claimed, for
        // auto-consume and for an explicit Claim alike.
        tx => tx.type === 'consume' && !tx.restoredFromBackup && compareAccountIds(tx.accountId, accountId)
      );

      // Existing non-Failed dedup: a Queued / GeneratingTransaction / Completed row wins.
      const liveOrCompleted = sameAccount.find(tx => tx.status !== ITransactionStatus.Failed);
      if (liveOrCompleted) {
        blockingId = blockingId ?? liveOrCompleted.id;
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
          });
        }
        continue;
      }

      // Bounded-retry gate: only Failed rows exist for this note+account.
      // Skipped entirely for explicit user retries (`manualRetry`) — a deliberate
      // tap must always queue a fresh attempt rather than be throttled by the
      // auto-consume backoff.
      if (!manualRetry) {
        const nowSec = Math.floor(Date.now() / 1000);
        const failures = sameAccount
          .filter(tx => tx.status === ITransactionStatus.Failed)
          .sort((a, b) => (b.completedAt ?? b.initiatedAt) - (a.completedAt ?? a.initiatedAt));
        if (failures.length > 0) {
          const mostRecentFailed = failures[0]!;
          const mostRecentCompletedAt = mostRecentFailed.completedAt ?? mostRecentFailed.initiatedAt;
          const secsSinceLastFailure = nowSec - mostRecentCompletedAt;
          // Exponential backoff keyed on the note+account's LIFETIME failure count:
          // the required idle gap doubles with every failure (RETRY_COOLDOWN_SEC ·
          // 2^(n-1)), capped at MAX_RETRY_BACKOFF_SEC. Counting lifetime failures —
          // not a sliding window — is what terminates the storm; see the policy note
          // on the constants below (#215, #313).
          const backoffSec = Math.min(RETRY_COOLDOWN_SEC * 2 ** (failures.length - 1), MAX_RETRY_BACKOFF_SEC);
          if (secsSinceLastFailure < backoffSec) {
            blockingId = blockingId ?? mostRecentFailed.id;
            continue;
          }
        }
      }

      // A shared row that failed is not evidence about THIS note — it names every note
      // it carried. Give the note its own row so its next outcome is its own.
      const failedBatchRow = sameAccount.find(
        tx => tx.status === ITransactionStatus.Failed && (tx.noteIds?.length ?? 0) > 1
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
      return { committedId: blockingId!, queuedNoteIds: [] as string[] };
    }

    const createdIds: string[] = [];
    // One row EACH for the isolated notes, then one shared row for the remainder. A
    // single-note row is exactly what `initiateConsumeTransaction` produces, so an
    // isolated note rejoins the ordinary per-note lifecycle.
    for (const note of isolate) {
      const isolatedRow = new ConsumeTransaction(accountId, [note], delegateTransaction);
      await Repo.transactions.add(isolatedRow);
      createdIds.push(isolatedRow.id);
    }
    if (queueable.length > 0) {
      const dbTransaction = new ConsumeTransaction(accountId, queueable, delegateTransaction);
      await Repo.transactions.add(dbTransaction);
      createdIds.push(dbTransaction.id);
    }
    return {
      committedId: createdIds[0]!,
      queuedNoteIds: [...isolate, ...queueable].map(n => n.id)
    };
  });

  return committedId;
};

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
  autoConsume: boolean = true
): Promise<string> => {
  const dbTransaction = new SwapTransaction(
    accountId,
    offeredFaucetId,
    offeredAmount,
    requestedFaucetId,
    requestedAmount,
    delegateTransaction,
    expirySeconds,
    autoConsume
  );
  await Repo.transactions.add(dbTransaction);

  return dbTransaction.id;
};

/**
 * Queue a send.
 *
 * Refuses a PRIVATE send outright when no note-transport endpoint is configured
 * for the effective network, rather than queueing one that cannot possibly be
 * delivered. Throwing here is the whole point: this runs BEFORE anything is
 * queued, proved or submitted, so the user keeps their assets and sees an error
 * they can act on. Allowing it through inverts that — `relay_private_note`
 * resolves the transport API before it writes its retry outbox, so the send would
 * land on chain, reach nobody, and leave no retry record. Every private send on
 * such a network would be an unrecoverable loss reported as "Sent".
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
  delegateTransaction?: boolean
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
  await Repo.transactions.add(dbTransaction);

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
  sendParams?: IBridgedSendNoteParams
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
    sendParams
  );
  await Repo.transactions.add(dbTransaction);

  return dbTransaction.id;
};

/**
 * Queue the recallable Miden P2IDE note that collateralizes an Earn deposit.
 * `requestBytes` is the pre-built P2IDE collateral request carrying the
 * mandate-binding attachment (smallocator PR #38, built by
 * `buildEpochCollateralRequestBytes`); the pipeline submits it verbatim.
 */
export const initiateEarnDepositTransaction = async (
  accountId: string,
  amount: bigint,
  evmRecipient: string,
  marketUid: string,
  faucetId: string,
  sendParams: IBridgedSendNoteParams,
  delegateTransaction?: boolean,
  requestBytes?: Uint8Array
): Promise<string> => {
  const dbTransaction = new EarnDepositTransaction(
    accountId,
    amount,
    evmRecipient,
    marketUid,
    faucetId,
    sendParams,
    delegateTransaction,
    requestBytes
  );
  await Repo.transactions.add(dbTransaction);
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
  sourceSymbol = 'USDC'
): Promise<string> => {
  const dbTransaction = new EarnWithdrawTransaction(
    accountId,
    amount,
    evmOwner,
    marketUid,
    faucetId,
    sourceAmount,
    sourceSymbol
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
  await Repo.transactions.add(dbTransaction);
  return dbTransaction.id;
};

/**
 * Do two rotation requests name the same operator? Trailing-slash tolerant via
 * the same `sanitizeGuardianUrl` the wallet already uses for guardian-URL
 * identity, so `https://g.example.com` and `https://g.example.com/` are one
 * target rather than two.
 */
const sameGuardianEndpointTarget = (a: string, b: string): boolean => sanitizeGuardianUrl(a) === sanitizeGuardianUrl(b);

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
  const accounts = await guardianProvider.getAccounts();
  const account = accounts.find(candidate => sameWalletAccountId(candidate.publicKey, accountId));
  if (!account || account.type !== WalletType.Guardian) {
    throw new Error('Switch guardian is only supported for Guardian accounts');
  }
  const previousGuardianEndpoint = await resolveGuardianEndpoint(account);

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
    const inFlight = inFlightRows.find(row => compareAccountIds(row.accountId, accountId));
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
      if (!inFlightEndpoint || !sameGuardianEndpointTarget(inFlightEndpoint, newGuardianEndpoint)) {
        throw new GuardianRotationInProgressError(inFlightEndpoint);
      }
      return inFlight.id;
    }

    const dbTransaction = new SwitchGuardianTransaction(
      accountId,
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
 */
export const initiateReplaceHotKeyTransaction = async (
  accountId: string,
  delegateTransaction: boolean | undefined,
  guardianProvider: GuardianAccountProvider
): Promise<string> => {
  if (!(await isGuardianAccount(accountId, guardianProvider))) {
    throw new Error('Replace hot key is only supported for Guardian accounts');
  }
  const dbTransaction = new ReplaceHotKeyTransaction(accountId, delegateTransaction);
  await Repo.transactions.add(dbTransaction);
  return dbTransaction.id;
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
 * `update_procedure_threshold` when missing. Best-effort — never throws.
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
  guardianProvider: GuardianAccountProvider
): Promise<string | undefined> => {
  try {
    // Loading the service fetches the on-chain account config, including its
    // procedure thresholds.
    const service = await getOrCreateMultisigService(accountId, guardianProvider);
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
  if (!(await isGuardianAccount(accountId, guardianProvider))) {
    throw new Error('update-procedure-threshold is only supported for Guardian accounts');
  }
  const dbTransaction = new UpdateProcedureThresholdTransaction(accountId, procedure, threshold, delegateTransaction);
  await Repo.transactions.add(dbTransaction);
  return dbTransaction.id;
};
