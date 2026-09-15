import { AccountId, Note, NoteScript, NoteType, TransactionResult, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';
import { z } from 'zod';

import { splitExecutedOutputNotes } from 'lib/miden/activity/fee-notes';
import { b64ToU8 } from 'lib/shared/helpers';

import { getBech32AddressFromAccountId } from './helpers';

const assetSchema = z.object({ faucetId: z.string(), amount: z.string().regex(/^\d+$/) });
const noteSchema = z.object({
  id: z.string(),
  assets: z.array(assetSchema),
  sender: z.string().optional(),
  recipient: z.string().optional(),
  visibility: z.enum(['public', 'private']),
  reclaimHeight: z.number().optional()
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

function fullNote(note: Note): GuardianHistoryNote {
  return {
    id: note.id().toString(),
    assets: note.assets().fungibleAssets().map(asset => ({
      faucetId: getBech32AddressFromAccountId(asset.faucetId()), amount: asset.amount().toString()
    })),
    sender: getBech32AddressFromAccountId(note.metadata().sender()),
    visibility: note.metadata().noteType() === NoteType.Public ? 'public' : 'private',
    ...paymentDetails(note)
  };
}

// Call only while the SDK lock is held in the client realm.
export function decodeGuardianSummary(encoded: string): GuardianSummary {
  if (encoded.length > 4_000_000) throw new Error('Guardian summary is too large');
  const summary = TransactionSummary.deserialize(b64ToU8(encoded));
  try {
    const { feeNote, userNotes } = splitExecutedOutputNotes(summary);
    const feeAsset = feeNote?.assets()?.fungibleAssets()[0];
    return {
      accountId: summary.accountDelta().id().toString(),
      inputNotes: summary.inputNotes().notes().map(input => fullNote(input.note())),
      outputNotes: userNotes.map(output => {
        const full = output.intoFull();
        if (full) return fullNote(full);
        return {
          id: output.id().toString(),
          assets: (output.assets()?.fungibleAssets() ?? []).map(asset => ({
            faucetId: getBech32AddressFromAccountId(asset.faucetId()), amount: asset.amount().toString()
          })),
          sender: getBech32AddressFromAccountId(output.metadata().sender()),
          visibility: output.metadata().noteType() === NoteType.Public ? 'public' : 'private'
        };
      }),
      fee: feeAsset ? {
        faucetId: getBech32AddressFromAccountId(feeAsset.faucetId()), amount: feeAsset.amount().toString()
      } : undefined
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
