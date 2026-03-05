import {
  Address,
  InputNoteState,
  Note,
  NoteFilter,
  NoteFilterTypes,
  NoteId,
  TransactionResult
} from '@miden-sdk/miden-sdk';
import { liveQuery } from 'dexie';

import { consumeNoteId } from 'lib/miden-worker/consumeNoteId';
import { sendTransaction } from 'lib/miden-worker/sendTransaction';
import { submitTransaction } from 'lib/miden-worker/submitTransaction';
import * as Repo from 'lib/miden/repo';
import { isMobile } from 'lib/platform';
import { u8ToB64 } from 'lib/shared/helpers';
import { logger } from 'shared/logger';

import {
  ConsumeTransaction,
  ITransaction,
  ITransactionStatus,
  SendTransaction,
  Transaction,
  TransactionOutput
} from '../db/types';
import { toNoteTypeString } from '../helpers';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenClientCreateOptions } from '../sdk/miden-client-interface';
import { ConsumableNote, NoteTypeEnum, NoteType as NoteTypeString } from '../types';
import { interpretTransactionResult } from './helpers';
import { importAllNotes, queueNoteImport, registerOutputNote } from './notes';
import { compareAccountIds } from './utils';

// On mobile, use a shorter timeout since there's no background processing
// On desktop extension, transactions can run in background tabs
export const MAX_WAIT_BEFORE_CANCEL = isMobile() ? 2 * 60_000 : 30 * 60_000; // 2 mins on mobile, 30 mins on desktop

// Maximum age for a queued transaction before it's considered stale and cancelled
export const MAX_QUEUED_AGE = 30 * 60_000; // 30 minutes

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

    await registerOutputNote(note.id().toString());

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
          const recipientAccountAddress = Address.fromBech32(transaction.secondaryAccountId!);
          await midenClient.sendPrivateNote(fullNote, recipientAccountAddress);
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
  const note: ConsumableNote = {
    id: noteId,
    faucetId: '',
    amount: '',
    senderAddress: '',
    isBeingClaimed: false
  };

  return await initiateConsumeTransaction(accountId, note, delegateTransaction);
};

