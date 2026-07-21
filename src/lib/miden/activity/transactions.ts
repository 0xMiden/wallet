import { InputNoteState, Note, TransactionProver, TransactionResult } from '@miden-sdk/miden-sdk/lazy';
import { type Proposal } from '@openzeppelin/miden-multisig-client';
import { liveQuery } from 'dexie';

import {
  clearGuardianServiceFor,
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from 'lib/miden/front/guardian-manager';
import { MultisigService } from 'lib/miden/guardian';
import { withGuardianAccountLock, withGuardianConflictRetry } from 'lib/miden/guardian/serialize';
import { assertGuardianInSync } from 'lib/miden/guardian/sync-guard';
import * as Repo from 'lib/miden/repo';
import { isExtension, isMobile } from 'lib/platform';
import { u8ToB64 } from 'lib/shared/helpers';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';
import { logger } from 'shared/logger';

import {
  ConsumeTransaction,
  ITransaction,
  ITransactionStepTimings,
  ITransactionStage,
  ITransactionStatus,
  ITransactionTimedStep,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwitchGuardianTransaction,
  Transaction,
  TransactionOutput,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { toNoteTypeString } from '../helpers';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenClientCreateOptions } from '../sdk/miden-client-interface';
import { ConsumableNote, NoteTypeEnum, NoteType as NoteTypeString } from '../types';
import { interpretTransactionResult } from './helpers';
import { importAllNotes, queueNoteImport } from './notes';
import { compareAccountIds } from './utils';

// On mobile, use a shorter timeout since there's no background processing
// On desktop extension, transactions can run in background tabs
export const MAX_WAIT_BEFORE_CANCEL = isMobile() ? 2 * 60 : 30 * 60; // 2 mins on mobile, 30 mins on desktop (in seconds)

/**
 * Stable tags attached to errors the sign callback throws, so the catch
 * site for a failed executeTransaction can pattern-match on the raw
 * thrown value (recovered via `midenClient.lastAuthError()`) and treat
 * each failure mode differently — e.g. retry a `locked` failure after
 * the wallet unlocks instead of marking the tx permanently Failed.
 */
export type SignCallbackReason = 'locked' | 'rejected' | 'not_found' | 'internal';

export interface SignCallbackError extends Error {
  reason: SignCallbackReason;
}

/**
 * Wrap an underlying sign failure in a typed Error that the SDK will
 * capture verbatim (see `WebClient.lastAuthError`). Classifies by
 * inspecting the underlying error's shape — current signals are the
 * Zustand-store locked state (string "Not initialized" from
 * `assertInited`) and generic TypeError for null-vault access.
 */
export function buildSignCallbackError(err: unknown): SignCallbackError {
  const underlying = err instanceof Error ? err : new Error(String(err));
  let reason: SignCallbackReason = 'internal';
  const msg = underlying.message || '';
  if (/not initialized|locked|vault.*null|Cannot read propert/i.test(msg)) {
    reason = 'locked';
  }
  const wrapped = Object.assign(new Error(`Sign callback failed (${reason}): ${msg}`), {
    reason,
    cause: underlying
  }) as SignCallbackError;
  return wrapped;
}

/**
 * Detect the eventually-consistent Guardian canonicalization error:
 *
 *   "Refusing to overwrite local state: incoming nonce 0 is not greater
 *    than local nonce 1 for account 0x..."
 *
 * Thrown by the WASM SDK when it's asked to sync a stale view of an account
 * the local client has already advanced past. For Guardian accounts this
 * happens because guardian canonicalization runs asynchronously after the
 * tx is accepted on-chain — by the time we try to sync, the local nonce has
 * already moved forward and the guardian's reply looks stale. The transaction
 * itself is fine; the next sync tick will reconcile. Treat as success.
 */
export function isGuardianCanonicalizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /Refusing to overwrite local state/i.test(message) || /is not greater than local nonce/i.test(message);
}

// Maximum age for a queued transaction before it's considered stale and cancelled
export const MAX_QUEUED_AGE = 30 * 60; // 30 minutes (seconds)

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

export const completeCustomTransaction = async (transaction: ITransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  const outputNotes = executedTx.outputNotes().notes();

  for (const note of outputNotes) {
    // Only care about private notes
    if (toNoteTypeString(note.metadata().noteType()) !== NoteTypeEnum.Private) {
      continue;
    }

    if (!transaction.secondaryAccountId) {
      console.error('Missing recipient account id for private note', { txId: transaction.id });
      continue;
    }

    let fullNote: Note;

    // intoFull() can throw or return undefined
    try {
      const maybeFullNote = note.intoFull();
      if (!maybeFullNote) {
        console.error('intoFull() returned undefined for output note');
        continue;
      }
      fullNote = maybeFullNote;
    } catch (error) {
      console.error('Failed to convert output note into full note', { error });
      continue;
    }

    // Get client + send private note (wrapped in lock to prevent concurrent WASM access)
    try {
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();

        try {
          await midenClient.waitForTransactionCommit(executedTx.id().toHex());
          await midenClient.sendPrivateNote(fullNote, transaction.secondaryAccountId!);
        } catch (error) {
          console.error('Failed to send private note through the transport layer', {
            txId: transaction.id,
            secondaryAccountId: transaction.secondaryAccountId,
            error
          });
        }
      });
    } catch (error) {
      console.error('Failed to initialize Miden client for private note send', {
        txId: transaction.id,
        error
      });
    }
  }

  const updatedTransaction = interpretTransactionResult(transaction, result);
  updatedTransaction.completedAt = Math.floor(Date.now() / 1000); // seconds

  await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, updatedTransaction);
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

