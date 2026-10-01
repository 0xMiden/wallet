import {
  AccountId,
  Note,
  NoteScript,
  NoteType,
  TransactionResult,
  TransactionSummary
} from '@miden-sdk/miden-sdk/lazy';
import { z } from 'zod';

import { splitExecutedOutputNotes } from 'lib/miden/activity/fee-notes';
import {
  getNativeAssetId,
  getVerificationBaseFee,
  isVerificationBaseFeeKnownAbsent
} from 'lib/miden-chain/native-asset';
import { b64ToU8 } from 'lib/shared/helpers';

import { getBech32AddressFromAccountId } from './helpers';
import { retireWasmClientForCaughtTrap, type WasmLockHold } from './miden-client';
import { isWasmClientPoisonedError } from './wasm-client-poison';
import {
  GuardianHistoryDataError,
  GuardianHistoryFeeLookupError,
  GuardianHistoryFeeUnavailableError
} from '../guardian/history-errors';

const assetSchema = z.object({ faucetId: z.string(), amount: z.string().regex(/^\d+$/) });
const noteSchema = z.object({
  id: z.string(),
  assets: z.array(assetSchema),
  sender: z.string().optional(),
  recipient: z.string().optional(),
  visibility: z.enum(['public', 'private']),
  reclaimHeight: z.number().optional(),
  swap: z
    .object({
      orderId: z.string(),
      requestedAsset: assetSchema.optional()
    })
    .optional()
});
export const guardianSummarySchema = z.object({
  accountId: z.string(),
  inputNotes: z.array(noteSchema),
  outputNotes: z.array(noteSchema),
  fee: assetSchema.optional()
});
export type GuardianSummary = z.infer<typeof guardianSummarySchema>;
export type GuardianHistoryNote = z.infer<typeof noteSchema>;

function paymentDetails(note: Note): Pick<GuardianHistoryNote, 'recipient' | 'reclaimHeight'> {
  const recipient = note.recipient();
  const items = recipient.storage().items();
  const root = recipient.script().root().toHex();
  let offset: number;
  switch (root) {
    case NoteScript.p2id().root().toHex():
      if (items.length !== 2) return {};
      offset = 0;
      break;
    case NoteScript.p2ide().root().toHex():
      if (items.length !== 6) return {};
      offset = 2;
      break;
    default:
      return {};
  }
  const suffix = items[offset];
  const prefix = items[offset + 1];
  if (!prefix || !suffix) return {};
  return {
    recipient: getBech32AddressFromAccountId(AccountId.fromPrefixSuffix(prefix, suffix)),
    reclaimHeight: offset === 2 ? Number(items[4]?.asInt() ?? 0n) : undefined
  };
}

function swapDetails(note: Note): GuardianHistoryNote['swap'] {
  const recipient = note.recipient();
  if (recipient.script().root().toHex() === NoteScript.pswap().root().toHex()) {
    const items = recipient.storage().items();
    const suffix = items[0];
    const prefix = items[1];
    const amount = items[2];
    const orderId = recipient.serialNum().toFelts()[1];
    if (items.length !== 7 || !suffix || !prefix || !amount || !orderId) return undefined;
    return {
      orderId: orderId.asInt().toString(),
      requestedAsset: {
        faucetId: getBech32AddressFromAccountId(AccountId.fromPrefixSuffix(prefix, suffix)),
        amount: amount.asInt().toString()
      }
    };
  }
  if (recipient.script().root().toHex() !== NoteScript.p2id().root().toHex()) return undefined;
  const serialOrderId = recipient.serialNum().toFelts()[1]?.asInt();
  // Payback notes carry the same order ID in the serial number and attachment.
  for (const attachment of note.attachments()) {
    for (const word of attachment.toWords()) {
      const values = word.toU64s();
      const orderId = values[1];
      if (
        values.length === 4 &&
        values[3] === 0n &&
        orderId !== undefined &&
        orderId === serialOrderId &&
        values.some(value => value !== 0n)
      ) {
        return { orderId: orderId.toString() };
      }
    }
  }
  return undefined;
}

function retiredOnTrap(cause: unknown, hold: WasmLockHold): boolean {
  const trapped = cause instanceof WebAssembly.RuntimeError;
  if (trapped) retireWasmClientForCaughtTrap(hold, cause);
  return trapped;
}

