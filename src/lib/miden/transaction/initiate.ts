import {
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from 'lib/miden/front/guardian-manager';
import * as Repo from 'lib/miden/repo';
import { isExtension } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';

import { queueNoteImport } from '../activity/notes';
import { compareAccountIds } from '../activity/utils';
import {
  ConsumeTransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwapTransaction,
  SwitchGuardianTransaction,
  Transaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { toNoteTypeString } from '../helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { ConsumableNote, NoteType as NoteTypeString } from '../types';

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
  delegateTransaction?: boolean
): Promise<string> => {
  const sdkNote = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();

    return midenClient.getInputNote(noteId);
  });
  if (!sdkNote) {
    throw new Error(`Note with id ${noteId} not found`);
  }
  const noteMeta = sdkNote.metadata();
  const note: ConsumableNote = {
    id: noteId,
    faucetId: '',
    amount: '',
    senderAddress: '',
    isBeingClaimed: false,
    type: noteMeta ? toNoteTypeString(noteMeta.noteType()) : 'unknown'
  };

  return await initiateConsumeTransaction(accountId, note, delegateTransaction);
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
 * failures, but bounded by the MAX_CONSECUTIVE_CONSUME_FAILURES + RETRY_COOLDOWN_SEC
 * policy to prevent unbounded retry storms when the failure is deterministic (#215).
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
  manualRetry?: boolean
): Promise<string> => {
  if (notes.length === 0) {
    throw new Error('initiateConsumeNotesTransaction requires at least one note');
  }

  const { committedId, queuedNoteIds } = await Repo.db.transaction('rw', Repo.transactions, async () => {
    const queueable: ConsumableNote[] = [];
    let blockingId: string | null = null;

    for (const note of notes) {
      // Read every consume row covering this noteId once (scalar `noteId`
      // index for legacy/single rows, multi-entry `noteIds` for batch rows),
      // then partition. We need both non-Failed (dedup) and recent Failed
      // (bounded-retry gate) inside the same rw transaction so the
      // check-and-add stays atomic.
      const byScalar = await Repo.transactions.where('noteId').equals(note.id).toArray();
      const byBatch = await Repo.transactions.where('noteIds').equals(note.id).toArray();
      const dedupedRows = new Map([...byScalar, ...byBatch].map(tx => [tx.id, tx]));
      const sameAccount = [...dedupedRows.values()].filter(
        tx => tx.type === 'consume' && compareAccountIds(tx.accountId, accountId)
      );

      // Existing non-Failed dedup: a Queued / GeneratingTransaction / Completed row wins.
      const liveOrCompleted = sameAccount.find(tx => tx.status !== ITransactionStatus.Failed);
      if (liveOrCompleted) {
        blockingId = blockingId ?? liveOrCompleted.id;
        continue;
      }

      // Bounded-retry gate: only Failed rows exist for this note+account.
      // Skipped entirely for explicit user retries (`manualRetry`) — a deliberate
      // tap must always queue a fresh attempt rather than be throttled by the
      // auto-consume backoff.
      if (!manualRetry) {
        const nowSec = Math.floor(Date.now() / 1000);
        const recentFailures = sameAccount
          .filter(tx => tx.status === ITransactionStatus.Failed)
          .filter(tx => {
            const completed = tx.completedAt ?? tx.initiatedAt;
            return nowSec - completed <= RECENT_FAILURE_WINDOW_SEC;
          })
          .sort((a, b) => (b.completedAt ?? b.initiatedAt) - (a.completedAt ?? a.initiatedAt));
        if (recentFailures.length > 0) {
          const mostRecentFailed = recentFailures[0]!;
          const mostRecentCompletedAt = mostRecentFailed.completedAt ?? mostRecentFailed.initiatedAt;
          const secsSinceLastFailure = nowSec - mostRecentCompletedAt;
          // Two gates compose: cap on consecutive failures inside the recent window
          // AND a cooldown since the most recent failure. Either one being unsatisfied
          // suppresses the new attempt.
          if (recentFailures.length >= MAX_CONSECUTIVE_CONSUME_FAILURES || secsSinceLastFailure < RETRY_COOLDOWN_SEC) {
            blockingId = blockingId ?? mostRecentFailed.id;
            continue;
          }
        }
      }

      queueable.push(note);
    }

    if (queueable.length === 0) {
      return { committedId: blockingId!, queuedNoteIds: [] as string[] };
    }

    const dbTransaction = new ConsumeTransaction(accountId, queueable, delegateTransaction);
    await Repo.transactions.add(dbTransaction);
    return { committedId: dbTransaction.id, queuedNoteIds: queueable.map(n => n.id) };
  });

  // Only broadcast NoteClaimStarted for notes WE actually queued —
  // duplicate broadcasts for the same note are a no-op but wasteful.
  if (queuedNoteIds.length > 0 && isExtension()) {
    for (const noteId of queuedNoteIds) {
      getIntercom()
        .request({ type: WalletMessageType.NoteClaimStarted, noteId })
        .catch(() => {});
    }
  }

  return committedId;
};