export const initiateConsumeTransaction = async (
  accountId: string,
  note: ConsumableNote,
  delegateTransaction?: boolean,
  // Background/auto-consume: routed through the cold key on Guardian accounts so
  // a silent claim doesn't trigger a biometric prompt (see generateGuardianTransaction).
  background?: boolean
): Promise<string> => {
  const dbTransaction = new ConsumeTransaction(accountId, note, delegateTransaction, background);
  // Dedup against all non-Failed consume txs for this noteId, including Completed ones.
  // Reason: getConsumableNotes() can still return a note for a short window after a local
  // consume completes (chain-sync lag). Without this, auto-consume polling creates a new
  // tx every 5s until the sync catches up. Failed txs are excluded by the existing-non-Failed
  // dedup so retries can recover from transient failures, but bounded by the
  // MAX_CONSECUTIVE_CONSUME_FAILURES + RETRY_COOLDOWN_SEC policy below to prevent
  // unbounded retry storms when the failure is deterministic (issue #215).
  //
  // The check-and-add is wrapped in a Dexie `rw` transaction so concurrent callers for the
  // same noteId are serialized at the DB layer. Without this, two callers that slip past
  // the isBeingClaimed gate (e.g. two Explore re-renders racing the NoteClaimStarted
  // intercom round-trip) both see `[]` from the check and both `.add()`, producing two
  // queued consume rows — the second of which fails on-chain with "note has already been
  // consumed" and spuriously trips the connectivity-issue banner.
  const committedId = await Repo.db.transaction('rw', Repo.transactions, async () => {
    // Read every consume row for this noteId once, then partition. We need both
    // non-Failed (for the existing dedup) and recent Failed (for the bounded-retry
    // gate) inside the same rw transaction so the check-and-add stays atomic.
    const allByNote = await Repo.transactions
      .where('noteId')
      .equals(note.id)
      .filter(tx => tx.type === 'consume')
      .toArray();
    const sameAccount = allByNote.filter(tx => compareAccountIds(tx.accountId, accountId));

    // Existing non-Failed dedup: a Queued / GeneratingTransaction / Completed row wins.
    const liveOrCompleted = sameAccount.find(tx => tx.status !== ITransactionStatus.Failed);
    if (liveOrCompleted) return liveOrCompleted.id;

    // Bounded-retry gate: only Failed rows exist for this note+account.
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
      // suppresses the new attempt and returns the most recent Failed row's id so
      // callers see a stable "this note already has a tx" response.
      if (recentFailures.length >= MAX_CONSECUTIVE_CONSUME_FAILURES || secsSinceLastFailure < RETRY_COOLDOWN_SEC) {
        return mostRecentFailed.id;
      }
    }

    await Repo.transactions.add(dbTransaction);
    return dbTransaction.id;
  });

  // Only broadcast NoteClaimStarted if WE were the caller that actually queued the row —
  // duplicate broadcasts for the same note are a no-op but wasteful.
  if (committedId === dbTransaction.id && isExtension()) {
    getIntercom()
      .request({ type: WalletMessageType.NoteClaimStarted, noteId: note.id })
      .catch(() => {});
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

// Timeout for waiting on consume transactions (5 minutes)
const WAIT_FOR_CONSUME_TX_TIMEOUT = 5 * 60_000;

export const waitForConsumeTx = async (id: string, signal?: AbortSignal): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let subscription: { unsubscribe: () => void } | null = null;

    const timeoutId = setTimeout(() => {
      subscription?.unsubscribe();
      reject(new Error('Transaction timed out. Please try again.'));
    }, WAIT_FOR_CONSUME_TX_TIMEOUT);

    const cleanup = () => {
      clearTimeout(timeoutId);
      subscription?.unsubscribe();
    };

    subscription = liveQuery(() => Repo.transactions.where({ id }).first()).subscribe(tx => {
      if (!tx) {
        cleanup();
        reject(new Error('Transaction not found'));
        return;
      }

      if (tx.status === ITransactionStatus.Completed) {
        cleanup();
        resolve(tx.transactionId!);
      } else if (tx.status === ITransactionStatus.Failed) {
        cleanup();
        reject(new Error('Consume transaction failed'));
      }
    });

    signal?.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
};

export const completeConsumeTransaction = async (id: string, result: TransactionResult) => {
  const firstInputNote = result.executedTransaction().inputNotes().notes()[0];
  if (!firstInputNote) {
    throw new Error('completeConsumeTransaction: no input notes on executed transaction');
  }
  const note = firstInputNote.note();
  const sender = getBech32AddressFromAccountId(note.metadata().sender());
  const executedTransaction = result.executedTransaction();

  const dbTransaction = await Repo.transactions.where({ id }).first();
  const reclaimed = compareAccountIds(dbTransaction?.accountId ?? '', sender);
  const displayMessage = reclaimed ? 'Reclaimed' : 'Received';
  const secondaryAccountId = reclaimed ? undefined : sender;
  const asset = note.assets().fungibleAssets()[0];
  if (!asset) {
    throw new Error('completeConsumeTransaction: note has no fungible assets');
  }
  const faucetId = getBech32AddressFromAccountId(asset.faucetId());
  const amount = asset.amount();

  await updateTransactionStatus(id, ITransactionStatus.Completed, {
    displayMessage,
    transactionId: executedTransaction.id().toHex(),
    secondaryAccountId,
    faucetId,
    amount,
    noteType: toNoteTypeString(note.metadata().noteType()),
    completedAt: Math.floor(Date.now() / 1000), // Convert to seconds.
    resultBytes: result.serialize()
  });
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

export const completeReplaceHotKeyTransaction = async (
  tx: ReplaceHotKeyTransaction,
  result: TransactionResult | undefined,
  guardianProvider: GuardianAccountProvider,
  // The cold MultisigService used to drive the rotation. Supplied on the normal
  // path so we can push the rotated state to the guardian below; absent on the
  // apply-after-submit-failed reconcile path (runSync self-heals that case).
  service?: MultisigService
) => {
  try {
    const newHotPublicKey = tx.extraInputs?.newHotPublicKey;
    if (!newHotPublicKey) {
      throw new Error('Replace-hot-key tx is missing newHotPublicKey in extraInputs');
    }

    if (!guardianProvider.swapHotKey) {
      throw new Error('swapHotKey not implemented in this provider');
    }

    // The OZ lib submitted `update_signers` on-chain but did NOT re-register the
    // rotated state on the guardian (it only does that for switch_guardian). Push
    // it now — BEFORE `swapHotKey`, which sets `hotPublicKey` and thereby arms the
    // ~3s guardian hot-sync. If we let the hot-sync start with the guardian's blob
    // still pre-rotation, every tick throws on the guardian-vs-on-chain mismatch
    // until a reinstall. Best-effort: an on-chain-successful rotation must not be
    // failed by a guardian blip — runSync re-registers on a later tick if this slips.
    if (service) {
      try {
        await service.reRegisterCurrentStateOnGuardian();
      } catch (e) {
        console.warn('Failed to re-register rotated state on guardian post-replace-hot-key (non-fatal):', e);
      }
    }

    // Vault.swapHotKey resolves the previous hot pubkey from the persisted
    // WalletAccount and is idempotent: if the record already reflects
    // `newHotPublicKey` (retry), the cleanup branch is a no-op.
    await guardianProvider.swapHotKey(tx.accountId, newHotPublicKey);
    // Drop the cached MultisigService — its bound hot signer is now stale.
    clearGuardianServiceFor(tx.accountId);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Device key rotated',
      completedAt: Math.floor(Date.now() / 1000),
      // `result` is absent on the apply-after-submit-failed reconcile path: the
      // rotation is already on chain, we just lack the local TransactionResult.
      ...(result && {
        transactionId: result.executedTransaction().id().toHex(),
        resultBytes: result.serialize()
      })
    });

    // The account now has both signers on-chain, so bring it up to the same
    // hardening a freshly-created 3-key account has (update_guardian threshold
    // 2 — which the update_signers rotation above can't carry). Best-effort and
    // idempotent; never affects the rotation's success.
    await ensureGuardianProcedureThresholds(tx.accountId, tx.delegateTransaction, guardianProvider);
  } catch (error) {
    console.error('Error completing replace-hot-key transaction:', error);
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Failed to rotate device key',
      completedAt: Math.floor(Date.now() / 1000),
      ...(result && { resultBytes: result.serialize() }),
      error: error instanceof Error ? error.message : String(error)
    });
  }
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

export const completeUpdateProcedureThresholdTransaction = async (
  tx: UpdateProcedureThresholdTransaction,
  result: TransactionResult,
  // The cold MultisigService used to drive the threshold change, so we can push
  // the new state to the guardian (the OZ lib doesn't re-register it).
  service?: MultisigService
) => {
  const executedTx = result.executedTransaction();
  await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
    displayMessage: 'Account secured',
    transactionId: executedTx.id().toHex(),
    completedAt: Math.floor(Date.now() / 1000),
    resultBytes: result.serialize()
  });
  // The cached service's procedureThresholds are now stale — drop it.
  clearGuardianServiceFor(tx.accountId);

  // Same gap as replace-hot-key: the OZ lib submitted `update_procedure_threshold`
  // on-chain but never re-registered the new state on the guardian. Push it so the
  // guardian's blob tracks the new threshold and the next sync doesn't diverge.
  // Best-effort; runSync self-heals if this slips.
  if (service) {
    try {
      await service.reRegisterCurrentStateOnGuardian();
    } catch (e) {
      console.warn('Failed to re-register state on guardian post-update-procedure-threshold (non-fatal):', e);
    }
  }
};

