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
import * as Repo from 'lib/miden/repo';
import { isExtension, isMobile } from 'lib/platform';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { u8ToB64 } from 'lib/shared/helpers';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';
import { logger } from 'shared/logger';

import {
  ConsumeTransaction,
  ITransaction,
  ITransactionStage,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwitchGuardianTransaction,
  Transaction,
  TransactionOutput
} from '../db/types';
import { putToStorage } from '../front';
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
  delegateTransaction?: boolean
): Promise<string> => {
  const dbTransaction = new ConsumeTransaction(accountId, note, delegateTransaction);
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
 * Queue a switch-guardian transaction for a Guardian account. The local
 * `GUARDIAN_URL_STORAGE_KEY` is NOT updated here — it's written only after
 * the on-chain proposal lands, in `completeSwitchGuardianTransaction`.
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
  result: TransactionResult,
  guardianProvider: GuardianAccountProvider
) => {
  try {
    const executedTx = result.executedTransaction();
    const newHotPublicKey = tx.extraInputs?.newHotPublicKey;
    if (!newHotPublicKey) {
      throw new Error('Replace-hot-key tx is missing newHotPublicKey in extraInputs');
    }

    if (!guardianProvider.swapHotKey) {
      throw new Error('swapHotKey not implemented in this provider');
    }
    // Vault.swapHotKey resolves the previous hot pubkey from the persisted
    // WalletAccount and is idempotent: if the record already reflects
    // `newHotPublicKey` (retry), the cleanup branch is a no-op.
    await guardianProvider.swapHotKey(tx.accountId, newHotPublicKey);
    // Drop the cached MultisigService — its bound hot signer is now stale.
    clearGuardianServiceFor(tx.accountId);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Device key rotated',
      transactionId: executedTx.id().toHex(),
      completedAt: Math.floor(Date.now() / 1000),
      resultBytes: result.serialize()
    });
  } catch (error) {
    console.error('Error completing replace-hot-key transaction:', error);
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Failed to rotate device key',
      completedAt: Math.floor(Date.now() / 1000),
      resultBytes: result.serialize(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

export const completeSwitchGuardianTransaction = async (
  tx: SwitchGuardianTransaction,
  result: TransactionResult,
  multisigService: MultisigService
) => {
  try {
    const executedTx = result.executedTransaction();
    const { newGuardianEndpoint } = tx.extraInputs;

    // Mirror upstream `multisig.executeProposal`'s post-submit block for
    // switch_guardian proposals: register on the new guardian with the
    // updated account state before anything else touches the local cache
    // or storage. If this throws, storage + status stay untouched so the
    // user can retry.
    await setTransactionStage(tx.id, 'registering-guardian');
    await multisigService.finalizeGuardianSwitch(newGuardianEndpoint);

    await putToStorage(GUARDIAN_URL_STORAGE_KEY, newGuardianEndpoint);
    clearGuardianServiceFor(tx.accountId);

    await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
      displayMessage: 'Guardian switched',
      transactionId: executedTx.id().toHex(),
      completedAt: Math.floor(Date.now() / 1000), // seconds
      resultBytes: result.serialize()
    });
  } catch (error) {
    console.error('Error completing switch guardian transaction:', error);
    await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
      displayMessage: 'Failed to switch guardian',
      completedAt: Math.floor(Date.now() / 1000), // seconds
      resultBytes: result.serialize(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

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
    // Wrap all WASM client operations in a lock to prevent concurrent access
    type SendResult = { success: true } | { success: false; errorType: 'init' | 'transport'; error: unknown };
    await setTransactionStage(tx.id, 'confirming');
    const sendResult = await withWasmClientLock<SendResult>(async () => {
      try {
        const midenClient = await getMidenClient();
        await midenClient.waitForTransactionCommit(executedTx.id().toHex());
        await setTransactionStage(tx.id, 'delivering');
        await midenClient.sendPrivateNote(note, tx.secondaryAccountId);
        return { success: true };
      } catch (error) {
        return { success: false, errorType: 'transport', error };
      }
    }).catch(error => ({ success: false, errorType: 'init' as const, error }));

    if (!sendResult.success) {
      // Guardian canonicalization is eventually-consistent — if the SDK
      // refused to overwrite local state with a stale nonce, the tx was
      // still submitted on-chain. Mark Completed and let the next sync
      // reconcile, instead of misreporting the tx as Failed.
      if (isGuardianCanonicalizationError(sendResult.error)) {
        console.warn(
          '[Guardian] canonicalization race during private-note send — marking Completed:',
          sendResult.error
        );
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
          displayMessage: 'Sent',
          transactionId: executedTx.id().toHex(),
          outputNoteIds,
          completedAt: Math.floor(Date.now() / 1000), // seconds
          resultBytes: result.serialize()
        });
        return;
      }

      if (sendResult.errorType === 'transport') {
        console.error('Failed to send private note through the transport layer', {
          txId: tx.id,
          secondaryAccountId: tx.secondaryAccountId,
          error: sendResult.error
        });
        await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
          displayMessage: 'Send failed: transport error',
          displayIcon: 'FAILED',
          transactionId: executedTx.id().toHex(),
          outputNoteIds,
          completedAt: Math.floor(Date.now() / 1000) // seconds
        });
      } else {
        console.error('Failed to initialize Miden client for private note send', {
          txId: tx.id,
          error: sendResult.error
        });
        await updateTransactionStatus(tx.id, ITransactionStatus.Failed, {
          displayMessage: 'Send failed: transport init error',
          displayIcon: 'FAILED',
          transactionId: executedTx.id().toHex(),
          outputNoteIds,
          completedAt: Math.floor(Date.now() / 1000) // seconds
        });
      }
      return;
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
    t.status = status;
  });
};

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
  // Sync state first to ensure we have latest account state
  // Separate lock acquisition to avoid holding lock during network call
  // If sync fails (e.g. network down), the error propagates to generateTransactionsLoop's
  // catch block which cancels the transaction — this is intentional fail-fast behavior,
  // since the transaction can't be submitted without network anyway
  await setTransactionStage(transaction.id, 'syncing');
  await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    await midenClient.syncState();
  });

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
      await generateGuardianTransaction(transaction, signCallback, guardianProvider);
    } catch (error) {
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
      return await signCallback(keyString, signingInputsString);
    }
  };

  // MidenClient handles the full pipeline (execute → prove → submit → apply)
  const result = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient(options);
    switch (transaction.type) {
      case 'send':
        return midenClient.sendTransaction(transaction as SendTransaction);
      case 'consume':
        return await midenClient.consumeNoteId(transaction as ConsumeTransaction);
      case 'execute':
      default:
        return midenClient.newTransaction(
          transaction.accountId,
          transaction.requestBytes!,
          transaction.delegateTransaction
        );
    }
  });

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
 * Generate a transaction for a Guardian account using the MultisigService.
 * Routes the transaction through MultisigService proposal methods.
 */