export const initiateConsumeTransaction = async (
  accountId: string,
  note: ConsumableNote,
  delegateTransaction?: boolean
): Promise<string> => {
  const dbTransaction = new ConsumeTransaction(accountId, note, delegateTransaction);
  const uncompletedTransactions = await getUncompletedTransactions(accountId);
  const existingTransaction = uncompletedTransactions.find(tx => tx.type === 'consume' && tx.noteId === note.id);
  if (existingTransaction) {
    return existingTransaction.id;
  }

  await Repo.transactions.add(dbTransaction);

  return dbTransaction.id;
};

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
  const note = result.executedTransaction().inputNotes().notes()[0].note();
  const sender = getBech32AddressFromAccountId(note.metadata().sender());
  const executedTransaction = result.executedTransaction();

  const dbTransaction = await Repo.transactions.where({ id }).first();
  const reclaimed = compareAccountIds(dbTransaction?.accountId ?? '', sender);
  const displayMessage = reclaimed ? 'Reclaimed' : 'Received';
  const secondaryAccountId = reclaimed ? undefined : sender;
  const asset = note.assets().fungibleAssets()[0];
  const faucetId = getBech32AddressFromAccountId(asset.faucetId());
  const amount = asset.amount();

  await updateTransactionStatus(id, ITransactionStatus.Completed, {
    displayMessage,
    transactionId: executedTransaction.id().toHex(),
    secondaryAccountId,
    faucetId,
    amount,
    noteType: toNoteTypeString(note.metadata().noteType()),
    completedAt: Date.now() / 1000, // Convert to seconds.
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

const extractFullNote = (result: TransactionResult): Note | undefined => {
  try {
    const outputNotes = result.executedTransaction().outputNotes().notes();

    if (!outputNotes || outputNotes.length === 0) {
      console.error('No output notes found for executed transaction');
      return undefined;
    }

    const fullNote = outputNotes[0].intoFull();

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
    await registerOutputNote(noteId);

    // Wrap all WASM client operations in a lock to prevent concurrent access
    type SendResult = { success: true } | { success: false; errorType: 'init' | 'transport'; error: unknown };
    const sendResult = await withWasmClientLock<SendResult>(async () => {
      try {
        const midenClient = await getMidenClient();
        await midenClient.waitForTransactionCommit(executedTx.id().toHex());
        const recipientAccountAddress = Address.fromBech32(tx.secondaryAccountId);
        await midenClient.sendPrivateNote(note, recipientAccountAddress);
        return { success: true };
      } catch (error) {
        return { success: false, errorType: 'transport', error };
      }
    }).catch(error => ({ success: false, errorType: 'init' as const, error }));

    if (!sendResult.success) {
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
      return Date.now() - tx.processingStartedAt > MAX_WAIT_BEFORE_CANCEL;
    })
    .map(async tx => cancelTransaction(tx, 'Transaction took too long to process and was cancelled'));

  await Promise.all(cancelTransactionUpdates);
};

/**
 * Cancel queued transactions that have been waiting too long (TTL expired)
 */
export const cancelStaleQueuedTransactions = async () => {
  const queued = await Repo.transactions.filter(rec => rec.status === ITransactionStatus.Queued).toArray();
  const stale = queued.filter(tx => Date.now() - tx.initiatedAt > MAX_QUEUED_AGE);
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
const MIN_PROCESSING_TIME_BEFORE_STUCK = 60_000; // 1 minute

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
        const noteId = NoteId.fromHex(tx.noteId);
        const noteFilter = new NoteFilter(NoteFilterTypes.List, [noteId]);
        return await midenClient.getInputNoteDetails(noteFilter);
      });

      if (noteDetails.length === 0) {
        continue;
      }

      const note = noteDetails[0];

      if (CONSUMED_NOTE_STATES.includes(note.state)) {
        // Note has been consumed on-chain - mark transaction as completed
        await updateTransactionStatus(tx.id, ITransactionStatus.Completed, {
          displayMessage: 'Received',
          completedAt: Date.now() / 1000
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
        const processingTime = tx.processingStartedAt ? Date.now() - tx.processingStartedAt : 0;
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
  useWorker: boolean = true
) => {
  // Sync state first to ensure we have latest account state
  // Separate lock acquisition to avoid holding lock during network call
  // If sync fails (e.g. network down), the error propagates to generateTransactionsLoop's
  // catch block which cancels the transaction — this is intentional fail-fast behavior,
  // since the transaction can't be submitted without network anyway
  await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    await midenClient.syncState();
  });

  // Mark transaction as in progress
  await updateTransactionStatus(transaction.id, ITransactionStatus.GeneratingTransaction, {
    processingStartedAt: Date.now()
  });

  // Process transaction
  let result: TransactionResult;
  const options: MidenClientCreateOptions = {
    signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) => {
      const keyString = Buffer.from(publicKey).toString('hex');
      const signingInputsString = Buffer.from(signingInputs).toString('hex');
      return await signCallback(keyString, signingInputsString);
    }
  };

  // Wrap WASM client operations in a lock to prevent concurrent access
  const transactionResultBytes = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient(options);
    switch (transaction.type) {
      case 'send':
        return midenClient.sendTransaction(transaction as SendTransaction);
      case 'consume':
        return await midenClient.consumeNoteId(transaction as ConsumeTransaction);
      case 'execute':
      default:
        return midenClient.newTransaction(transaction.accountId, transaction.requestBytes!);
    }
  });

  // On mobile, always delegate transactions to avoid memory issues with local proving
  const shouldDelegate = isMobile() ? true : transaction.delegateTransaction;

  switch (transaction.type) {
    case 'send':
      if (useWorker) {
        const resultBytes = await sendTransaction(transactionResultBytes, shouldDelegate);
        result = TransactionResult.deserialize(resultBytes);
      } else {
        result = await withWasmClientLock(async () => {
          const midenClient = await getMidenClient();
          return await midenClient.submitTransaction(transactionResultBytes, shouldDelegate);
        });
      }
      await completeSendTransaction(transaction as SendTransaction, result);
      break;
    case 'consume':
      if (useWorker) {
        const resultBytes = await consumeNoteId(transactionResultBytes, shouldDelegate);
        result = TransactionResult.deserialize(resultBytes);
      } else {
        result = await withWasmClientLock(async () => {
          const midenClient = await getMidenClient();
          return await midenClient.submitTransaction(transactionResultBytes, shouldDelegate);
        });
      }
      await completeConsumeTransaction(transaction.id, result);
      break;
    case 'execute':
    default:
      if (useWorker) {
        const resultBytes = await submitTransaction(transactionResultBytes, shouldDelegate);
        result = TransactionResult.deserialize(resultBytes);
      } else {
        result = await withWasmClientLock(async () => {
          const midenClient = await getMidenClient();
          return await midenClient.submitTransaction(transactionResultBytes, shouldDelegate);
        });
      }
      await completeCustomTransaction(transaction, result);
      break;
  }
};

export const cancelTransaction = async (transaction: Transaction, error: any) => {
  // Cancel the transaction
  await Repo.transactions.where({ id: transaction.id }).modify(dbTx => {
    dbTx.completedAt = Date.now() / 1000; // Convert to seconds
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
  useWorker: boolean = true
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

  // Call safely to cancel transaction and unlock records if something goes wrong
  try {
    await generateTransaction(nextTransaction, signCallback, useWorker);
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
  useWorker: boolean = true
) => {
  return navigator.locks
    .request(`generate-transactions-loop`, { ifAvailable: true }, async lock => {
      if (!lock) return;

      const result = await generateTransactionsLoop(signCallback, useWorker);
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
  useWorker: boolean = false
) => {
  // Process transactions in a loop until none are left
  const processLoop = async () => {
    let hasMore = true;
    let attempts = 0;
    const maxAttempts = 60; // Max 5 minutes (60 * 5 seconds)

    while (hasMore && attempts < maxAttempts) {
      attempts++;
      await safeGenerateTransactionsLoop(signCallback, useWorker);

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