export const completeSwitchGuardianTransaction = async (
  tx: SwitchGuardianTransaction,
  result: TransactionResult | undefined,
  multisigService: MultisigService,
  guardianProvider: GuardianAccountProvider
) => {
  try {
    const { newGuardianEndpoint } = tx.extraInputs;

    // Mirror upstream `multisig.executeProposal`'s post-submit block for
    // switch_guardian proposals: register on the new guardian with the
    // updated account state before anything else touches the local cache
    // or storage. If this throws, storage + status stay untouched so the
    // user can retry.
    await setTransactionStage(tx.id, 'registering-guardian');
    await multisigService.finalizeGuardianSwitch(newGuardianEndpoint);

    // Persist the endpoint PER-ACCOUNT (not the legacy global key) so other
    // Guardian accounts on different operators aren't clobbered. Backend
    // providers implement setGuardianEndpoint; the optional-call guard keeps a
    // frontend provider without it from throwing.
    await guardianProvider.setGuardianEndpoint?.(tx.accountId, newGuardianEndpoint);
    clearGuardianServiceFor(tx.accountId);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Guardian switched',
      completedAt: Math.floor(Date.now() / 1000), // seconds
      // `result` is absent on the apply-after-submit-failed reconcile path: the
      // switch is already on chain, we just lack the local TransactionResult.
      ...(result && {
        transactionId: result.executedTransaction().id().toHex(),
        resultBytes: result.serialize()
      })
    });
  } catch (error) {
    console.error('Error completing switch guardian transaction:', error);
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Failed to switch guardian',
      completedAt: Math.floor(Date.now() / 1000), // seconds
      ...(result && { resultBytes: result.serialize() }),
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

/**
 * Run the structural side effects a structural Guardian op needs after its
 * submit landed on chain but the LOCAL apply failed (`ApplyTransactionAfterSubmitFailed`).
 * Without this the generic apply-failure handler would mark the tx Completed and
 * skip reconciliation, stranding the account.
 *
 * replace-hot-key → swap the vault hot pointer (idempotent).
 * switch-guardian → rebuild a service to drive `finalizeGuardianSwitch` (which
 *   re-syncs the post-switch account state itself) + persist the per-account
 *   endpoint. Both completion handlers tolerate a missing TransactionResult.
 */
async function reconcileStructuralApplyFailure(
  tx: ITransaction,
  guardianProvider: GuardianAccountProvider
): Promise<void> {
  if (tx.type === 'replace-hot-key') {
    await completeReplaceHotKeyTransaction(tx as ReplaceHotKeyTransaction, undefined, guardianProvider);
    return;
  }
  const service = await getOrCreateMultisigService(tx.accountId, guardianProvider);
  await completeSwitchGuardianTransaction(tx as SwitchGuardianTransaction, undefined, service, guardianProvider);
}

const extractFullNote = (result: TransactionResult): Note | undefined => {
  try {
    const outputNotes = result.executedTransaction().outputNotes().notes();

    const firstOutput = outputNotes?.[0];
    if (!firstOutput) {
      console.error('No output notes found for executed transaction');
      return undefined;
    }

    const fullNote = firstOutput.intoFull();

    if (!fullNote) {
      console.error('intoFull() returned undefined for first output note');
      return undefined;
    }

    return fullNote;
  } catch (error) {
    console.error('Failed to extract full note from transaction result', { error });
    return undefined;
  }
};

export const completeSendTransaction = async (tx: SendTransaction, result: TransactionResult) => {
  const executedTx = result.executedTransaction();
  const note = extractFullNote(result);
  const noteId = note?.id().toString();
  const outputNoteIds = noteId ? [noteId] : [];

  if (tx.noteType === NoteTypeEnum.Private && note && noteId) {
    // Wrap all WASM client operations in a lock to prevent concurrent access.
    // The SDK persists the relay payload to its durable outbox before invoking
    // transport (miden-client#2127); if the transport call fails, the SDK
    // retries the blob on every subsequent sync_state. So a transport-level
    // failure here is not a wallet-side concern — the on-chain tx is durable
    // and the SDK will deliver the blob eventually. We just log and move on.
    await setTransactionStage(tx.id, 'confirming');
    try {
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        await midenClient.waitForTransactionCommit(executedTx.id().toHex());
        await setTransactionStage(tx.id, 'delivering');
        try {
          await midenClient.sendPrivateNote(note, tx.secondaryAccountId);
        } catch (error) {
          console.warn('Private-note transport failed; SDK outbox will retry on next sync', {
            txId: tx.id,
            noteId,
            secondaryAccountId: tx.secondaryAccountId,
            error
          });
        }
      });
    } catch (error) {
      // Lock acquisition or pre-transport step (e.g. waitForTransactionCommit)
      // failed. The on-chain tx may not be confirmed yet from this client's
      // perspective; falling through to the normal Completed path is still
      // correct because executedTx.id() is the canonical id and the chain
      // is the source of truth — subsequent sync_state will reconcile.
      console.warn('Pre-transport step failed during private send; relying on SDK reconcile', { txId: tx.id, error });
    }
  } else if (tx.noteType === NoteTypeEnum.Private && (!note || !noteId)) {
    console.error('Missing full note for private send', { txId: tx.id });
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Send failed: note unavailable',
      displayIcon: 'FAILED',
      transactionId: executedTx.id().toHex(),
      outputNoteIds,
      completedAt: Math.floor(Date.now() / 1000) // seconds
    });
    return;
  }

  try {
    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Sent',
      transactionId: executedTx.id().toHex(),
      outputNoteIds,
      completedAt: Math.floor(Date.now() / 1000), // seconds
      resultBytes: result.serialize()
    });
  } catch (error) {
    console.error('Failed to update transaction status', {
      txId: tx.id,
      error
    });
  }
};

/**
 * Update the status of the transaction
 * @param id The id of the transaction to update
 * @throws if the transaction has been cancelled
 */
export const updateTransactionStatus = async <K extends keyof ITransaction>(
  id: string,
  status: ITransactionStatus,
  otherValues: Pick<ITransaction, K>
) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (!tx) throw new Error('No transaction found to update');
  if (tx.status === ITransactionStatus.Failed || tx.status === ITransactionStatus.Completed) {
    throw new Error('Transaction already in a finalized state');
  }

  await Repo.transactions.where({ id: id }).modify(t => {
    Object.assign(t, otherValues);
    if (status === ITransactionStatus.Completed || status === ITransactionStatus.Failed) {
      closeOpenStepTimings(t);
    }
    t.status = status;
  });
};

const TIMED_TRANSACTION_STEPS: ITransactionTimedStep[] = ['guardian-approving', 'generating-proof'];

const isFinalTransactionStatus = (status: ITransactionStatus) =>
  status === ITransactionStatus.Completed || status === ITransactionStatus.Failed;