/**
 * Bounded-retry policy for auto-consume.
 *
 * Background: the consume dedup at `initiateConsumeTransaction` excludes
 * `Failed` rows by design so retries can recover from *transient* failures
 * (e.g., kernel `auth::request` errors that clear once chain state
 * advances). But without a cap, an upstream deterministic failure
 * combined with auto-consume's polling cadence + tab-switch remounts
 * produces an unbounded retry storm — one user empirically observed 122+
 * consume/Failed rows for 2 notes in 38 minutes. Issue #215 documents
 * this in detail. The follow-up shows the kernel error eventually clears
 * (both notes consumed within 10s of each other after a 65min idle), so
 * we must keep retrying *eventually*, just not on every single tick.
 *
 * Policy:
 *   - Cap at MAX_CONSECUTIVE_CONSUME_FAILURES failures inside RECENT_FAILURE_WINDOW_SEC.
 *   - Once capped, require RETRY_COOLDOWN_SEC to elapse since the most
 *     recent Failed `completedAt` before allowing a new attempt.
 *
 * The combined effect: a deterministic failure caps at ~5 retries within
 * ~30 min, then re-attempts at most once every ~5 min. A transient
 * failure that succeeds within the window still retries normally because
 * a Completed row reactivates the existing-non-Failed dedup branch.
 */
export const MAX_CONSECUTIVE_CONSUME_FAILURES = 5;
export const RECENT_FAILURE_WINDOW_SEC = 30 * 60; // 30 minutes
export const RETRY_COOLDOWN_SEC = 5 * 60; // 5 minutes

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

export const initiateSendTransaction = async (
  senderAccountId: string,
  recipientAccountId: string,
  faucetId: string,
  noteType: NoteTypeString,
  amount: bigint,
  recallBlocks?: number,
  delegateTransaction?: boolean
): Promise<string> => {
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
 * Queue a switch-guardian transaction for a Guardian account. The per-account
 * `guardianEndpoint` is NOT updated here — it's persisted only after the
 * on-chain proposal lands, in `completeSwitchGuardianTransaction`.
 */
export const initiateSwitchGuardianTransaction = async (
  accountId: string,
  newGuardianEndpoint: string,
  delegateTransaction: boolean | undefined,
  guardianProvider: GuardianAccountProvider
): Promise<string> => {
  if (!(await isGuardianAccount(accountId, guardianProvider))) {
    throw new Error('Switch guardian is only supported for Guardian accounts');
  }
  const dbTransaction = new SwitchGuardianTransaction(accountId, newGuardianEndpoint, delegateTransaction);
  await Repo.transactions.add(dbTransaction);
  return dbTransaction.id;
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
 */
export const ensureGuardianProcedureThresholds = async (
  accountId: string,
  delegateTransaction: boolean | undefined,
  guardianProvider: GuardianAccountProvider
): Promise<void> => {
  try {
    // Loading the service fetches the on-chain account config, including its
    // procedure thresholds.
    const service = await getOrCreateMultisigService(accountId, guardianProvider);
    if (
      service.getProcedureThreshold(GUARDIAN_PROCEDURE_HARDENING.procedure) === GUARDIAN_PROCEDURE_HARDENING.threshold
    ) {
      return;
    }
    await initiateUpdateProcedureThresholdTransaction(
      accountId,
      GUARDIAN_PROCEDURE_HARDENING.procedure,
      GUARDIAN_PROCEDURE_HARDENING.threshold,
      delegateTransaction,
      guardianProvider
    );
    // Nudge the processor to pick up the freshly-queued tx. Dynamic import to
    // avoid a static cycle with the activity barrel.
    const { requestSWTransactionProcessing } = await import('lib/miden/activity');
    requestSWTransactionProcessing();
  } catch (e) {
    console.warn('[guardian] procedure-threshold hardening skipped (non-fatal):', e);
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
