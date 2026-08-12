import {
  getOrCreateMultisigService,
  isGuardianAccount,
  type GuardianAccountProvider
} from 'lib/miden/front/guardian-manager';
import { resolveGuardianEndpoint } from 'lib/miden/guardian/account';
import * as Repo from 'lib/miden/repo';
import { isExtension } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';
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
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwapTransaction,
  SwitchGuardianTransaction,
  Transaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import { toNoteTypeString } from '../helpers';
import { sameWalletAccountId } from '../sdk/helpers';
import { withWasmClientLock } from '../sdk/miden-client';
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
      // then partition. We need both non-Failed (dedup) and every lifetime Failed
      // (exponential-backoff gate) inside the same rw transaction so the
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
 * Queue a cross-chain Miden→EVM send (`bridged-send`). For the agglayer (Slow)
 * route, `requestBytes` is a pre-built B2AGG `TransactionRequest` (own output
 * note) and the standard pipeline proves + submits it via `newTransaction`, then
 * `completeBridgedSendTransaction` records it. For the epoch (Fast) route there
 * are no `requestBytes` — `bridgeEpochSend` drives the row out-of-band.
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

/** Queue the recallable Miden P2IDE note that collateralizes an Earn deposit. */
export const initiateEarnDepositTransaction = async (
  accountId: string,
  amount: bigint,
  evmRecipient: string,
  marketUid: string,
  faucetId: string,
  sendParams: IBridgedSendNoteParams,
  delegateTransaction?: boolean
): Promise<string> => {
  const dbTransaction = new EarnDepositTransaction(
    accountId,
    amount,
    evmRecipient,
    marketUid,
    faucetId,
    sendParams,
    delegateTransaction
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
  const accounts = await guardianProvider.getAccounts();
  const account = accounts.find(candidate => sameWalletAccountId(candidate.publicKey, accountId));
  if (!account || account.type !== WalletType.Guardian) {
    throw new Error('Switch guardian is only supported for Guardian accounts');
  }
  const previousGuardianEndpoint = await resolveGuardianEndpoint(account);
  const dbTransaction = new SwitchGuardianTransaction(
    accountId,
    newGuardianEndpoint,
    delegateTransaction,
    previousGuardianEndpoint
  );
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