const generateGuardianTransaction = async (
  transaction: ITransaction,
  signCallback: (publicKey: string, signingInputs: string) => Promise<Uint8Array>,
  guardianProvider: GuardianAccountProvider
): Promise<void> => {
  console.log('Generating Guardian transaction');
  // Set the stage eagerly — `getOrCreateMultisigService` and the subsequent
  // `createXxxProposal` call can both hit the guardian over the network,
  // so surfacing "Creating proposal" immediately is more honest than
  // leaving the label stuck on "Sending transaction".
  await setTransactionStage(transaction.id, 'creating-proposal');

  let proposalResult: Proposal;
  // The service that creates the proposal AND issues the final
  // signAndCreateTransactionRequest. Hot-bound for every type except
  // replace-hot-key, which is cold-bound because the hot key being replaced
  // cannot authorize its own rotation. The hot-bound path is also the only
  // one cached by guardian-manager; the cold service here is transient.
  let service: MultisigService;

  switch (transaction.type) {
    case 'send': {
      const sendTx = transaction as SendTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await service.createSendProposal(
        sendTx.secondaryAccountId,
        sendTx.faucetId,
        BigInt(sendTx.amount)
      );
      break;
    }
    case 'consume': {
      const consumeTx = transaction as ConsumeTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      proposalResult = await service.createConsumeNotesProposal([consumeTx.noteId]);
      break;
    }
    case 'switch-guardian': {
      const sgTx = transaction as SwitchGuardianTransaction;
      service = await getOrCreateMultisigService(transaction.accountId, guardianProvider);
      const { proposal } = await service.createSwitchGuardianProposal(sgTx.extraInputs.newGuardianEndpoint);
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
      const { proposal, newHot } = await service.createReplaceHotKeyProposal(sdkAccount);
      if (!guardianProvider.persistNewHotKey) {
        throw new Error('persistNewHotKey not implemented in this provider');
      }
      // Persist the new hot ciphertext BEFORE submitting. Old hot stays valid
      // until the on-chain rotation lands so this is idempotent. If the app
      // dies between submit and complete, the new ciphertext is on disk and
      // complete reconciles against the on-chain state.
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
    // case 'execute':
    // default: {
    // // For custom transactions, get TransactionSummary and create a custom proposal
    // const summaryBytes = await withWasmClientLock(async () => {
    //   const midenClient = await getMidenClient();
    //   const txRequest = TransactionRequest.deserialize(transaction.requestBytes!);
    //   return (
    //     await midenClient.client.transactions.preview(accountIdStringToSdk(transaction.accountId), txRequest)
    //   ).serialize();
    // });
    // proposalResult = await multisigService.createCustomProposal(summaryBytes);
    // break;
    // }
    default: {
      throw new Error(`Unsupported transaction type for Guardian account: ${transaction.type}`);
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
    await coldService.signProposal(proposalResult.id);
  }

  const tr = await service.signAndCreateTransactionRequest(proposalResult.id);
  console.log('Created transaction request from proposal, submitting to Miden client', tr.authArg()?.toHex());
  const options: MidenClientCreateOptions = {
    signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
      console.log('Signing transaction request with external callback');
      const keyString = Buffer.from(publicKey).toString('hex');
      const signingInputsString = Buffer.from(signingInputs).toString('hex');
      return await signCallback(keyString, signingInputsString);
    }
  };

  await setTransactionStage(transaction.id, 'submitting');
  const transactionResult = await withWasmClientLock(async () => {
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

  // For switch-guardian, the new guardian must be seeded with the POST-switch
  // account state. submit() returns after submission, not after inclusion, so
  // without this wait finalizeGuardianSwitch would serialize the pre-switch
  // account and register that stale state with the new guardian.
  // For replace-hot-key, we wait so the WalletAccount.hotPublicKey swap in
  // complete only happens once the on-chain rotation is final — otherwise a
  // resync could race with stale on-chain state and pick the wrong canonical
  // hot pubkey.
  if (transaction.type === 'switch-guardian' || transaction.type === 'replace-hot-key') {
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
      await completeSwitchGuardianTransaction(transaction as SwitchGuardianTransaction, transactionResult, service);
      break;
    case 'replace-hot-key':
      console.log('Completing replace-hot-key transaction');
      await completeReplaceHotKeyTransaction(
        transaction as ReplaceHotKeyTransaction,
        transactionResult,
        guardianProvider
      );
      break;
    // case 'execute':
    // default:
    //   await completeCustomTransaction(transaction, transactionResult);
    //   break;
  }
  // Sync the cached hot service so the next consumer sees post-tx state.
  // Skip for replace-hot-key: that path's service is a transient cold one,
  // and the cached hot service was invalidated in completeReplaceHotKeyTransaction
  // via clearGuardianServiceFor — next access re-inits with the new hot pubkey.
  //
  // NOTE: this sync runs AFTER the tx has already been marked Completed by
  // the completeXxxTransaction call above. Guardian canonicalization is
  // eventually-consistent, so a transient error here (e.g. "Refusing to
  // overwrite local state: incoming nonce 0 is not greater than local nonce
  // 1") doesn't mean the user's transaction failed — it just means the
  // guardian's view hasn't caught up yet, and the next sync tick will
  // reconcile. Swallow the error so the outer try/catch doesn't roll the
  // already-Completed tx back to Failed.
  if (transaction.type !== 'replace-hot-key') {
    console.log('Transaction generation complete, syncing multisig service');
    try {
      await service.sync();
    } catch (error) {
      console.warn('[Guardian] post-completion service.sync() failed (ignored):', error);
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
    // Cancel the transaction if it hasn't already been cancelled
    const tx = await Repo.transactions.where({ id: nextTransaction.id }).first();
    if (tx && tx.status !== ITransactionStatus.Failed) await cancelTransaction(tx, e);
    return false;
  }
};

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
