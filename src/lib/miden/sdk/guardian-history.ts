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
import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';
import { b64ToU8 } from 'lib/shared/helpers';

import { getBech32AddressFromAccountId } from './helpers';
import { GuardianHistoryFeeUnavailableError } from '../guardian/history-errors';

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
export async function decodeGuardianSummary(encoded: string): Promise<GuardianSummary> {
  if (encoded.length > 4_000_000) throw new Error('Guardian summary is too large');
  // Load fee metadata in the same realm that separates the output notes.
  try {
    await getNativeAssetId();
    if ((await getVerificationBaseFee()) === null) throw new GuardianHistoryFeeUnavailableError();
  } catch {
    throw new GuardianHistoryFeeUnavailableError();
  }
  const summary = TransactionSummary.deserialize(b64ToU8(encoded));
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
  } finally {
    summary.free();
  }
}

export function guardianResultCommitment(bytes: Uint8Array): string {
  const result = TransactionResult.deserialize(bytes);
  try {
    return result.executedTransaction().finalAccountHeader().to_commitment().toHex();
  } finally {
    result.free();
  }
}