const closeOpenStepTimings = (tx: ITransaction, endedAt = Date.now()) => {
  if (!tx.stepTimings) return;

  let nextStepTimings: ITransactionStepTimings | undefined;

  for (const step of TIMED_TRANSACTION_STEPS) {
    const timing = tx.stepTimings[step];
    if (!timing || timing.endedAt !== undefined) continue;

    nextStepTimings = nextStepTimings ?? { ...tx.stepTimings };
    nextStepTimings[step] = { ...timing, endedAt };
  }

  if (nextStepTimings) {
    tx.stepTimings = nextStepTimings;
  }
};

export const createTransactionStepTimer = (id: string) => ({
  startTime: async (step: ITransactionTimedStep) => {
    const startedAt = Date.now();

    await Repo.transactions.where({ id }).modify(tx => {
      if (isFinalTransactionStatus(tx.status)) return;

      const stepTimings = tx.stepTimings ?? {};
      const current = stepTimings[step];
      if (current?.startedAt && current.endedAt === undefined) return;

      tx.stepTimings = {
        ...stepTimings,
        [step]: { startedAt }
      };
    });
  },
  endTime: async (step: ITransactionTimedStep) => {
    const endedAt = Date.now();

    await Repo.transactions.where({ id }).modify(tx => {
      if (isFinalTransactionStatus(tx.status)) return;

      const current = tx.stepTimings?.[step];
      if (!current || current.endedAt !== undefined) return;

      tx.stepTimings = {
        ...(tx.stepTimings ?? {}),
        [step]: { ...current, endedAt }
      };
    });
  }
});

/**
 * Informational stage write. Called at phase boundaries inside
 * `generateTransaction` / `completeSendTransaction` so the progress modal
 * can show "Syncing" / "Sending" / "Confirming" / "Delivering" instead of
 * a single opaque "Generating transaction". Does not gate on status —
 * late writes after `Completed` are no-ops via the `.modify` callback
 * (the stage field is informational and only read while status is
 * pre-terminal).
 */
export const setTransactionStage = async (id: string, stage: ITransactionStage) => {
  await Repo.transactions.where({ id }).modify(tx => {
    if (tx.status !== ITransactionStatus.Completed && tx.status !== ITransactionStatus.Failed) {
      tx.stage = stage;
    }
  });
};

export const hasQueuedTransactions = async () => {
  const tx = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  return tx.length > 0;
};

export const getUncompletedTransactions = async (address: string, tokenId?: string) => {
  const statuses = [ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction];
  return await getTransactionsInStatuses(statuses, address, tokenId);
};

const getTransactionsInStatuses = async (statuses: ITransactionStatus[], accountId: string, tokenId?: string) => {
  let txs = await Repo.transactions.filter(rec => statuses.includes(rec.status)).toArray();
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  txs = txs.filter(tx => compareAccountIds(tx.accountId, accountId));
  if (tokenId) {
    txs = txs.filter(tx => tx.faucetId === tokenId);
  }

  return txs;
};

export const getTransactionsInProgress = async (): Promise<Transaction[]> => {
  const txs = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.GeneratingTransaction).toArray();
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return txs;
};

export const getAllUncompletedTransactions = async () => {
  const txs = await Repo.transactions
    .filter(rec => rec.status === ITransactionStatus.GeneratingTransaction || rec.status === ITransactionStatus.Queued)
    .toArray();
  txs.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return txs;
};

export const getFailedTransactions = async () => {
  const transactions = await Repo.transactions.filter(tx => tx.status === ITransactionStatus.Failed).toArray();
  transactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  return transactions;
};

export const getCompletedTransactions = async (
  accountId: string,
  offset?: number,
  limit?: number,
  includeFailed: boolean = false,
  tokenId?: string
) => {
  let transactions = await Repo.transactions.filter(tx => tx.status === ITransactionStatus.Completed).toArray();
  if (includeFailed) {
    const failedTransactions = await getFailedTransactions();
    transactions = transactions.concat(failedTransactions);
  }
  transactions.sort((tx1, tx2) => (tx1.completedAt || tx1.initiatedAt) - (tx2.completedAt || tx2.initiatedAt));
  // Compare ignoring note tag suffix since stored vs queried account IDs may differ
  transactions = transactions.filter(tx => compareAccountIds(tx.accountId, accountId));
  if (tokenId) {
    transactions = transactions.filter(tx => tx.faucetId === tokenId);
  }
  return transactions.slice(offset, limit);
};

/**
 * Cancel all of the transactions (& their transitions) that are taking too long to process
 */
export const cancelStuckTransactions = async () => {
  const transactions = await getTransactionsInProgress();
  const cancelTransactionUpdates = transactions
    .filter(tx => {
      // Crashed before processing started — processingStartedAt is set atomically
      // with the status change, so undefined means the app crashed mid-transition
      if (!tx.processingStartedAt) return true;
      return Math.floor(Date.now() / 1000) - tx.processingStartedAt > MAX_WAIT_BEFORE_CANCEL;
    })
    .map(async tx => cancelTransaction(tx, 'Transaction took too long to process and was cancelled'));

  await Promise.all(cancelTransactionUpdates);
};

/**
 * Cancel queued transactions that have been waiting too long (TTL expired)
 */
export const cancelStaleQueuedTransactions = async () => {
  const queued = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  const stale = queued.filter(tx => Math.floor(Date.now() / 1000) - tx.initiatedAt > MAX_QUEUED_AGE);
  await Promise.all(stale.map(tx => cancelTransaction(tx, 'Transaction expired after being queued too long')));
};

/**
 * TEMPORARY: Force cancel ALL in-progress transactions regardless of time.
 * Used for debugging stuck transactions on mobile.
 */
export const forceCaneclAllInProgressTransactions = async () => {
  const transactions = await getTransactionsInProgress();
  const cancelTransactionUpdates = transactions.map(async tx =>
    cancelTransaction(tx, 'Transaction force-cancelled for debugging')
  );
  await Promise.all(cancelTransactionUpdates);
};

/**
 * InputNoteState values that indicate a note has been consumed
 */
const CONSUMED_NOTE_STATES = [
  InputNoteState.ConsumedAuthenticatedLocal,
  InputNoteState.ConsumedUnauthenticatedLocal,
  InputNoteState.ConsumedExternal
];

// Minimum time a transaction must be in GeneratingTransaction status before we consider it "stuck"
// This prevents cancelling transactions that are actively being processed
const MIN_PROCESSING_TIME_BEFORE_STUCK = 60; // 1 minute (in seconds)

/**
 * Verify stuck transactions by checking note state from the node.
 * For consume transactions:
 * - If the note has been consumed on-chain, mark the transaction as completed
 * - If the note is invalid, mark as failed
 * - If the note is still claimable AND the tx has been processing for > 1 minute, mark as failed
 *
 * IMPORTANT: Only checks GeneratingTransaction status, NOT Queued.
 * Queued transactions haven't started processing yet, so the note being claimable is expected.
 *
 * Returns the number of transactions that were resolved.
 */
