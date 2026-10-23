import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import { noteIdKey } from 'lib/miden/activity/bridge-in';
import { ITransactionStatus, type IOneClickTrackingData, type ITransaction } from 'lib/miden/db/types';
import type { ConsumableNoteDto } from 'lib/miden/sdk/consumable-notes';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { normalizedFaucetId } from 'lib/miden/swap/faucet-ids';

export function oneClickDestinationFaucet(tracking: IOneClickTrackingData): string | undefined {
  return tracking.config.midenAssets.find(asset => asset.assetId === tracking.destinationAsset.assetId)?.faucetId;
}

export function oneClickActualOutputAmount(
  tracking: IOneClickTrackingData,
  amountOut: string | undefined
): bigint | undefined {
  if (!amountOut || !/^[0-9]{1,78}$/.test(amountOut) || !/^[0-9]{1,78}$/.test(tracking.quote.quote.minAmountOut))
    return undefined;
  const actual = BigInt(amountOut);
  return actual > 0n && actual >= BigInt(tracking.quote.quote.minAmountOut) ? actual : undefined;
}

export function hasOneClickDeliveryArrived({
  targetAccountId,
  faucetId,
  amount,
  noteIds,
  consumableNotes,
  transactions
}: {
  targetAccountId: string;
  faucetId: string;
  amount: bigint;
  noteIds: readonly string[];
  consumableNotes: readonly ConsumableNoteDto[];
  transactions: readonly ITransaction[];
}): boolean {
  const expectedIds = new Set(noteIds.map(noteIdKey));
  if (expectedIds.size === 0) return false;
  const expectedFaucetId = normalizedFaucetId(faucetId);
  const amountsByNoteId = new Map<string, bigint>();

  for (const note of consumableNotes) {
    if (!note.noteId || note.state !== InputNoteState.Committed) continue;
    const noteId = noteIdKey(note.noteId);
    if (!expectedIds.has(noteId)) continue;
    const amountForFaucet = note.assets
      .filter(asset => normalizedFaucetId(asset.faucetId) === expectedFaucetId)
      .reduce((total, asset) => total + BigInt(asset.amount), 0n);
    if (amountForFaucet > 0n) amountsByNoteId.set(noteId, amountForFaucet);
  }

  for (const transaction of transactions) {
    if (
      transaction.type !== 'consume' ||
      transaction.status !== ITransactionStatus.Completed ||
      !sameWalletAccountId(transaction.accountId, targetAccountId) ||
      transaction.restoredFromBackup === true
    ) {
      continue;
    }
    for (const note of transaction.consumedNotes ?? []) {
      const noteId = noteIdKey(note.id);
      if (
        !expectedIds.has(noteId) ||
        normalizedFaucetId(note.faucetId) !== expectedFaucetId ||
        note.amount === undefined
      ) {
        continue;
      }
      if (!amountsByNoteId.has(noteId)) amountsByNoteId.set(noteId, note.amount);
    }
  }

  return [...amountsByNoteId.values()].reduce((total, noteAmount) => total + noteAmount, 0n) === amount;
}