// An eviction is a fault of the module, not a verdict on the operator's bytes, so it passes through. A trap on those
// bytes is the operator's: the decoding hold caught it, so no realm listener sees it and the hold retires the client
// the trap aborted before the bytes are charged like any other failure.
function summaryDataError(message: string, cause: unknown, hold: WasmLockHold): unknown {
  if (isWasmClientPoisonedError(cause)) return cause;
  retiredOnTrap(cause, hold);
  return new GuardianHistoryDataError(message, { cause });
}

function fullNote(note: Note): GuardianHistoryNote {
  return {
    id: note.id().toString(),
    assets: note
      .assets()
      .fungibleAssets()
      .map(asset => ({
        faucetId: getBech32AddressFromAccountId(asset.faucetId()),
        amount: asset.amount().toString()
      })),
    sender: getBech32AddressFromAccountId(note.metadata().sender()),
    visibility: note.metadata().noteType() === NoteType.Public ? 'public' : 'private',
    ...paymentDetails(note),
    swap: swapDetails(note)
  };
}

// Call only while the SDK lock is held in the client realm.
export async function decodeGuardianSummary(encoded: string, hold: WasmLockHold): Promise<GuardianSummary> {
  // Every realm's dispatch reaches this with whatever it was handed, so the contract does not rest on the caller's check.
  if (typeof encoded !== 'string' || encoded.length === 0)
    throw new GuardianHistoryDataError('Guardian summary is missing');
  if (encoded.length > 4_000_000) throw new GuardianHistoryDataError('Guardian summary is too large');
  // Load fee metadata in the same realm that separates the output notes. A failed lookup is the wallet's node, not the
  // operator; a trap or an eviction passes through so the lock holding this decode retires the client.
  let fee: number | null;
  try {
    await getNativeAssetId();
    fee = await getVerificationBaseFee();
  } catch (cause) {
    if (cause instanceof WebAssembly.RuntimeError || isWasmClientPoisonedError(cause)) throw cause;
    throw new GuardianHistoryFeeLookupError({ cause });
  }
  if (fee === null) {
    // Only the chain's own answer is terminal; a failed lookup is retried with the other sources.
    if (isVerificationBaseFeeKnownAbsent()) throw new GuardianHistoryFeeUnavailableError();
    throw new GuardianHistoryFeeLookupError();
  }
  let summary: TransactionSummary;
  try {
    summary = TransactionSummary.deserialize(b64ToU8(encoded));
  } catch (cause) {
    throw summaryDataError('Guardian summary does not deserialize', cause, hold);
  }
  // The summary lives in the instance a trap aborted, so a trapped walk does not free it.
  let trapped = false;
  try {
    const { feeNote, userNotes } = splitExecutedOutputNotes(summary);
    const feeAsset = feeNote?.assets()?.fungibleAssets()[0];
    return {
      accountId: summary.accountDelta().id().toString(),
      inputNotes: summary
        .inputNotes()
        .notes()
        .map(input => fullNote(input.note())),
      outputNotes: userNotes.map(output => {
        const full = output.intoFull();
        if (full) return fullNote(full);
        return {
          id: output.id().toString(),
          assets: (output.assets()?.fungibleAssets() ?? []).map(asset => ({
            faucetId: getBech32AddressFromAccountId(asset.faucetId()),
            amount: asset.amount().toString()
          })),
          sender: getBech32AddressFromAccountId(output.metadata().sender()),
          visibility: output.metadata().noteType() === NoteType.Public ? 'public' : 'private'
        };
      }),
      fee: feeAsset
        ? {
            faucetId: getBech32AddressFromAccountId(feeAsset.faucetId()),
            amount: feeAsset.amount().toString()
          }
        : undefined
    };
  } catch (cause) {
    trapped = cause instanceof WebAssembly.RuntimeError;
    throw summaryDataError('Guardian summary notes do not decode', cause, hold);
  } finally {
    if (!trapped) summary.free();
  }
}

// Every failure passes through for the pass to file; a trap retires the client first.
export function guardianResultCommitment(bytes: Uint8Array, hold: WasmLockHold): string {
  let result: TransactionResult;
  try {
    result = TransactionResult.deserialize(bytes);
  } catch (cause) {
    retiredOnTrap(cause, hold);
    throw cause;
  }
  let trapped = false;
  try {
    return result.executedTransaction().finalAccountHeader().to_commitment().toHex();
  } catch (cause) {
    trapped = retiredOnTrap(cause, hold);
    throw cause;
  } finally {
    if (!trapped) result.free();
  }
}