export const verifyStuckTransactionsFromNode = async (): Promise<number> => {
  // Only check GeneratingTransaction status - NOT Queued
  // Queued transactions haven't started processing yet, so the note being claimable is expected
  const inProgressTransactions = await getTransactionsInProgress();
  if (inProgressTransactions.length === 0) return 0;

  // Filter to only consume transactions with a noteId
  const consumeTransactions = inProgressTransactions.filter(
    (tx): tx is ConsumeTransaction => tx.type === 'consume' && !!(tx as ConsumeTransaction).noteId
  );

  if (consumeTransactions.length === 0) return 0;

  let resolvedCount = 0;

  // Check each stuck consume transaction (AutoSync handles syncState separately)
  for (const tx of consumeTransactions) {
    try {
      const noteDetails = await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        return await midenClient.getInputNoteDetails({ ids: [tx.noteId] });
      });

      const note = noteDetails[0];
      if (!note) {
        continue;
      }

      if (CONSUMED_NOTE_STATES.includes(note.state)) {
        // Note has been consumed on-chain - mark transaction as completed
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
          displayMessage: 'Received',
          completedAt: Math.floor(Date.now() / 1000)
        });
        resolvedCount++;
      } else if (note.state === InputNoteState.Invalid) {
        // Note is invalid - mark transaction as failed
        await cancelTransaction(tx, 'Note is invalid');
        resolvedCount++;
      } else if (
        note.state === InputNoteState.Committed ||
        note.state === InputNoteState.Expected ||
        note.state === InputNoteState.Unverified
      ) {
        // Note is still claimable - only cancel if tx has been processing for a while
        // This prevents cancelling transactions that are actively being processed
        const processingTime = tx.processingStartedAt ? Math.floor(Date.now() / 1000) - tx.processingStartedAt : 0;
        if (processingTime > MIN_PROCESSING_TIME_BEFORE_STUCK) {
          await cancelTransaction(tx, 'Transaction was interrupted');
          resolvedCount++;
        }
      }
    } catch (err) {
      console.error('[verifyStuckTransactionsFromNode] Error checking tx:', tx.id, err);
    }
  }

  return resolvedCount;
};

export const generateTransaction = async (
  transaction: Transaction,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  _useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
) => {
  // DIAGNOSTIC tracing for the iOS send-tx pre-sync hang. Mirrors the
  // recordProveTiming pattern in miden-client-interface.ts. Remove when
  // the hang is understood and fixed.
  const dtag = (msg: string) => {
    const line = `[prove-timing] [generateTransaction:${transaction.type}:${transaction.id}] ${msg}`;
    // eslint-disable-next-line no-console
    console.log(line);
    try {
      const g = globalThis as unknown as { __PROVE_TIMINGS__?: string[] };
      if (!g.__PROVE_TIMINGS__) g.__PROVE_TIMINGS__ = [];
      g.__PROVE_TIMINGS__.push(`${Date.now()}|${line}`);
    } catch {
      // ignore
    }
  };
  dtag('entered');

  // Sync state first to ensure we have latest account state
  // Separate lock acquisition to avoid holding lock during network call
  // If sync fails (e.g. network down), the error propagates to generateTransactionsLoop's
  // catch block which cancels the transaction — this is intentional fail-fast behavior,
  // since the transaction can't be submitted without network anyway
  await setTransactionStage(transaction.id, 'syncing');
  dtag('about to acquire withWasmClientLock for syncState');
  await withWasmClientLock(async () => {
    dtag('acquired lock for syncState; calling getMidenClient');
    const midenClient = await getMidenClient();
    dtag('got midenClient; calling syncState');
    const _t = performance.now();
    await midenClient.syncState();
    dtag(`syncState returned in ${(performance.now() - _t).toFixed(0)}ms`);
  });
  dtag('released syncState lock');

  // Mark transaction as in progress
  await updateTransactionStatus(transaction.id, ITransactionStatus.GeneratingTransaction, {
    processingStartedAt: Math.floor(Date.now() / 1000), // seconds
    stage: 'sending'
  });
  console.log('Generating transaction', {
    txId: transaction.id,
    type: transaction.type,
    accountId: transaction.accountId
  });

  // Route Guardian accounts through Guardian service
  if (await isGuardianAccount(transaction.accountId, guardianProvider)) {
    try {
      // Serialize guardian transactions per account: the guardian co-signs one
      // delta per account at a time, and concurrent same-account txs make its
      // expected commitment diverge from on-chain, stalling canonicalization
      // for minutes (see guardian/serialize.ts and OpenZeppelin/guardian#303).
      await withGuardianAccountLock(transaction.accountId, () =>
        generateGuardianTransaction(transaction, signCallback, guardianProvider)
      );
    } catch (error) {
      // Submit-succeeded-but-local-apply-failed on a structural op (replace-hot-key
      // / switch-guardian) is special: the change IS on chain, but the failure
      // happened before generateGuardianTransaction's completion handler ran, so
      // the vault hot pointer / guardian re-registration are un-reconciled. Cancelling
      // would strand the account (signing with a rotated-out key, or talking to the
      // old guardian). Run the same finalization the happy path would; only cancel if
      // that reconcile itself fails.
      if (
        extractSdkErrorCode(error) === 'ApplyTransactionAfterSubmitFailed' &&
        (transaction.type === 'replace-hot-key' || transaction.type === 'switch-guardian')
      ) {
        try {
          await reconcileStructuralApplyFailure(transaction, guardianProvider);
          return;
        } catch (reconcileError) {
          console.error('Structural-op apply-failure reconcile failed; cancelling', reconcileError);
        }
      }
      // Guardian canonicalization is eventually-consistent: the SDK can throw
      // "Refusing to overwrite local state: incoming nonce N is not greater
      // than local nonce M" when the guardian's view lags the local client.
      // The on-chain tx is fine — only the local sync refused. Mark Completed
      // so the user sees the success state; the next sync tick will reconcile.
      if (isGuardianCanonicalizationError(error)) {
        console.warn('[Guardian] canonicalization race during tx generation — marking Completed:', error);
        try {
          await updateTransactionStatus(transaction.id, ITransactionStatus.Completed, {
            displayMessage: transaction.type === 'consume' ? 'Claimed' : 'Sent',
            completedAt: Math.floor(Date.now() / 1000) // seconds
          });
        } catch (markErr) {
          // updateTransactionStatus throws if the tx is already finalized — fine.
          console.warn('[Guardian] could not re-mark Completed (likely already finalized):', markErr);
        }
        return;
      }
      await cancelTransaction(transaction, error);
    }
    return;
  }

  const options: MidenClientCreateOptions = {
    signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
      const keyString = Buffer.from(publicKey).toString('hex');
      const signingInputsString = Buffer.from(signingInputs).toString('hex');
      try {
        return await signCallback(keyString, signingInputsString);
      } catch (err) {
        // The SDK (WebKeyStore) captures the raw thrown value and exposes
        // it via `midenClient.lastAuthError()`. Attach a stable `reason`
        // tag so callers that catch the eventual executeTransaction
        // failure can distinguish "wallet got locked mid-sign" from other
        // failure modes (user rejection, keystore IO error, etc.).
        throw buildSignCallbackError(err);
      }
    }
  };

  // MidenClient handles the full pipeline (execute → prove → submit → apply)
  dtag('about to acquire withWasmClientLock for tx dispatch');
  const stepTimer = createTransactionStepTimer(transaction.id);
  await stepTimer.startTime('generating-proof');
  const result = await (async () => {
    try {
      return await withWasmClientLock(async () => {
        dtag('acquired tx lock; calling midenClient dispatch');
        const midenClient = await getMidenClient(options);
        switch (transaction.type) {
          case 'send':
            return await midenClient.sendTransaction(transaction as SendTransaction);
          case 'consume':
            return await midenClient.consumeNoteId(transaction as ConsumeTransaction);
          case 'execute':
          default:
            return await midenClient.newTransaction(
              transaction.accountId,
              transaction.requestBytes!,
              transaction.delegateTransaction
            );
        }
      });
    } finally {
      await stepTimer.endTime('generating-proof');
    }
  })();
  dtag('tx dispatch completed');

  switch (transaction.type) {
    case 'send':
      await completeSendTransaction(transaction as SendTransaction, result);
      break;
    case 'consume':
      await completeConsumeTransaction(transaction.id, result);
      break;
    case 'execute':
    default:
      await completeCustomTransaction(transaction, result);
      break;
  }
};

