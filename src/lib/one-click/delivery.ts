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

/**
 * The delivery check for a deposit whose note ids are not known (no receipt service names them). It finds a note
 * for the account that carries exactly the delivered amount of the destination token: one that waits for a claim,
 * or one that a completed consume claimed after the deposit started. A match sets only the label of the row; it
 * moves no funds. Another transfer of the same token and the same exact amount gives the same answer.
 */
export function hasOneClickDeliveryArrivedByAmount({
  targetAccountId,
  faucetId,
  amount,
  since,
  consumableNotes,
  transactions
}: {
  targetAccountId: string;
  faucetId: string;
  amount: bigint;
  /** The time the deposit row started, in the unit of `ITransaction.initiatedAt`. */
  since: number;
  consumableNotes: readonly ConsumableNoteDto[];
  transactions: readonly ITransaction[];
}): boolean {
  const expectedFaucetId = normalizedFaucetId(faucetId);
  const waiting = consumableNotes.some(note => {
    if (note.state !== InputNoteState.Committed) return false;
    const amountForFaucet = note.assets
      .filter(asset => normalizedFaucetId(asset.faucetId) === expectedFaucetId)
      .reduce((total, asset) => total + BigInt(asset.amount), 0n);
    return amountForFaucet === amount;
  });
  if (waiting) return true;
  return transactions.some(
    transaction =>
      transaction.type === 'consume' &&
      transaction.status === ITransactionStatus.Completed &&
      transaction.restoredFromBackup !== true &&
      transaction.initiatedAt >= since &&
      sameWalletAccountId(transaction.accountId, targetAccountId) &&
      (transaction.consumedNotes ?? []).some(
        note => normalizedFaucetId(note.faucetId) === expectedFaucetId && note.amount === amount
      )
  );
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
