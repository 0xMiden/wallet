import type { Note, TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { annotateCrash, type CompletionGuard } from 'lib/telemetry/crash-diagnostics';

import {
  keptValue,
  type LandedRead,
  type LandedResultFields,
  readLandedResultFields,
  readOnce
} from './landed-result-fields';
import type { AdoptableNote } from '../activity/bridge-in';
import { feeFieldsFromResult } from '../activity/fee';
import { splitLandedOutputNotes } from '../activity/fee-notes';
import { interpretTransactionResult } from '../activity/helpers';
import type {
  BridgedSendTransaction,
  EarnDepositTransaction,
  IConsumedAssetTotal,
  ITransaction,
  SendTransaction,
  SwapTransaction
} from '../db/types';
import { isPrivateNoteType, toNoteTypeString } from '../helpers';
import { swapOrderOf } from '../sdk/apply-after-submit';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { retireLandedTrap } from '../sdk/landed-trap-retirement';
import { NoteTypeEnum } from '../types';

/**
 * What each landed value completion reads off its result, read in that completion's own order and kept as plain
 * values. A handle answers only while the client that produced it has not been retired, and a Guardian row's tail
 * syncs the Guardian before its completion runs, a wait that can replace the client, so the tail reads first
 * (`readLandedCompletion`) and the completion answers from that read. Each read is synchronous and stops at the
 * statement where the completion would have stopped: a trap there is retired under the row and kept as itself, and the
 * completion rethrows it where it always surfaced. Its own internal catches are unchanged.
 */

type ExecutedTransaction = ReturnType<TransactionResult['executedTransaction']>;

export type SendRead = {
  executedTx: ExecutedTransaction;
  note: Note | undefined;
  noteId: string | undefined;
  outputNoteIds: string[];
  isPrivateSend: boolean;
  landed: LandedResultFields;
};

export type CustomRead = {
  executedTx: ExecutedTransaction;
  notesToRelay: { noteId: string; fullNote: Note }[];
  relayNoteIds: string[];
  relayDeadNoteIds: string[];
  undeliveredNotes: number;
  relayRecipientId: string | undefined;
  landed: LandedResultFields;
  interpreted: ReturnType<typeof interpretTransactionResult> | undefined;
};

type ConsumeFields = Omit<ReturnType<typeof readConsumeResult>, 'inputNotes'>;

/** A consume's reads in its completion's steps: its bytes only once its notes answered, its deliveries after both. */
export type ConsumeRead = LandedRead<
  ConsumeFields & { bytes: LandedRead<{ resultBytes: Uint8Array; deliveries: LandedRead<AdoptableNote[]> }> }
>;

export type SwapRead = {
  fromResult: ReturnType<typeof swapOrderOf>;
  feeFields: ReturnType<typeof feeFieldsFromResult>;
  transactionId: string;
  resultBytes: Uint8Array;
};

/** A bridged send's or an Earn deposit's reads: the row's one note, then the fee, the id and the bytes. */
export type NoteRowRead = {
  outputNoteIds: string[];
  feeFields: ReturnType<typeof feeFieldsFromResult>;
  transactionId: string;
  resultBytes: Uint8Array;
};

type ReadOf = {
  send: LandedRead<SendRead>;
  custom: LandedRead<CustomRead>;
  consume: ConsumeRead;
  swap: LandedRead<SwapRead>;
  'bridged-send': LandedRead<NoteRowRead>;
  'earn-deposit': LandedRead<NoteRowRead>;
};

/** A tail's read: which completion it was made for, the row it was made under and what it read. */
export type LandedCompletion = { [A in keyof ReadOf]: { arm: A; landing: string; read: ReadOf[A] } }[keyof ReadOf];

const extractFullNote = (result: TransactionResult, landing: string): Note | undefined => {
  try {
    // Excluding the kernel's fee note, which is an output note of this transaction like
    // any other and whose position among them is the kernel's business. The note this
    // returns is the one a PRIVATE send RELAYS to its recipient, so picking the fee note
    // here would hand the transport the wrong note and leave the payment undeliverable
    // while the row still completed.
    const { userNotes } = splitLandedOutputNotes(result, landing);

    const firstOutput = userNotes[0];
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
    retireLandedTrap(error, landing, result);
    console.error('Failed to extract full note from transaction result', { error });
    return undefined;
  }
};

/**
 * Does this send owe a transport relay?
 *
 * Asks the row first and then the note, and lets the note win when the two
 * disagree about privacy. The row's `noteType` is a wallet-side string recorded at
 * initiate time; the note's metadata is what the transaction actually put on
 * chain. When they diverge, only one of them determines whether the recipient can
 * ever see the note.
 *
 * The asymmetry is deliberate. Relaying a note that turns out to be public wastes a
 * request. NOT relaying one that is actually private strands the funds with no
 * trace, because a private note is unreachable without its relayed body. So a
 * mismatch resolves toward attempting the relay.
 *
 * A row whose `noteType` is unreadable is treated the same way: unknown means
 * "ask the note", not "assume public".
 */
const isPrivateOutputSend = (tx: SendTransaction, note: Note | undefined, result: TransactionResult): boolean => {
  // Via `isPrivateNoteType`, not a bare `=== NoteTypeEnum.Private` compare: a row can
  // carry the SDK's NUMERIC note type (the enum is accepted wherever a note type is
  // taken, and `Private` is `0`), which a string compare answers "public" for. That
  // would build a private note and then skip its relay entirely.
  //
  // The throw is swallowed rather than propagated because this runs AFTER the
  // transaction is on chain: failing a LANDED send before its id is captured would
  // leave Retry to rebuild the request and pay a second time. An unreadable value
  // falls through to the note's own metadata below, which is the better answer than
  // either assuming public or escalating a delivery problem into a double spend.
  try {
    if (isPrivateNoteType(tx.noteType)) return true;
  } catch (error) {
    console.warn('Unrecognized noteType on the row; deferring to the note metadata', {
      txId: tx.id,
      noteType: tx.noteType,
      error
    });
  }

  if (note) {
    try {
      if (toNoteTypeString(note.metadata().noteType()) === NoteTypeEnum.Private) {
        if (tx.noteType === NoteTypeEnum.Public) {
          console.warn('Row says public but the note is private; relaying anyway', { txId: tx.id });
        }
        return true;
      }
    } catch (error) {
      // Metadata unreadable - keep the row's answer rather than inventing one.
      retireLandedTrap(error, tx.id, result);
      console.warn('Could not read note metadata to verify note type', { txId: tx.id, error });
    }
  }

  return false;
};

const readSend = (tx: SendTransaction, result: TransactionResult): LandedRead<SendRead> =>
  readOnce(
    () => {
      const executedTx = result.executedTransaction();
      const note = extractFullNote(result, tx.id);
      const noteId = note?.id().toString();
      const outputNoteIds = noteId ? [noteId] : [];
      const isPrivateSend = isPrivateOutputSend(tx, note, result);
      // Read before the commit wait and the relay, either of which can replace the client; each write uses these
      // values, and reads the handle itself only where a read failed here.
      const landed = readLandedResultFields(result, tx.id);
      return { executedTx, note, noteId, outputNoteIds, isPrivateSend, landed };
    },
    tx.id,
    result
  );

const readCustom = (transaction: ITransaction, result: TransactionResult): LandedRead<CustomRead> =>
  readOnce(
    () => {
      const executedTx = result.executedTransaction();
      // Fee note excluded, like the other two paths that walk output notes: the loop below
      // RELAYS every private note to `transaction.secondaryAccountId`, a recipient named by
      // the requesting site, so a fee note reaching it would be sent to the user's
      // counterparty. Consistent with `extractFullNote` and `completeSwapTransaction`.
      const { userNotes: outputNotes } = splitLandedOutputNotes(result, transaction.id);

      // Every private note this transaction produced, with the id it is owed under. Collected
      // first so the relays are a flat sequence: the commit wait then happens ONCE,
      // after them, rather than once per note inside the loop.
      const notesToRelay: { noteId: string; fullNote: Note }[] = [];

      // How many of this transaction's private notes cannot be shown to have reached
      // the transport. Counted across BOTH phases - conversion and relay - because a
      // note that could not even be turned into a relayable note is as undelivered as
      // one whose relay was rejected, and dropping either with only a console line is
      // how a note goes missing without a trace.
      //
      // A count rather than a flag so the row can say how many, which is the difference
      // between a user knowing one note of several is stuck and assuming the whole
      // transaction failed.
      let undeliveredNotes = 0;
      // Every private note, relayable or not, since `noteDelivery` and the label cover them all.
      const relayNoteIds: string[] = [];
      // Read before `interpretTransactionResult`, which puts the input note's sender in `secondaryAccountId` on a consume.
      const relayRecipientId = transaction.secondaryAccountId;
      // Owed notes no relay can ever carry.
      const relayDeadNoteIds: string[] = [];

      for (const note of outputNotes) {
        // Only care about private notes
        if (toNoteTypeString(note.metadata().noteType()) !== NoteTypeEnum.Private) {
          continue;
        }
        const noteId = note.id().toString();
        relayNoteIds.push(noteId);

        if (!transaction.secondaryAccountId) {
          // The recipient is supplied by the requesting site and is optional, so a
          // custom request that emits a private note without naming one lands here.
          // The row then has no recipient, which leaves it inert for the delivery
          // sweep: there is no one to re-push its notes to.
          console.error('Missing recipient account id for private note', { txId: transaction.id });
          undeliveredNotes++;
          continue;
        }

        // intoFull() can throw or return undefined. Either way the note is recorded dead:
        // the sweep re-pushes by id from the same output note record, and a note that
        // yields no relayable note here yields none there, so pushing it would only
        // spend attempts.
        try {
          const maybeFullNote = note.intoFull();
          if (!maybeFullNote) {
            console.error('intoFull() returned undefined for output note', { txId: transaction.id });
            undeliveredNotes++;
            relayDeadNoteIds.push(noteId);
            continue;
          }
          notesToRelay.push({ noteId, fullNote: maybeFullNote });
        } catch (error) {
          // No lock sees this trap: the read runs after the submit, outside any hold.
          retireLandedTrap(error, transaction.id, result);
          console.error('Failed to convert output note into full note', { txId: transaction.id, error });
          undeliveredNotes++;
          relayDeadNoteIds.push(noteId);
          continue;
        }
      }

      // Read before the commit wait and the relays, any of which can replace the client; the writes use these values,
      // and read the handle themselves only where a read failed here. Interpreted on a copy: the interpretation writes
      // into the row it is given, and on a consume-shaped result names the sender as `secondaryAccountId`, which the
      // relays still read as the recipient.
      const landed = readLandedResultFields(result, transaction.id);
      let interpreted: ReturnType<typeof interpretTransactionResult> | undefined;
      try {
        interpreted = interpretTransactionResult({ ...transaction }, result);
      } catch (error) {
        // Interpreted again at the terminal write, where its failure has always surfaced.
        retireLandedTrap(error, transaction.id, result);
      }
      return {
        executedTx,
        notesToRelay,
        relayNoteIds,
        relayDeadNoteIds,
        undeliveredNotes,
        relayRecipientId,
        landed,
        interpreted
      };
    },
    transaction.id,
    result
  );

const readConsumeResult = (result: TransactionResult, landing: string) => {
  const executedTransaction = result.executedTransaction();
  const inputNotes = executedTransaction.inputNotes().notes();
  const firstInputNote = inputNotes[0];
  if (!firstInputNote) {
    throw refusedCompletion('completeConsumeTransaction: no input notes on executed transaction', 'no_input_notes');
  }
  const note = firstInputNote.note();
  const sender = getBech32AddressFromAccountId(note.metadata().sender());
  const asset = note.assets().fungibleAssets()[0];
  if (!asset) {
    throw refusedCompletion('completeConsumeTransaction: note has no fungible assets', 'no_fungible_assets');
  }
  const faucetId = getBech32AddressFromAccountId(asset.faucetId());
  // Per-faucet totals over EVERY asset of EVERY consumed note. The queue-time
  // value the `ConsumeTransaction` constructor wrote is only an estimate (its
  // `ConsumableNote` inputs carry just the first fungible asset per note), so a
  // completed row recomputes it here against the executed transaction and stays
  // consistent with `amount` (which is this list's `faucetId` entry).
  const totalsByFaucet = new Map<string, bigint>();
  for (const inputNote of inputNotes) {
    for (const noteAsset of inputNote.note().assets().fungibleAssets()) {
      const assetFaucetId = getBech32AddressFromAccountId(noteAsset.faucetId());
      totalsByFaucet.set(assetFaucetId, (totalsByFaucet.get(assetFaucetId) ?? 0n) + noteAsset.amount());
    }
  }
  const assetTotals: IConsumedAssetTotal[] = Array.from(totalsByFaucet, ([id, total]) => ({
    faucetId: id,
    amount: total
  }));
  // Only a uniform batch has a single answer, matching the constructor's rule;
  // otherwise the details card would label a mixed claim by its first note alone.
  const noteTypes = inputNotes.map(inputNote => toNoteTypeString(inputNote.note().metadata().noteType()));
  const firstNoteType = noteTypes[0];
  return {
    inputNotes,
    sender,
    transactionId: executedTransaction.id().toHex(),
    faucetId,
    assetTotals,
    amount: totalsByFaucet.get(faucetId) ?? 0n,
    uniformNoteType: noteTypes.every(type => type === firstNoteType) ? firstNoteType : undefined,
    fees: feeFieldsFromResult(result, landing)
  };
};

function refusedCompletion(message: string, completionGuard: CompletionGuard): Error {
  const error = new Error(message);
  annotateCrash(error, { completionStep: 'result_read', completionGuard });
  return error;
}

const readConsume = (landing: string, result: TransactionResult): ConsumeRead => {
  const read = readOnce(() => readConsumeResult(result, landing), landing, result);
  if ('error' in read) return read;
  const { inputNotes, ...fields } = read.value;
  const bytes = readOnce(() => result.serialize(), landing, result);
  if ('error' in bytes) return { value: { ...fields, bytes } };
  // Each executed note goes over by its own first asset: the per-faucet totals are no single delivery's amount.
  const deliveries = readOnce(
    () =>
      inputNotes.map(inputNote => {
        const executed = inputNote.note();
        const noteAsset = executed.assets().fungibleAssets()[0];
        // A note with no fungible asset can only be a registry delivery, which pairs by id alone.
        if (!noteAsset) return { id: executed.id().toString(), senderAddress: '', faucetId: '' };
        return {
          id: executed.id().toString(),
          senderAddress: getBech32AddressFromAccountId(executed.metadata().sender()),
          faucetId: getBech32AddressFromAccountId(noteAsset.faucetId()),
          amount: noteAsset.amount()
        };
      }),
    landing,
    result
  );
  return { value: { ...fields, bytes: { value: { resultBytes: bytes.value, deliveries } } } };
};

const readSwap = (tx: SwapTransaction, result: TransactionResult): LandedRead<SwapRead> =>
  readOnce(
    () => {
      const executedTx = result.executedTransaction();
      // The kernel's fee note is an output note of this transaction too. The order is the unique public
      // note whose recipient script is the PSWAP script, so an unset-aside fee note is not the order.
      const split = splitLandedOutputNotes(result, tx.id);
      if (split.userNotes.length === 0) {
        throw new Error('Swap Transaction Failed');
      }
      const fromResult = swapOrderOf(split);
      // Read before the decode the completion may wait for: it waits on the WASM lock and can retire the client, so
      // the write stores the values read here, not reads of a result whose handles may no longer answer.
      const feeFields = feeFieldsFromResult(result, tx.id);
      const transactionId = executedTx.id().toHex();
      const resultBytes = result.serialize();
      return { fromResult, feeFields, transactionId, resultBytes };
    },
    tx.id,
    result
  );

const readBridgedSend = (tx: BridgedSendTransaction, result: TransactionResult): LandedRead<NoteRowRead> =>
  readOnce(
    () => {
      const executedTx = result.executedTransaction();
      // Network-note sponsorship adds another output. The persisted burn id identifies
      // the user's note regardless of where the SDK puts the sponsorship/fee outputs.
      const burnId = tx.extraInputs?.usdcxBurn?.noteId;
      const noteId = burnId ?? extractFullNote(result, tx.id)?.id().toString();
      return {
        outputNoteIds: noteId ? [noteId] : [],
        feeFields: feeFieldsFromResult(result, tx.id, tx),
        transactionId: executedTx.id().toHex(),
        resultBytes: result.serialize()
      };
    },
    tx.id,
    result
  );

const readEarnDeposit = (tx: EarnDepositTransaction, result: TransactionResult): LandedRead<NoteRowRead> =>
  readOnce(
    () => {
      const executedTx = result.executedTransaction();
      const noteId = extractFullNote(result, tx.id)?.id().toString();
      return {
        outputNoteIds: noteId ? [noteId] : [],
        feeFields: feeFieldsFromResult(result, tx.id),
        transactionId: executedTx.id().toHex(),
        resultBytes: result.serialize()
      };
    },
    tx.id,
    result
  );

// The read a landed tail made, keyed by its result. Only the tail writes an entry, and it removes it when it ends, so a
// later completion of the same result reads afresh.
const tailReads = new WeakMap<TransactionResult, LandedCompletion>();

/**
 * Read now what the value completion of `transaction` reads off `result`, in that completion's own order, and keep it
 * for that completion until `forgetLandedCompletion`. Dispatches as the completion switches do. Never throws.
 */
export function readLandedCompletion(transaction: ITransaction, result: TransactionResult): LandedCompletion {
  const landing = transaction.id;
  let completion: LandedCompletion;
  switch (transaction.type) {
    case 'send':
      completion = { arm: 'send', landing, read: readSend(transaction as SendTransaction, result) };
      break;
    case 'consume':
      completion = { arm: 'consume', landing, read: readConsume(landing, result) };
      break;
    case 'swap':
      completion = { arm: 'swap', landing, read: readSwap(transaction as SwapTransaction, result) };
      break;
    case 'bridged-send':
      completion = {
        arm: 'bridged-send',
        landing,
        read: readBridgedSend(transaction as BridgedSendTransaction, result)
      };
      break;
    case 'earn-deposit':
      completion = {
        arm: 'earn-deposit',
        landing,
        read: readEarnDeposit(transaction as EarnDepositTransaction, result)
      };
      break;
    default:
      completion = { arm: 'custom', landing, read: readCustom(transaction, result) };
  }
  tailReads.set(result, completion);
  return completion;
}

export function forgetLandedCompletion(result: TransactionResult): void {
  tailReads.delete(result);
}

/** The tail's read of `result` when it was made for this arm and row, else undefined. */
const tailRead = <A extends keyof ReadOf>(
  arm: A,
  landing: string,
  result: TransactionResult
): ReadOf[A] | undefined => {
  const kept = tailReads.get(result);
  return kept !== undefined && kept.arm === arm && kept.landing === landing ? (kept.read as ReadOf[A]) : undefined;
};

// Each answers from the tail's read of this row, else reads now without keeping it.
export const sendCompletionRead = (tx: SendTransaction, result: TransactionResult): LandedRead<SendRead> =>
  tailRead('send', tx.id, result) ?? readSend(tx, result);

export const customCompletionRead = (transaction: ITransaction, result: TransactionResult): LandedRead<CustomRead> =>
  tailRead('custom', transaction.id, result) ?? readCustom(transaction, result);

export const consumeCompletionRead = (id: string, result: TransactionResult): ConsumeRead =>
  tailRead('consume', id, result) ?? readConsume(id, result);

export const swapCompletionRead = (tx: SwapTransaction, result: TransactionResult): LandedRead<SwapRead> =>
  tailRead('swap', tx.id, result) ?? readSwap(tx, result);

export const bridgedSendCompletionRead = (
  tx: BridgedSendTransaction,
  result: TransactionResult
): LandedRead<NoteRowRead> => tailRead('bridged-send', tx.id, result) ?? readBridgedSend(tx, result);

export const earnDepositCompletionRead = (
  tx: EarnDepositTransaction,
  result: TransactionResult
): LandedRead<NoteRowRead> => tailRead('earn-deposit', tx.id, result) ?? readEarnDeposit(tx, result);

/** The kept value, or the kept error rethrown as the same object. */
export function keptOrThrow<T>(read: LandedRead<T>): T {
  if ('error' in read) throw read.error;
  return read.value;
}

/** The id and swap order a tail's read kept, for its failure; a swap whose result named no order keeps none. */
export function keptLandingFacts(completion: LandedCompletion | undefined): {
  transactionId?: string;
  order?: { orderId?: string; orderNoteId?: string };
} {
  if (completion === undefined) return {};
  switch (completion.arm) {
    case 'send':
    case 'custom':
      return 'value' in completion.read ? { transactionId: keptValue(completion.read.value.landed.transactionId) } : {};
    case 'swap':
      return 'value' in completion.read
        ? { transactionId: completion.read.value.transactionId, order: completion.read.value.fromResult ?? {} }
        : {};
    default:
      return 'value' in completion.read ? { transactionId: completion.read.value.transactionId } : {};
  }
}