/**
 * Build a transient cold-bound MultisigService for `accountId`. Cold signing
 * goes through the SDK keystore (not the SE/StrongBox-wrapped hot key), so it
 * never triggers a biometric prompt — used for background/auto-consume.
 */
const buildColdServiceForAccount = async (
  accountId: string,
  guardianProvider: GuardianAccountProvider
): Promise<MultisigService> => {
  const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === accountId);
  if (!walletAccount) {
    throw new Error(`Guardian account ${accountId} not found in provider`);
  }
  const sdkAccount = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    return midenClient.getAccount(accountId);
  });
  if (!sdkAccount) {
    throw new Error(`Guardian account ${accountId} not found in local client`);
  }
  return MultisigService.buildColdMultisigService(sdkAccount, walletAccount, guardianProvider.signWord);
};

/**
 * Generate a transaction for a Guardian account using the MultisigService.
 * Routes the transaction through MultisigService proposal methods.
 */
const generateGuardianTransaction = async (
  transaction: ITransaction,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  guardianProvider: GuardianAccountProvider
): Promise<void> => {
  console.log('Generating Guardian transaction');

  // Gate ordinary guardian-signed ops while the stored endpoint is untrustworthy.
  // 'switch-guardian' is exempt: it's the deliberate, user-initiated provider
  // change (GuardianSettings) and must stay available as a manual recovery path.
  // The primary recovery mechanisms — resolveGuardianDrift's auto-resolution and
  // applyUserGuardianEndpoint's verified-URL apply — reconcile the vault directly
  // and never route through this function, so exempting switch-guardian here only
  // affects the deliberate Settings-driven switch flow, not account recovery.
  if (transaction.type !== 'switch-guardian') {
    const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === transaction.accountId);
    if (walletAccount) {
      assertGuardianInSync(walletAccount);
    }
  }

  const stepTimer = createTransactionStepTimer(transaction.id);
  // Set the stage eagerly — `getOrCreateMultisigService` and the subsequent
  // `createXxxProposal` call can both hit the guardian over the network,
  // so surfacing "Creating proposal" immediately is more honest than
  // leaving the label stuck on "Sending transaction".
  await stepTimer.startTime('guardian-approving');
  await setTransactionStage(transaction.id, 'creating-proposal');

  let proposalResult: Proposal;
  // The service that creates the proposal AND issues the final
  // signAndCreateTransactionRequest. Hot-bound for routine ops; cold-bound for
  // structural ops (replace-hot-key / update-procedure-threshold) and for
  // background auto-consume. The hot-bound path is the only one cached by
  // guardian-manager; cold services here are transient.
  //
  // `withGuardianConflictRetry` waits out a transient 409 ConflictPendingDelta
  // (a prior delta still canonicalizing) instead of failing the tx. It wraps
  // only side-effect-free proposal creation — NOT replace-hot-key, whose
  // createReplaceHotKeyProposal mints a fresh hardware hot key, so retrying it
  // would orphan SE/StrongBox keys.
  let service: MultisigService;

  switch (transaction.type) {
    case 'send': {
      const sendTx = transaction as SendTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() =>
        service.createSendProposal(sendTx.secondaryAccountId, sendTx.faucetId, BigInt(sendTx.amount))
      );
      break;
    }
    case 'consume': {
      const consumeTx = transaction as ConsumeTransaction;
      // Background/auto-consume signs with the COLD key so it doesn't pop a
      // biometric prompt: consuming a note is value-in (claims an incoming note
      // into your own vault — it can't move funds out), so it needs no user
      // presence, and threshold-1 means cold + guardian satisfies it on-chain.
      // User-initiated claims stay hot-bound (tap-to-confirm biometric on mobile).
      service = consumeTx.background
        ? await buildColdServiceForAccount(transaction.accountId, guardianProvider)
        : await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() => service.createConsumeNotesProposal([consumeTx.noteId]));
      break;
    }
    case 'switch-guardian': {
      const sgTx = transaction as SwitchGuardianTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const { proposal } = await withGuardianConflictRetry(() =>
        service.createSwitchGuardianProposal(sgTx.extraInputs.newGuardianEndpoint)
      );
      proposalResult = proposal;
      break;
    }
    case 'replace-hot-key': {
      const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === transaction.accountId);
      if (!walletAccount) {
        throw new Error(`Guardian account ${transaction.accountId} not found in provider`);
      }
      const sdkAccount = await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        return midenClient.getAccount(transaction.accountId);
      });
      if (!sdkAccount) {
        throw new Error(`Guardian account ${transaction.accountId} not found in local client`);
      }
      service = await MultisigService.buildColdMultisigService(sdkAccount, walletAccount, guardianProvider.signWord);
      // NOT retry-wrapped — createReplaceHotKeyProposal mints a hot key.
      const { proposal, newHot } = await service.createReplaceHotKeyProposal(sdkAccount);
      if (!guardianProvider.persistNewHotKey) {
        throw new Error('persistNewHotKey not implemented in this provider');
      }
      // Persist the new hot ciphertext BEFORE submitting. Old hot stays valid
      // until the on-chain rotation lands so this is idempotent. If the app
      // dies between submit and complete, the new ciphertext is on disk and
      // complete reconciles against the on-chain state.
      // KNOWN LEAK: if this rotation terminally fails (submit error → tx
      // cancelled, never reconciled) and the user re-initiates, a fresh hardware
      // key is minted while this one's SE/Keystore entry + ciphertext blob are
      // left orphaned (inert). A blind delete-on-failure here is unsafe — the
      // persist-before-submit design relies on this blob surviving for the
      // reconcile path — so reaping orphaned pending keys belongs in a dedicated
      // cleanup, not this hot path.
      await guardianProvider.persistNewHotKey(newHot.publicKeyHex, newHot.ciphertext);
      // Stash the new pubkey on the in-memory transaction AND in dexie so
      // complete (which may run after a process restart) can find it.
      const rTx = transaction as ReplaceHotKeyTransaction;
      rTx.extraInputs = { ...(rTx.extraInputs ?? {}), newHotPublicKey: newHot.publicKeyHex };
      await Repo.transactions.where({ id: transaction.id }).modify(t => {
        t.extraInputs = rTx.extraInputs;
      });
      proposalResult = proposal;
      break;
    }
    case 'update-procedure-threshold': {
      // Cold-routed structural change (same class as switch-guardian /
      // replace-hot-key): cold + guardian satisfies it on-chain.
      const uptTx = transaction as UpdateProcedureThresholdTransaction;
      service = await buildColdServiceForAccount(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() =>
        service.createUpdateProcedureThresholdProposal(uptTx.extraInputs.procedure, uptTx.extraInputs.threshold)
      );
      break;
    }
    case 'execute':
    default: {
      // For custom transactions, build a custom proposal from the serialized
      // request bytes. Hot-routed (threshold-1). A custom proposal that embeds a
      // structural op (e.g. update_guardian / add_signer) cannot bypass the
      // hardening: the on-chain `procedureThresholds` map enforces per-procedure
      // thresholds (update_guardian = 2 → needs cold + guardian) during proof
      // verification regardless of which key signed the proposal here.
      const requestBytes = transaction.requestBytes;
      if (!requestBytes) {
        throw new Error('Request Bytes not available for custom transaction');
      }
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await withGuardianConflictRetry(() => service.createCustomProposal(requestBytes));
      break;
    }
  }

  // Sign and execute the proposal
  await setTransactionStage(transaction.id, 'signing-proposal');

  // switch_guardian is on-chain threshold-2 (set at create time via
  // procedureThresholds). Hot's signAndCreateTransactionRequest below
  // contributes one sig; we add the cold sig here. Sigs accumulate on the
  // Guardian server keyed by proposal id so order doesn't matter, and the
  // transient cold service is dropped at scope exit.
  if (transaction.type === 'switch-guardian') {
    const walletAccount = (await guardianProvider.getAccounts()).find(a => a.publicKey === transaction.accountId);
    if (!walletAccount) {
      throw new Error(`Guardian account ${transaction.accountId} not found in provider`);
    }
    const sdkAccount = await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      return midenClient.getAccount(transaction.accountId);
    });
    if (!sdkAccount) {
      throw new Error(`Guardian account ${transaction.accountId} not found in local client`);
    }
    const coldService = await MultisigService.buildColdMultisigService(
      sdkAccount,
      walletAccount,
      guardianProvider.signWord
    );
    // Wait out a transient 409 ConflictPendingDelta on the cold co-sign too —
    // otherwise a prior delta mid-canonicalization fails the whole switch even
    // though the hot proposal already landed.
    await withGuardianConflictRetry(() => coldService.signProposal(proposalResult.id));
  }

  const tr = await service.signAndCreateTransactionRequest(proposalResult.id, transaction.requestBytes);
  await stepTimer.endTime('guardian-approving');
  console.log('Created transaction request from proposal, submitting to Miden client');
  const options: MidenClientCreateOptions = {
    signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
      console.log('Signing transaction request with external callback');
      const keyString = Buffer.from(publicKey).toString('hex');
      const signingInputsString = Buffer.from(signingInputs).toString('hex');
      return await signCallback(keyString, signingInputsString);
    }
  };

  await setTransactionStage(transaction.id, 'sending');
  await stepTimer.startTime('generating-proof');
  const transactionResult = await (async () => {
    try {
      return await withWasmClientLock(async () => {
        try {
          const midenClient = await getMidenClient(options);
          const { result } = await midenClient.client.transactions.submit(transaction.accountId, tr, {
            prover: !transaction.delegateTransaction ? TransactionProver.newLocalProver() : undefined
          });
          return result;
        } catch (error) {
          console.error('Error during transaction submission or execution', { error });
          throw error;
        }
      });
    } finally {
      await stepTimer.endTime('generating-proof');
    }
  })();
  await setTransactionStage(transaction.id, 'submitting');

  // For switch-guardian, the new guardian must be seeded with the POST-switch
  // account state. submit() returns after submission, not after inclusion, so
  // without this wait finalizeGuardianSwitch would serialize the pre-switch
  // account and register that stale state with the new guardian.
  // For replace-hot-key, we wait so the WalletAccount.hotPublicKey swap in
  // complete only happens once the on-chain rotation is final — otherwise a
  // resync could race with stale on-chain state and pick the wrong canonical
  // hot pubkey.
  // For update-procedure-threshold, we wait so the post-completion guardian
  // re-registration serializes the COMMITTED post-threshold state — otherwise it
  // could push a pre-threshold blob and leave the guardian diverged again.
  if (
    transaction.type === 'switch-guardian' ||
    transaction.type === 'replace-hot-key' ||
    transaction.type === 'update-procedure-threshold'
  ) {
    await setTransactionStage(transaction.id, 'confirming');
    await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      await midenClient.waitForTransactionCommit(transactionResult.executedTransaction().id().toHex());
    });
  }

  switch (transaction.type) {
    case 'send':
      await completeSendTransaction(transaction as SendTransaction, transactionResult);
      break;
    case 'consume':
      await completeConsumeTransaction(transaction.id, transactionResult);
      break;
    case 'switch-guardian':
      console.log('Completing switch guardian transaction');
      await completeSwitchGuardianTransaction(
        transaction as SwitchGuardianTransaction,
        transactionResult,
        service,
        guardianProvider
      );
      break;
    case 'replace-hot-key':
      console.log('Completing replace-hot-key transaction');
      await completeReplaceHotKeyTransaction(
        transaction as ReplaceHotKeyTransaction,
        transactionResult,
        guardianProvider,
        service
      );
      break;
    case 'update-procedure-threshold':
      console.log('Completing update-procedure-threshold transaction');
      await completeUpdateProcedureThresholdTransaction(
        transaction as UpdateProcedureThresholdTransaction,
        transactionResult,
        service
      );
      break;
    case 'execute':
    default:
      await completeCustomTransaction(transaction, transactionResult);
      break;
  }
  // Sync the cached hot service so the next consumer sees post-tx state.
  // Skip for replace-hot-key: that path's service is a transient cold one,
  // and the cached hot service was invalidated in completeReplaceHotKeyTransaction
  // via clearGuardianServiceFor — next access re-inits with the new hot pubkey.
  //
  // Post-completion bookkeeping only: the transaction is already marked Completed
  // and the on-chain submit succeeded, so a sync failure here must NOT propagate
  // (it would flip a genuinely-successful transaction to Failed). The next sync
  // tick reconciles.
  // replace-hot-key and update-procedure-threshold both run on a transient cold
  // service and invalidate the cached hot service in their completion handlers,
  // so there's nothing useful to sync here.
  if (transaction.type !== 'replace-hot-key' && transaction.type !== 'update-procedure-threshold') {
    try {
      console.log('Transaction generation complete, syncing multisig service');
      await service.sync();
    } catch (error) {
      console.warn('[Guardian] post-completion sync failed; will reconcile on next tick', error);
    }
  }
};

export const cancelTransaction = async (transaction: Transaction, error: any) => {
  // Refuse to downgrade a finalized transaction. A late error fired AFTER
  // completeXxxTransaction has already marked the tx Completed (most often
  // a transient guardian-canonicalization sync error) would otherwise flip
  // a perfectly-successful transaction to Failed and confuse the user.
  const existing = await Repo.transactions.where({ id: transaction.id }).first();
  if (existing && (existing.status === ITransactionStatus.Completed || existing.status === ITransactionStatus.Failed)) {
    console.warn(
      `[cancelTransaction] ignored — tx ${transaction.id} is already ${existing.status}; suppressed error:`,
      error
    );
    return;
  }

  await Repo.transactions.where({ id: transaction.id }).modify(dbTx => {
    dbTx.completedAt = Math.floor(Date.now() / 1000); // Convert to seconds
    closeOpenStepTimings(dbTx);
    dbTx.status = ITransactionStatus.Failed;
    dbTx.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    dbTx.displayMessage = 'Failed';
    dbTx.displayIcon = 'FAILED';
  });
};

export const cancelTransactionById = async (id: string, error: any) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (tx) await cancelTransaction(tx, error);
};

export const getTransactionById = async (id: string) => {
  const tx = await Repo.transactions.where({ id }).first();
  if (!tx) throw new Error('Transaction not found');
  return tx;
};

export const generateTransactionsLoop = async (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
): Promise<boolean | void> => {
  await cancelStuckTransactions();
  await cancelStaleQueuedTransactions();

  // Import any notes needed for queued transactions
  await importAllNotes();

  // Wait for other in progress transactions
  const inProgressTransactions = await getTransactionsInProgress();
  if (inProgressTransactions.length > 0) {
    return;
  }

  // Find transactions waiting to process
  const queuedTransactions = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  queuedTransactions.sort((tx1, tx2) => tx1.initiatedAt - tx2.initiatedAt);
  if (queuedTransactions.length === 0) {
    return;
  }

  // Process next transaction
  const nextTransaction = queuedTransactions[0];
  if (!nextTransaction) return; // redundant after length check but satisfies the type narrower

  // Call safely to cancel transaction and unlock records if something goes wrong
  try {
    await generateTransaction(nextTransaction, signCallback, useWorker, guardianProvider);
    return true;
  } catch (e) {
    logger.warning('Failed to generate transaction', e);
    // The SDK attaches a stable `errorCode` string to thrown errors for
    // variants callers are expected to dispatch on. See
    // `error_code_from_client_error` in miden-client.
    const errorCode = extractSdkErrorCode(e);

    // If the failure was caused by the wallet being locked mid-sign,
    // leave the tx Queued rather than marking it Failed — the next
    // auto-consume cycle (after the wallet unlocks) will retry it.
    // This prevents the note-loss scenario the 1000-op stress run
    // surfaced: lock during executeTransaction → tx cancelled → next
    // cycle starts fresh but some races can leave the note stuck.
    const authReason = await readLastAuthReason();
    if (authReason === 'locked') {
      logger.warning('Sign callback reported locked wallet; leaving tx queued for retry');
      return false;
    }

    // Submit succeeded but apply failed: the tx IS live on chain. Mark
    // as Completed (not Failed) so the activity tab shows the right
    // outcome; the next sync will reconcile note states via
    // ConsumedExternal. Retrying would hit the node's nullifier check
    // and produce a misleading "already consumed" error.
    if (errorCode === 'ApplyTransactionAfterSubmitFailed') {
      logger.warning('Transaction submitted but local apply failed; marking Completed, sync will reconcile');
      const tx = await Repo.transactions.where({ id: nextTransaction.id }).first();
      if (tx && tx.status !== ITransactionStatus.Completed) {
        // Structural Guardian ops never reach here — they're routed through the
        // guardian branch of `generateTransaction`, whose own catch handles the
        // apply-after-submit-failed reconcile (see `reconcileStructuralApplyFailure`).
        // This generic path covers send/consume, whose note states the next sync
        // reconciles via ConsumedExternal.
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
          displayMessage: 'Completed',
          completedAt: Math.floor(Date.now() / 1000)
        });
      }
      return false;
    }

    // If the input note was already consumed on chain, the pre-flight
    // nullifier check transitioned it to ConsumedExternal. Mark this tx
    // Failed (it never reached chain) but the note is already reconciled
    // — subsequent cycles won't retry it.
    if (errorCode === 'InputNoteAlreadyConsumedOnChain') {
      logger.warning('Input note already consumed on chain; tx unnecessary');
    }

    // Cancel the transaction if it hasn't already been cancelled
    const tx = await Repo.transactions.where({ id: nextTransaction.id }).first();
    if (tx && tx.status !== ITransactionStatus.Failed) await cancelTransaction(tx, e);
    return false;
  }
};

/**
 * Pulls the stable SDK error code off a thrown value, if present. The
 * SDK attaches `errorCode` via `Reflect::set` on JsError — see
 * `js_error_with_context` in miden-client.
 */
function extractSdkErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Reads the SDK-captured last auth error and extracts a `reason` tag if
 * present. Returns undefined if there was no auth failure or the thrown
 * value didn't carry a reason.
 */
export async function readLastAuthReason(): Promise<SignCallbackReason | undefined> {
  try {
    const midenClient = await getMidenClient();
    const rawClient = (midenClient as any).client;
    if (!rawClient || typeof rawClient.lastAuthError !== 'function') return undefined;
    const raw = rawClient.lastAuthError();
    if (!raw || typeof raw !== 'object') return undefined;
    const reason = (raw as { reason?: unknown }).reason;
    if (reason === 'locked' || reason === 'rejected' || reason === 'not_found' || reason === 'internal') {
      return reason;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export const safeGenerateTransactionsLoop = async (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = true,
  guardianProvider: GuardianAccountProvider
) => {
  return navigator.locks
    .request(`generate-transactions-loop`, { ifAvailable: true }, async lock => {
      if (!lock) return;

      const result = await generateTransactionsLoop(signCallback, useWorker, guardianProvider);
      if (result === false) {
        return false;
      }

      // Either a transaction was processed successfully (true)
      // or there was nothing to do / another transaction is in progress (undefined).
      return true;
    })
    .catch(e => {
      logger.error('Error in safe generate transactions loop', e);
      return false;
    });
};

/**
 * Start background transaction processing for dApp transactions.
 * This runs the transaction loop without any UI, using the backend's signTransaction directly.
 * Polls every 5 seconds until all queued transactions are processed.
 */
export const startBackgroundTransactionProcessing = (
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  useWorker: boolean = false,
  guardianProvider: GuardianAccountProvider
) => {
  // Process transactions in a loop until none are left
  const processLoop = async () => {
    let hasMore = true;
    let attempts = 0;
    const maxAttempts = 60; // Max 5 minutes (60 * 5 seconds)

    while (hasMore && attempts < maxAttempts) {
      attempts++;
      await safeGenerateTransactionsLoop(signCallback, useWorker, guardianProvider);

      // Check if there are more transactions to process
      const remaining = await getAllUncompletedTransactions();
      hasMore = remaining.length > 0;

      if (hasMore) {
        // Wait before next attempt
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  };

  // Run in background (don't await)
  processLoop().catch(e => {
    console.error('[BackgroundTxProcessor] Error:', e);
  });
};

const WAIT_FOR_TX_TIMEOUT = 5 * 60_000; // 5 minutes

export const waitForTransactionCompletion = async (transactionId: string) => {
  return new Promise<TransactionOutput>(resolve => {
    let subscription: { unsubscribe: () => void } | null = null;

    const timeoutId = setTimeout(() => {
      subscription?.unsubscribe();
      resolve({ errorMessage: 'Transaction timed out' });
    }, WAIT_FOR_TX_TIMEOUT);

    const cleanup = () => {
      clearTimeout(timeoutId);
      subscription?.unsubscribe();
    };

    subscription = liveQuery(() => Repo.transactions.where({ id: transactionId }).first()).subscribe({
      next: tx => {
        if (!tx) {
          // Transaction not found - resolve with error
          cleanup();
          resolve({ errorMessage: 'Transaction not found' });
          return;
        }

        if (tx.status === ITransactionStatus.Completed) {
          cleanup();
          const txResult = TransactionResult.deserialize(tx.resultBytes!);
          const res = {
            txHash: tx.transactionId!,
            outputNotes: txResult
              .executedTransaction()
              .outputNotes()
              .notes()
              .map(no => no.intoFull())
              .filter(no => !!no)
              .map(fullNote => u8ToB64(fullNote.serialize()))
          };
          resolve(res);
        } else if (tx.status === ITransactionStatus.Failed) {
          cleanup();
          resolve({ errorMessage: tx.error || 'Transaction failed' });
        }
      },
      error: err => {
        cleanup();
        resolve({ errorMessage: err?.message || 'Subscription error' });
      }
    });
  });
};
